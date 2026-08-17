import { Router, type Request, type Response } from 'express'
import { prisma } from './db'
import { authMiddleware } from './auth'
import { streamBuild, extractSummary, runEditModel, runInlineEditModel, runCompletionModel } from './ai'
import { PREFIX_BUDGET, SUFFIX_BUDGET, sanitizeCompletion } from './completion'
import {
  applyEditsToFiles,
  describeEdits,
  normalizePath,
  numberWorkspace,
  parseEditOps,
  parseInlineReplacement,
  parseWorkspace,
  prepareEdits,
  serializeWorkspace,
  type LineEdit,
} from './edits'
import { makeSlug, publicUrl } from './publish'
import { lookupBuild, storeBuild } from './cache'
import { parseImage, visionCapability, type ImageAttachment } from './vision'
import { asRuntime, runtimeLabel, type Runtime } from './runtime'
import { copyDocInto, freshForkState, readLiveDoc, seedForkVersion } from './fork'
import {
  createProjectMemory,
  deleteProjectMemory,
  formatMemoriesForAI,
  listProjectMemories,
  retrieveRelevantMemories,
  updateProjectMemory,
} from './memory'

export const projectsRouter = Router()

// Every project route requires a signed-in user.
projectsRouter.use(authMiddleware)

const uid = (req: Request) => (req as any).userId as string

async function membership(projectId: string, userId: string) {
  return prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  })
}

// List the projects this user can open (most recently updated first).
projectsRouter.get('/', async (req, res) => {
  const memberships = await prisma.projectMember.findMany({
    where: { userId: uid(req) },
    include: { project: true },
    orderBy: { project: { updatedAt: 'desc' } },
  })
  res.json({
    projects: memberships.map((m) => ({
      id: m.project.id,
      name: m.project.name,
      ownerId: m.project.ownerId,
      role: m.role,
      runtime: asRuntime(m.project.runtime),
      isTemplate: m.project.isTemplate,
      description: m.project.description,
      forkCount: m.project.forkCount,
      forkedFromName: m.project.forkedFromName,
      updatedAt: m.project.updatedAt,
    })),
  })
})

// Create a project and make the creator its owner. The runtime is fixed at
// creation because it decides the entry file, and switching it later on a
// project that already has code would leave that code stranded — see PATCH.
projectsRouter.post('/', async (req, res) => {
  const name = (req.body?.name ?? 'Untitled project').toString().trim().slice(0, 80) || 'Untitled project'
  const runtime = asRuntime(req.body?.runtime)
  const project = await prisma.project.create({
    data: { name, runtime, ownerId: uid(req), members: { create: { userId: uid(req), role: 'owner' } } },
  })
  res.json({ project: { id: project.id, name: project.name, ownerId: project.ownerId, runtime } })
})

// Project detail, including who is in the room.
projectsRouter.get('/:id', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: { members: { include: { user: true } } },
  })
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  res.json({
    project: {
      id: project.id,
      name: project.name,
      ownerId: project.ownerId,
      runtime: asRuntime(project.runtime),
      isTemplate: project.isTemplate,
      description: project.description,
      forkCount: project.forkCount,
      forkedFromId: project.forkedFromId,
      forkedFromName: project.forkedFromName,
      members: project.members.map((mm) => ({
        id: mm.user.id,
        name: mm.user.name,
        color: mm.user.color,
        role: mm.role,
      })),
    },
  })
})

// Update a project. Renaming is open to any member; offering the project as a
// template is not, for the same reason inviting and publishing are not — it
// hands access to people who don't have it.
projectsRouter.patch('/:id', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })
  const project = await prisma.project.findUnique({ where: { id: req.params.id } })
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  const isOwner = project.ownerId === uid(req)

  const data: { name?: string; isTemplate?: boolean; description?: string | null } = {}

  if (req.body?.name !== undefined) {
    const name = req.body.name.toString().trim().slice(0, 80)
    if (!name) return res.status(400).json({ error: 'Enter a project name.' })
    data.name = name
  }

  if (req.body?.isTemplate !== undefined) {
    if (!isOwner) return res.status(403).json({ error: 'Only the owner can offer this project as a template.' })
    data.isTemplate = req.body.isTemplate === true
  }

  if (req.body?.description !== undefined) {
    if (!isOwner) return res.status(403).json({ error: 'Only the owner can describe this project.' })
    const description = req.body.description === null ? '' : req.body.description.toString().trim().slice(0, 200)
    data.description = description || null
  }

  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nothing to update.' })

  const updated = await prisma.project.update({ where: { id: req.params.id }, data })
  // Keep the public page's title in step; a no-op when nothing is published.
  if (data.name) {
    await prisma.publication.updateMany({ where: { projectId: req.params.id }, data: { title: data.name } })
  }
  res.json({
    ok: true,
    project: {
      id: updated.id,
      name: updated.name,
      isTemplate: updated.isTemplate,
      description: updated.description,
      runtime: asRuntime(updated.runtime),
    },
  })
})

