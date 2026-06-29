import { Router, type Request, type Response } from 'express'
import { prisma } from './db'
import { authMiddleware } from './auth'
import { streamBuild, extractSummary } from './ai'

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
    const full = await streamBuild(prompt, currentCode, (delta) => send({ delta }))
    const summary = extractSummary(full)

    // Persist a version snapshot and bump the project's updatedAt.
    await prisma.version.create({ data: { projectId: req.params.id, prompt, html: full } })
    await prisma.project.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } })

    send({ done: true, summary })
  } catch (err: any) {
    send({ error: err?.message || 'The build did not complete.' })
  } finally {
    res.end()
  }
})
