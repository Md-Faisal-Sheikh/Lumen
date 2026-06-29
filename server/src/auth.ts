import { Router, type Request, type Response, type NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { prisma } from './db'
import { env } from './env'

const PALETTE = ['#8b5cf6', '#e84cc4', '#38e0d8', '#3aa0ff', '#ff7eb6', '#f0a868', '#5ef0b6', '#b69bff']
const pickColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)]

export function signToken(userId: string) {
  return jwt.sign({ uid: userId }, env.JWT_SECRET, { expiresIn: '30d' })
}

export function verifyToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { uid?: string }
    return decoded.uid ?? null
  } catch {
    return null
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  const uid = token ? verifyToken(token) : null
  if (!uid) return res.status(401).json({ error: 'Sign in to continue.' })
  ;(req as any).userId = uid
  next()
}

const publicUser = (u: { id: string; email: string; name: string; color: string }) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  color: u.color,
})

export const authRouter = Router()

authRouter.post('/register', async (req, res) => {
  const parsed = z
    .object({
      email: z.string().email(),
      password: z.string().min(6, 'Use at least 6 characters.'),
      name: z.string().min(1).max(60),
    })
    .safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check your details.' })

  const email = parsed.data.email.toLowerCase()
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) return res.status(409).json({ error: 'That email is already registered.' })

  const passwordHash = await bcrypt.hash(parsed.data.password, 10)
  const user = await prisma.user.create({
    data: { email, passwordHash, name: parsed.data.name, color: pickColor() },
  })
  res.json({ token: signToken(user.id), user: publicUser(user) })
})

authRouter.post('/login', async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string() }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Enter your email and password.' })

  const email = parsed.data.email.toLowerCase()
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return res.status(401).json({ error: 'No account matches those details.' })

  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash)
  if (!ok) return res.status(401).json({ error: 'No account matches those details.' })

  res.json({ token: signToken(user.id), user: publicUser(user) })
})

authRouter.get('/me', authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: (req as any).userId } })
  if (!user) return res.status(404).json({ error: 'Account not found.' })
  res.json({ user: publicUser(user) })
})