// ── Forking ─────────────────────────────────────────────────────────
//
// Who may fork what:
//   · a template   — anyone signed in. That is what marking it a template means.
//   · anything else — its members only. A project you can open is a project you
//                     can take a copy of; one you cannot open stays invisible,
//                     and this route must not become a way to discover that a
//                     given project id exists.
//
// Hence the single 404 for both "no such project" and "not yours to fork": the
// error tells an unauthorised caller nothing it did not already know.
projectsRouter.post('/:id/fork', async (req, res) => {
  const userId = uid(req)
  const source = await prisma.project.findUnique({ where: { id: req.params.id } })
  if (!source) return res.status(404).json({ error: 'Project not found.' })

  if (!source.isTemplate) {
    const m = await membership(source.id, userId)
    if (!m) return res.status(404).json({ error: 'Project not found.' })
  }

  const runtime = asRuntime(source.runtime)
  const name =
    (req.body?.name ?? '').toString().trim().slice(0, 80) ||
    `${source.name} (copy)`.slice(0, 80)

  // Read the live document *before* creating anything, so a failure here leaves
  // no empty project behind.
  let state: Uint8Array | null
  try {
    state = await readLiveDoc(source.id)
  } catch {
    return res.status(502).json({ error: 'Could not read that project to copy it. Try again in a moment.' })
  }
  if (!state) {
    return res.status(400).json({ error: 'That project has no code in it yet — there is nothing to fork.' })
  }

  const forked = freshForkState(state)

  const project = await prisma.project.create({
    data: {
      name,
      runtime,
      ownerId: userId,
      description: source.isTemplate ? source.description : null,
      forkedFromId: source.id,
      forkedFromName: source.name,
      members: { create: { userId, role: 'owner' } },
    },
  })

  try {
    await copyDocInto(project.id, forked)
    await seedForkVersion(project.id, forked, runtime, source.name)
  } catch (err) {
    // A project whose document never landed is a broken room: it would open,
    // sync an empty doc, and quietly present itself as a fork that copied
    // nothing. Removing it is the honest outcome.
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {})
    return res.status(500).json({ error: 'Could not copy that project. Nothing was created.' })
  }

  // Advisory: a counter must never fail the fork it is counting.
  prisma.project.update({ where: { id: source.id }, data: { forkCount: { increment: 1 } } }).catch(() => {})

  res.json({
    project: {
      id: project.id,
      name: project.name,
      ownerId: project.ownerId,
      runtime,
      forkedFromName: source.name,
    },
  })
})

// Invite an existing Lumen account into the project by email (owner only).
projectsRouter.post('/:id/invite', async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id } })
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  if (project.ownerId !== uid(req)) return res.status(403).json({ error: 'Only the owner can invite people.' })

  const email = (req.body?.email ?? '').toString().toLowerCase().trim()
  const invitee = await prisma.user.findUnique({ where: { email } })
  if (!invitee) return res.status(404).json({ error: 'No Lumen account uses that email yet.' })

  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: project.id, userId: invitee.id } },
    create: { projectId: project.id, userId: invitee.id, role: 'editor' },
    update: {},
  })
  res.json({ ok: true, member: { id: invitee.id, name: invitee.name, color: invitee.color } })
})

// ── Publishing: a read-only public link for people with no Lumen account. ──
// Publishing exposes the project to everyone who has the link, so it follows the
// same rule as inviting a person: owner only. What is served is a snapshot taken
// at publish time, not the live document — see publish.ts.

const shapePublication = (
  pub: { slug: string; views: number; listed: boolean; createdAt: Date; updatedAt: Date },
  req: Request
) => ({
  slug: pub.slug,
  url: publicUrl(req, pub.slug),
  views: pub.views,
  listed: pub.listed,
  publishedAt: pub.createdAt,
  updatedAt: pub.updatedAt,
})

