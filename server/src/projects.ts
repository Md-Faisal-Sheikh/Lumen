import { Router, type Request, type Response } from 'express'
import { prisma } from './db'
import { authMiddleware } from './auth'
import { streamBuild, extractSummary, runEditModel, runInlineEditModel } from './ai'
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
      updatedAt: m.project.updatedAt,
    })),
  })
})

// Create a project and make the creator its owner.
projectsRouter.post('/', async (req, res) => {
  const name = (req.body?.name ?? 'Untitled project').toString().trim().slice(0, 80) || 'Untitled project'
  const project = await prisma.project.create({
    data: { name, ownerId: uid(req), members: { create: { userId: uid(req), role: 'owner' } } },
  })
  res.json({ project: { id: project.id, name: project.name, ownerId: project.ownerId } })
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
      members: project.members.map((mm) => ({
        id: mm.user.id,
        name: mm.user.name,
        color: mm.user.color,
        role: mm.role,
      })),
    },
  })
})

// Rename a project (owner or editor).
projectsRouter.patch('/:id', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })
  const name = (req.body?.name ?? '').toString().trim().slice(0, 80)
  if (!name) return res.status(400).json({ error: 'Enter a project name.' })
  await prisma.project.update({ where: { id: req.params.id }, data: { name } })
  // Keep the public page's title in step; a no-op when nothing is published.
  await prisma.publication.updateMany({ where: { projectId: req.params.id }, data: { title: name } })
  res.json({ ok: true })
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
  pub: { slug: string; views: number; createdAt: Date; updatedAt: Date },
  req: Request
) => ({ slug: pub.slug, url: publicUrl(req, pub.slug), views: pub.views, publishedAt: pub.createdAt, updatedAt: pub.updatedAt })

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

  const existing = await prisma.publication.findUnique({ where: { projectId: project.id } })
  if (existing) {
    // Re-publishing keeps the slug, so links already shared keep working.
    const updated = await prisma.publication.update({
      where: { id: existing.id },
      data: { html, title: project.name },
    })
    return res.json({ publication: shapePublication(updated, req) })
  }

  // Fresh publication. A slug collision is vanishingly unlikely but cheap to retry.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const created = await prisma.publication.create({
        data: { projectId: project.id, slug: makeSlug(project.name), title: project.name, html },
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

// Build history.
projectsRouter.get('/:id/versions', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })
  const versions = await prisma.version.findMany({
    where: { projectId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, prompt: true, createdAt: true },
  })
  res.json({ versions })
})

// Fetch the full HTML of one saved version.
projectsRouter.get('/:id/versions/:versionId', async (req, res) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })
  const version = await prisma.version.findFirst({
    where: { id: req.params.versionId, projectId: req.params.id },
  })
  if (!version) return res.status(404).json({ error: 'Version not found.' })
  res.json({ version })
})

// ── The build endpoint: streams generated code back as Server-Sent Events. ──
projectsRouter.post('/:id/build', async (req: Request, res: Response) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })

  const prompt = (req.body?.prompt ?? '').toString()
  const currentCode = req.body?.currentCode ? String(req.body.currentCode) : undefined
  // Set when the user rejected a reused build and wants this one generated.
  const noCache = req.body?.noCache === true

  // A sketch or screenshot, if one came along. Validated before a single header
  // goes out: once the SSE stream is open the only way to report a problem is an
  // error frame, and "your PNG is 30 MB" deserves a plain 400.
  let image: ImageAttachment | undefined
  if (req.body?.image != null) {
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

  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

  try {
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
    if (!currentCode && !noCache && !image) {
      const hit = await lookupBuild(prompt)
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

    const full = await streamBuild(prompt, currentCode, (delta) => send({ delta }), image)
    const summary = extractSummary(full)

    // Persist a version snapshot and bump the project's updatedAt.
    await prisma.version.create({ data: { projectId: req.params.id, prompt: label, html: full } })
    await prisma.project.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } })

    // Save fresh builds into the shared cache: the next person who asks for
    // this — in these words or near enough — gets it from the database.
    if (!currentCode && !image) await storeBuild(prompt, full, summary)

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
