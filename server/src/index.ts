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
import { hocuspocus } from './collab'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(cors({ origin: isProd ? true : env.CLIENT_ORIGIN }))
app.use(express.json({ limit: '8mb' }))

app.get('/api/health', (_req, res) => res.json({ ok: true, provider: env.AI_PROVIDER }))
app.use('/api/auth', authRouter)
app.use('/api/projects', projectsRouter)

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
  console.log(`    ai     →  ${env.AI_PROVIDER}\n`)
})