// Where the project currently stands. Any member can see the link.
projectsRouter.get('/:id/publish', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })
  const pub = await prisma.publication.findUnique({ where: { projectId: req.params.id } })
  res.json({ publication: pub ? shapePublication(pub, req) : null })
})

// Publish, or refresh an existing publication with the current code.
projectsRouter.post('/:id/publish', async (req: Request, res: Response) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id } })
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  if (project.ownerId !== uid(req)) return res.status(403).json({ error: 'Only the owner can publish this project.' })

  const html = (req.body?.html ?? '').toString()
  if (!html.trim()) return res.status(400).json({ error: 'There is nothing to publish yet — build something first.' })

  // Listing in the public gallery is a separate decision from publishing, and
  // only ever an explicit one: an absent field leaves the existing setting alone
  // rather than quietly un-listing a page on every "Update to current code".
  const listed = req.body?.listed === undefined ? undefined : req.body.listed === true

  const existing = await prisma.publication.findUnique({ where: { projectId: project.id } })
  if (existing) {
    // Re-publishing keeps the slug, so links already shared keep working.
    const updated = await prisma.publication.update({
      where: { id: existing.id },
      data: { html, title: project.name, ...(listed === undefined ? {} : { listed }) },
    })
    return res.json({ publication: shapePublication(updated, req) })
  }

  // Fresh publication. A slug collision is vanishingly unlikely but cheap to retry.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const created = await prisma.publication.create({
        data: {
          projectId: project.id,
          slug: makeSlug(project.name),
          title: project.name,
          html,
          listed: listed === true,
        },
      })
      return res.json({ publication: shapePublication(created, req) })
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err // anything but a uniqueness clash is real
    }
  }
  res.status(500).json({ error: 'Could not allocate a public link. Please try again.' })
})

// Take it down. The link stops resolving immediately.
projectsRouter.delete('/:id/publish', async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id } })
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  if (project.ownerId !== uid(req)) return res.status(403).json({ error: 'Only the owner can unpublish this project.' })
  await prisma.publication.deleteMany({ where: { projectId: project.id } })
  res.json({ ok: true })
})

// ── Project Memory ─────────────────────────────────────────────────────────

// List the active memories associated with this project.
projectsRouter.get('/:id/memory', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })

  const memories = await listProjectMemories(req.params.id)

  res.json({
    memories,
  })
})

// Add a project memory manually.
projectsRouter.post('/:id/memory', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })

  const content = (req.body?.content ?? '').toString().trim()
  if (!content) {
    return res.status(400).json({ error: 'Memory content cannot be empty.' })
  }

  try {
    const memory = await createProjectMemory(req.params.id, {
      type: req.body?.type,
      content,
      importance: req.body?.importance,
      confidence: req.body?.confidence,
    })

    res.status(201).json({ memory })
  } catch (err: any) {
    res.status(400).json({
      error: err?.message || 'Could not create memory.',
    })
  }
})

// Update a project memory.
projectsRouter.patch('/:id/memory/:memoryId', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })

  try {
    const memory = await updateProjectMemory(
      req.params.id,
      req.params.memoryId,
      {
        type: req.body?.type,
        content: req.body?.content,
        importance: req.body?.importance,
        confidence: req.body?.confidence,
        status: req.body?.status,
      },
    )

    if (!memory) {
      return res.status(404).json({ error: 'Memory not found.' })
    }

    res.json({ memory })
  } catch (err: any) {
    res.status(400).json({
      error: err?.message || 'Could not update memory.',
    })
  }
})

// Delete a project memory.
projectsRouter.delete('/:id/memory/:memoryId', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })

  const deleted = await deleteProjectMemory(
    req.params.id,
    req.params.memoryId,
  )

  if (!deleted) {
    return res.status(404).json({ error: 'Memory not found.' })
  }

  res.json({ ok: true })
})

// ── Version history (checkpoints) ───────────────────────────────────
//
// Every successful build, line edit and inline edit already wrote a Version row.
// These routes are what make that history reachable: list it, read one back, and
// restore one.
//
// Restoring is split deliberately between the two sides. The server owns the
// *history* — it records that a restore happened, and to what — while the client
// owns the *document*, because the document is a CRDT with live collaborators in
// it. Writing the workspace from here would mean a second writer racing the room
// and clobbering whatever someone typed in the last second; the client applies
// it through Yjs like any other edit, so the change merges instead of landing on
// top of people.

