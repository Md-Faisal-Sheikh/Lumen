import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { env, isProd } from './env'
import { authRouter } from './auth'
import { projectsRouter } from './projects'
import { chatsRouter } from './chats'
import { publicRouter } from './publish'
import { cacheRouter } from './cache'
import { githubRouter } from './github'
import { hocuspocus } from './collab'
import { visionCapability } from './vision'
import { completionModels, completionProvider, completionSupported } from './completion'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(cors({ origin: isProd ? true : env.CLIENT_ORIGIN }))
app.use(express.json({ limit: '8mb' }))

// Health doubles as the capability probe: whether this deployment can build
// from a picture depends on env, so the client asks rather than assumes — the
// sketch button simply isn't offered when nothing can look at an image.
// Completion is reported the same way and for the same reason: whether the
// editor offers ghost text depends on a model being configured for it, so the
// client asks instead of showing a toggle that could only ever fail.
app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    provider: env.AI_PROVIDER,
    vision: visionCapability(),
    completion: { supported: completionSupported(), model: completionModels()[0] ?? null },
  })
)
app.use('/api/auth', authRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/chats', chatsRouter)
app.use('/api/cache', cacheRouter)
app.use('/api/github', githubRouter)
// Published projects, open to anyone with the link. Mounted ahead of the SPA
// fallback below so /p/<slug> resolves here rather than loading the editor.
app.use('/p', publicRouter)

// In production, serve the compiled client from the same origin.
if (isProd) {
  const clientDist = path.resolve(__dirname, '../../client/dist')
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next()
      res.sendFile(path.join(clientDist, 'index.html'))
    })
  }
}

const server = http.createServer(app)

// Route WebSocket upgrades into Hocuspocus (one port for HTTP + real-time).
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    hocuspocus.handleConnection(ws, request)
  })
})

server.listen(env.PORT, () => {
  console.log(`\n  ✦ Lumen server ready`)
  console.log(`    http   →  http://localhost:${env.PORT}`)
  console.log(`    ws     →  ws://localhost:${env.PORT}`)
  const vision = visionCapability()
  console.log(`    ai     →  ${env.AI_PROVIDER}`)
  console.log(`    vision →  ${vision.supported ? vision.model : 'off — ' + vision.reason}`)
  const ghost = completionModels()[0]
  console.log(`    ghost  →  ${ghost ? `${ghost} (${completionProvider()})` : 'off — no completion model configured'}\n`)
})
