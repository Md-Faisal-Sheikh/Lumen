import { Router, type Request } from 'express'
import { prisma } from './db'
import { authMiddleware } from './auth'

// Personal chat history: each user can snapshot the current conversation and
// browse their previously saved sessions. Sessions belong to a user, not a room.
export const chatsRouter = Router()

chatsRouter.use(authMiddleware)

const uid = (req: Request) => (req as any).userId as string

// Shared request validation for saving a conversation payload.
async function validateSave(req: Request): Promise<
  | { ok: true; projectId: string; messages: any[]; payload: string }
  | { ok: false; status: number; error: string }
> {
  const projectId = (req.body?.projectId ?? '').toString()
  const messages = req.body?.messages
  if (!projectId) return { ok: false, status: 400, error: 'A project is required to save a chat.' }
  if (!Array.isArray(messages) || messages.length === 0)
    return { ok: false, status: 400, error: 'There are no messages to save yet.' }

  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: uid(req) } },
  })
  if (!member) return { ok: false, status: 403, error: "You don't have access to this project." }

  const payload = JSON.stringify(messages)
  if (payload.length > 1_000_000) return { ok: false, status: 413, error: 'This chat is too large to save.' }
  return { ok: true, projectId, messages, payload }
}

const titleFrom = (messages: any[], explicit?: unknown) =>
  (explicit ?? '').toString().trim().slice(0, 80) ||
  (messages.find((m: any) => m?.role === 'user')?.text ?? 'Chat session').toString().slice(0, 80)

// List this user's saved sessions, most recently active first
// (optionally scoped to one project).
chatsRouter.get('/', async (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined
  const sessions = await prisma.chatSession.findMany({
    where: { userId: uid(req), ...(projectId ? { projectId } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: { project: { select: { name: true } } },
  })
  res.json({
    sessions: sessions.map((s) => {
      let count = 0
      try {
        count = JSON.parse(s.messages).length
      } catch {
        /* corrupt payload — show 0 */
      }
      return {
        id: s.id,
        title: s.title,
        kind: s.kind,
        projectId: s.projectId,
        projectName: s.project?.name ?? 'Project',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: count,
      }
    }),
  })
})

// Continuously auto-save the live conversation: one "auto" session per
// user + project, updated in place as the chat grows.
chatsRouter.put('/autosave', async (req, res) => {
  const v = await validateSave(req)
  if (!v.ok) return res.status(v.status).json({ error: v.error })

  const title = titleFrom(v.messages)
  const existing = await prisma.chatSession.findFirst({
    where: { userId: uid(req), projectId: v.projectId, kind: 'auto' },
  })
  if (existing) {
    // The room chat only ever grows, so a payload with fewer messages than we
    // already hold is a stale request arriving out of order — keep what we have.
    let existingCount = 0
    try {
      existingCount = JSON.parse(existing.messages).length
    } catch {
      /* corrupt stored payload — let the incoming one replace it */
    }
    if (v.messages.length < existingCount)
      return res.json({ session: { id: existing.id, title: existing.title, updatedAt: existing.updatedAt } })
  }
  const session = existing
    ? await prisma.chatSession.update({ where: { id: existing.id }, data: { title, messages: v.payload } })
    : await prisma.chatSession.create({
        data: { userId: uid(req), projectId: v.projectId, title, messages: v.payload, kind: 'auto' },
      })
  res.json({ session: { id: session.id, title: session.title, updatedAt: session.updatedAt } })
})

// Save the current conversation as an explicit snapshot for this user.
chatsRouter.post('/', async (req, res) => {
  const v = await validateSave(req)
  if (!v.ok) return res.status(v.status).json({ error: v.error })

  const session = await prisma.chatSession.create({
    data: { userId: uid(req), projectId: v.projectId, title: titleFrom(v.messages, req.body?.title), messages: v.payload },
  })
  res.json({ session: { id: session.id, title: session.title, createdAt: session.createdAt } })
})

// Full detail of one saved session (messages included). Owner only.
chatsRouter.get('/:id', async (req, res) => {
  const session = await prisma.chatSession.findFirst({
    where: { id: req.params.id, userId: uid(req) },
    include: { project: { select: { name: true } } },
  })
  if (!session) return res.status(404).json({ error: 'That chat session was not found.' })
  let messages: unknown[] = []
  try {
    messages = JSON.parse(session.messages)
  } catch {
    /* corrupt payload — return empty */
  }
  res.json({
    session: {
      id: session.id,
      title: session.title,
      projectId: session.projectId,
      projectName: session.project?.name ?? 'Project',
      createdAt: session.createdAt,
      messages,
    },
  })
})

// Delete one of this user's saved sessions.
chatsRouter.delete('/:id', async (req, res) => {
  const session = await prisma.chatSession.findFirst({ where: { id: req.params.id, userId: uid(req) } })
  if (!session) return res.status(404).json({ error: 'That chat session was not found.' })
  await prisma.chatSession.delete({ where: { id: session.id } })
  res.json({ ok: true })
})