// Build history. `take` is generous but bounded — a busy project accumulates a
// row per edit, and the panel is a timeline, not an archive.
projectsRouter.get('/:id/versions', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })
  const versions = await prisma.version.findMany({
    where: { projectId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: 80,
    select: { id: true, prompt: true, createdAt: true },
  })
  res.json({ versions })
})

// Fetch the full marker-format workspace of one saved version.
projectsRouter.get('/:id/versions/:versionId', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })
  const version = await prisma.version.findFirst({
    where: { id: req.params.versionId, projectId: req.params.id },
  })
  if (!version) return res.status(404).json({ error: 'Version not found.' })
  res.json({ version })
})

/**
 * Restore a checkpoint.
 *
 * Two writes happen here and the order matters. Before handing back the old
 * workspace, the *current* one is snapshotted as its own version — so pressing
 * Restore is itself undoable. Without that, restoring an hour-old checkpoint
 * would silently discard everything since, which is the one thing a history
 * feature must never do.
 *
 * The current workspace arrives in the request body rather than being read from
 * the document, for the same reason the restore is applied client-side: the
 * client is the one holding the live CRDT, and what it sends is exactly what is
 * about to be replaced.
 */
projectsRouter.post('/:id/versions/:versionId/restore', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })

  const version = await prisma.version.findFirst({
    where: { id: req.params.versionId, projectId: req.params.id },
  })
  if (!version) return res.status(404).json({ error: 'That checkpoint no longer exists.' })

  const currentCode = (req.body?.currentCode ?? '').toString()
  const label = (req.body?.label ?? '').toString().trim().slice(0, 120)

  // Snapshot what is about to be lost. A project with nothing in it yet has
  // nothing to preserve, so an empty body is a legitimate no-op rather than an
  // error — restoring into a fresh fork is a normal thing to do.
  if (currentCode.trim()) {
    await prisma.version.create({
      data: {
        projectId: req.params.id,
        prompt: `Before restoring ${label || 'a checkpoint'}`,
        html: currentCode,
      },
    })
  }

  await prisma.version.create({
    data: {
      projectId: req.params.id,
      prompt: `Restored ${label || 'a checkpoint'}`,
      html: version.html,
    },
  })
  await prisma.project.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } })

  res.json({ version: { id: version.id, prompt: version.prompt, html: version.html, createdAt: version.createdAt } })
})

// ── Inline completion: the ghost text ahead of the cursor. ──
//
// Unlike every other AI route here, nobody pressed anything to get here — this
// fires on a pause in typing. Two consequences shape the endpoint:
//
//   · It aborts. When the client disconnects — the next keystroke superseded this
//     request — the upstream call is cancelled rather than left to finish into
//     nobody's screen, still spending quota. This is what keeps a fast typist from
//     becoming a burst of concurrent calls: each keystroke kills the one before it,
//     so a held-down key produces one live request, not one per pause.
//   · It never writes anything. No Version row, no cache entry, no updatedAt
//     bump: a suggestion the user hasn't accepted is not a change to the project,
//     and treating it as one would fill the history with keystrokes.
//
// There is deliberately no request-count limit. The debounce in the editor and the
// abort above already shape the traffic, and a local model has no quota to protect;
// a public deployment sharing one provider key is where a limiter earns its place.

projectsRouter.post('/:id/complete', async (req: Request, res: Response) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })

  const file = normalizePath((req.body?.file ?? '').toString())
  if (!file) return res.status(400).json({ error: 'That file is not part of this project.' })

  // Trimmed to the same budgets the prompt builder uses, on the side that faces
  // the caret: the client already sends a window, and this is the backstop that
  // stops a client sending a 2 MB file as "context".
  const prefix = (req.body?.prefix ?? '').toString().slice(-PREFIX_BUDGET)
  const suffix = (req.body?.suffix ?? '').toString().slice(0, SUFFIX_BUDGET)
  // Nothing before the caret is nothing to continue from. An empty file is a job
  // for the build prompt, not for ghost text.
  if (!prefix.trim()) return res.json({ completion: null })

  const ac = new AbortController()
  // 'close' fires on a client that navigated, typed again, or went away. Guard on
  // writableEnded so a normal completed response doesn't abort itself.
  const onClose = () => {
    if (!res.writableEnded) ac.abort()
  }
  req.on('close', onClose)

  try {
    const raw = await runCompletionModel(file, prefix, suffix, ac.signal)
    res.json({ completion: sanitizeCompletion(raw, prefix, suffix) })
  } catch (err: any) {
    // An abort is the expected ending, not a failure — the client is already gone.
    if (ac.signal.aborted || err?.name === 'AbortError') {
      if (!res.writableEnded) res.end()
      return
    }
    // A real provider failure is reported rather than swallowed as "no
    // suggestion": the client stays silent about it, but a misconfigured server
    // should be diagnosable from the network tab instead of looking like a model
    // that never has an idea.
    res.status(502).json({ error: err?.message || 'The completion did not arrive.' })
  } finally {
    req.off('close', onClose)
  }
})

