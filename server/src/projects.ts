import { Router, type Request, type Response } from 'express'
import { prisma } from './db'
import { authMiddleware } from './auth'
import { streamBuild, extractSummary, runEditModel } from './ai'
import {
  applyEditsToFiles,
  describeEdits,
  numberWorkspace,
  parseEditOps,
  parseWorkspace,
  prepareEdits,
  serializeWorkspace,
} from './edits'

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

// Normalize a prompt into the shared cache key, so the same request in
// different casing/spacing hits the same entry.
const promptKey = (prompt: string) => prompt.toLowerCase().replace(/\s+/g, ' ').trim()

// Only cache output that actually looks like a generated project — never a
// refusal or error prose, which would poison the cache for every user.
const looksLikeProject = (out: string) => /={3,}\s*FILE:/.test(out) || /<!doctype html/i.test(out)

// ── The build endpoint: streams generated code back as Server-Sent Events. ──
projectsRouter.post('/:id/build', async (req: Request, res: Response) => {
  const m = await membership(req.params.id, uid(req))
  if (!m) return res.status(403).json({ error: "You don't have access to this project." })

  const prompt = (req.body?.prompt ?? '').toString()
  const currentCode = req.body?.currentCode ? String(req.body.currentCode) : undefined
  if (!prompt.trim()) return res.status(400).json({ error: 'Describe what to build.' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

  try {
    // Fresh build (no existing code to modify): if any user already generated
    // this same prompt, serve the code straight from the database — no AI call.
    if (!currentCode) {
      const cached = await prisma.buildCache.findUnique({ where: { promptKey: promptKey(prompt) } })
      if (cached) {
        for (let i = 0; i < cached.output.length; i += 4096) send({ delta: cached.output.slice(i, i + 4096) })
        await prisma.version.create({ data: { projectId: req.params.id, prompt, html: cached.output } })
        await prisma.project.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } })
        await prisma.buildCache.update({ where: { id: cached.id }, data: { hits: { increment: 1 } } })
        send({ done: true, summary: cached.summary ?? extractSummary(cached.output), cached: true })
        return
      }
    }

    const full = await streamBuild(prompt, currentCode, (delta) => send({ delta }))
    const summary = extractSummary(full)

    // Persist a version snapshot and bump the project's updatedAt.
    await prisma.version.create({ data: { projectId: req.params.id, prompt, html: full } })
    await prisma.project.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } })

    // Save fresh builds into the shared cache: the next user who asks for the
    // same project gets this code from the database instantly.
    if (!currentCode && looksLikeProject(full)) {
      await prisma.buildCache.upsert({
        where: { promptKey: promptKey(prompt) },
        create: { promptKey: promptKey(prompt), prompt, output: full, summary },
        update: { output: full, summary },
      })
    }

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