// ── The build endpoint: streams generated code back as Server-Sent Events. ──
projectsRouter.post('/:id/build', async (req: Request, res: Response) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) {
    return res.status(403).json({ error: "You don't have access to this project." })
  }

  // The runtime is read from the project, never from the request. It decides
  // which system prompt runs and which cache partition is consulted, so letting
  // a client name it would let one poison the other's cache.
  const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { runtime: true } })
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  const runtime: Runtime = asRuntime(project.runtime)

  const prompt = (req.body?.prompt ?? '').toString()
  const currentCode = req.body?.currentCode ? String(req.body.currentCode) : undefined
  // Set when the user rejected a reused build and wants this one generated.
  const noCache = req.body?.noCache === true

  // A sketch or screenshot, if one came along. Validated before a single header
  // goes out: once the SSE stream is open the only way to report a problem is an
  // error frame, and "your PNG is 30 MB" deserves a plain 400.
  let image: ImageAttachment | undefined
  if (req.body?.image != null) {
    // An image is a picture of an interface, and a Python project has no
    // interface to draw — the console is the output surface. Refusing here is
    // kinder than letting a vision model produce a page of HTML that the Python
    // runtime will then decline to run.
    if (runtime !== 'web') {
      return res
        .status(400)
        .json({ error: `Sketches and screenshots describe a web page — they can't be built into a ${runtimeLabel(runtime)} project.` })
    }
    const cap = visionCapability()
    if (!cap.supported) {
      return res.status(400).json({ error: cap.reason ?? 'This server is not configured to build from an image.' })
    }
    const parsed = parseImage(req.body.image)
    if ('error' in parsed) return res.status(400).json({ error: parsed.error })
    image = parsed.image
  }

  // With an image attached the words are optional — the picture is the request.
  if (!prompt.trim() && !image) return res.status(400).json({ error: 'Describe what to build.' })
  // What the version history calls this build.
  const label = prompt.trim() || (image?.kind === 'sketch' ? 'Built from a sketch' : 'Built from a screenshot')

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const send = (obj: unknown) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  try {
    // Standing facts about this project, retrieved before anything else because
    // they decide whether the shared cache may be consulted at all.
    const relevantMemories = await retrieveRelevantMemories(req.params.id, prompt, 8)
    const memoryContext = formatMemoriesForAI(relevantMemories)

    // Fresh build (no existing code to modify): if anyone has already generated
    // this idea — the same words, or close enough — serve it straight from the
    // database with no AI call. A loose match reports what it reused so the
    // client can show it and offer to generate a fresh one instead.
    //
    // An image build never consults the cache. The cache is keyed on prompt text
    // alone, and here the text is a footnote to a picture: two people can type
    // "build this" over completely different wireframes, so a text match would
    // hand one of them the other's app. Nor is the result stored, which would
    // poison that key for every text build that follows.
    //
    // Project memory disqualifies a build from the cache for exactly the same
    // reason. The key is prompt text, but memory is per-project: "add a login
    // page" means something different in a project whose memory says it uses
    // sessions than in one that says tokens. Reading the cache here would serve
    // another project's answer to a question this project asked differently.
    if (!currentCode && !noCache && !image && !memoryContext) {
      const hit = await lookupBuild(prompt, runtime)
      if (hit) {
        for (let i = 0; i < hit.output.length; i += 4096) send({ delta: hit.output.slice(i, i + 4096) })
        await prisma.version.create({ data: { projectId: req.params.id, prompt: label, html: hit.output } })
        await prisma.project.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } })
        send({
          done: true,
          summary: hit.summary ?? extractSummary(hit.output),
          cached: true,
          reusedFrom: hit.reusedFrom,
          similarity: hit.similarity,
        })
        return
      }
    }

    const full = await streamBuild(prompt, currentCode, (delta) => send({ delta }), image, runtime, memoryContext)
    const summary = extractSummary(full)

    // Persist a version snapshot and bump the project's updatedAt.
    await prisma.version.create({ data: { projectId: req.params.id, prompt: label, html: full } })
    await prisma.project.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } })


    // Save fresh builds into the shared cache: the next person who asks for
    // this — in these words or near enough — gets it from the database.
    // A memory-informed build is deliberately not stored: it answers this
    // project's question, and writing it under the bare prompt key would hand
    // it to every project that later types the same words.
    if (!currentCode && !image && !memoryContext) await storeBuild(prompt, full, summary, runtime)

    send({ done: true, summary })
  } catch (err: any) {
    send({ error: err?.message || 'The build did not complete.' })
  } finally {
    res.end()
  }
})

// ── The edit endpoint: precise line-level changes ("change line 14 in index.html").
// The model sees the numbered files and answers with line operations, which are
// validated here and applied by the client to the shared document. Returns JSON —
// nothing streams into the editor, so untouched lines are never disturbed.
projectsRouter.post('/:id/edit', async (req: Request, res: Response) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })

  const prompt = (req.body?.prompt ?? '').toString()
  const currentCode = (req.body?.currentCode ?? '').toString()
  if (!prompt.trim()) return res.status(400).json({ error: 'Describe the edit to make.' })

  const files = parseWorkspace(currentCode)
  if (!currentCode.trim() || Object.keys(files).length === 0) {
    return res.status(400).json({ error: 'There is no code to edit yet — build something first.' })
  }

  try {
    const raw = await runEditModel(prompt, numberWorkspace(files))
    const { ops } = parseEditOps(raw)
    if (ops.length === 0) {
      return res.status(422).json({
        error: 'Couldn\'t turn that into a line edit. Try naming the file and line, e.g. "change line 14 in index.html".',
      })
    }

    const { applied, skipped } = prepareEdits(ops, files)
    if (applied.length === 0) {
      return res
        .status(422)
        .json({ error: `Couldn't apply that edit: ${skipped[0]?.reason ?? 'no valid line operations'}.` })
    }

    // Snapshot the edited workspace as a version, same as builds do.
    const updated = applyEditsToFiles(files, applied)
    await prisma.version.create({ data: { projectId: req.params.id, prompt, html: serializeWorkspace(updated) } })
    await prisma.project.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } })

    res.json({
      summary: extractSummary(raw),
      edits: applied,
      skipped: skipped.map((s) => s.reason),
      detail: describeEdits(applied),
    })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'The edit did not complete.' })
  }
})

// ── The inline-edit endpoint: the user highlighted a span and pressed Ctrl+K. ──
// Nothing is inferred here. The client sends the exact file and line range it
// selected, so there is no prompt regex to guess line numbers from and no line
// operations to validate — the model rewrites that span and only that span.
projectsRouter.post('/:id/inline-edit', async (req: Request, res: Response) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })

  const instruction = (req.body?.instruction ?? '').toString()
  const currentCode = (req.body?.currentCode ?? '').toString()
  const file = normalizePath((req.body?.file ?? '').toString())
  const start = Number(req.body?.start)
  const end = Number(req.body?.end)

  if (!instruction.trim()) return res.status(400).json({ error: 'Describe the change to make.' })

  const files = parseWorkspace(currentCode)
  if (!file || !(file in files)) return res.status(400).json({ error: 'That file is not part of this project.' })

  const lines = files[file].split('\n')
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
    return res.status(400).json({ error: `${file} has ${lines.length} lines — that selection is out of range.` })
  }

  try {
    const selection = lines.slice(start - 1, end).join('\n')
    const raw = await runInlineEditModel(instruction, numberWorkspace(files), file, start, end, selection)
    const content = parseInlineReplacement(raw)
    if (content === null) {
      return res.status(422).json({ error: "Lumen didn't return a replacement for that selection. Try wording the change differently." })
    }

    // Snapshot the result as a version, exactly as builds and line edits do.
    const edit: LineEdit = { op: 'replace', file, start, end, content }
    const updated = applyEditsToFiles(files, [edit])
    await prisma.version.create({
      data: { projectId: req.params.id, prompt: `${file} · ${start}-${end} — ${instruction}`, html: serializeWorkspace(updated) },
    })
    await prisma.project.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } })

    res.json({ summary: extractSummary(raw), edit, detail: describeEdits([edit]) })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'The edit did not complete.' })
  }
})
