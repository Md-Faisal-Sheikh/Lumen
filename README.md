<div align="center">

# ✦ Lumen

**A collaborative online vibe-coding platform.**
Describe an app in plain language — Lumen writes the code, runs it live, and your whole team watches it happen in the same room.

*Built end to end with free, self-hostable infrastructure. No paid APIs required.*

</div>

---

## What it does

- **Vibe coding** — type *"a neon snake game I can play with arrow keys"* and a complete, working app appears, running live in a sandboxed preview.
- **Real-time collaboration** — code, chat, and a live preview are shared through a CRDT. Everyone in a project sees edits, messages, and each other's cursors instantly.
- **Watch it build** — generated code streams token-by-token into a shared editor, so collaborators see the app being written in real time.
- **Iterate by conversation** — every follow-up ("make the header sticky", "use a dark theme") modifies the running app.
- **Voice mode** — tap the mic to *speak* your idea instead of typing, and optionally have Lumen read its replies back aloud. Powered by the browser's built-in Web Speech API — free, no key, nothing to install.
- **Accounts, projects & history** — sign in, create projects, invite teammates, and every build is snapshotted as a version.

## Tech stack (all free / open-source)

| Layer | Choice | Why it's free |
|---|---|---|
| Client | React 18 + Vite + TypeScript | open-source |
| Editor | CodeMirror 6 + `y-codemirror.next` | collaborative editing + in-editor cursors |
| Real-time | **Yjs** CRDT over self-hosted **Hocuspocus** WebSocket server | you host it; no SaaS |
| AI engine | **Groq** · **Google Gemini** · **Ollama** (pluggable) | all have free tiers; Ollama is fully local |
| API | Node + Express | open-source |
| Auth | JWT + bcrypt (local) | no external auth provider |
| Database | Prisma + **SQLite** (swap to Postgres) | file-based, zero-config |

```
┌──────────────┐    REST + SSE (build stream)    ┌───────────────────────────┐
│  React client │ ───────────────────────────────▶│  Express API              │
│  CodeMirror   │                                  │   ├─ JWT auth (bcrypt)    │
│  Yjs document │◀──────── WebSocket (Yjs) ───────▶│   ├─ Projects / versions  │──▶ free AI
│  iframe preview│   shared code · chat · cursors  │   └─ Hocuspocus collab    │   (Groq/Gemini/
└──────────────┘                                  └──────────────┬────────────┘    Ollama)
                                                                 │ Prisma
                                                          ┌──────▼──────┐
                                                          │  SQLite DB  │  users · projects · versions · Yjs state
                                                          └─────────────┘
```

The AI key lives **only on the server** — the browser never sees it. The build endpoint streams the model's output back over SSE, and the client writes it into the shared Yjs document so every collaborator watches the code appear.

## Prerequisites

- **Node.js 20+**
- One free AI provider (pick whichever you like):
  - **Groq** *(default, fast)* — get a free key at <https://console.groq.com/keys>
  - **Google Gemini** — get a free key at <https://aistudio.google.com/apikey>
  - **Ollama** *(fully local, no key)* — install from <https://ollama.com>, then `ollama pull qwen2.5-coder:7b`

## Quick start

```bash
# 1. Configure the server
cp .env.example server/.env
#    then open server/.env and set JWT_SECRET + your provider key
#    (e.g. AI_PROVIDER=groq and GROQ_API_KEY=...)

# 2. Install, generate the Prisma client, and create the database
npm run setup

# 3. Run client + server together
npm run dev
```

- Client → <http://localhost:5173>
- Server (API + WebSocket) → <http://localhost:4000>

Create an account, then start describing apps.

### See the collaboration

Open the app in **two browser windows** (or share the project link via the **Share** button and have a teammate open it). Type in one — the code, chat, preview, and cursors all update live in the other.

> Sharing adds people by their Lumen email, so each collaborator needs an account first. The **Share** button invites them and copies the project link.

### Voice mode

Tap the **mic** in the composer and speak — your words are transcribed into the prompt for you to review, then send. Toggle the **speaker** button in the top bar to have Lumen read its replies aloud. Voice uses the browser's native Web Speech API (best support in Chrome, Edge, and Safari); if a browser doesn't support it, the mic simply doesn't appear and typing works as normal.

## Configuration (`server/.env`)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | HTTP + WebSocket port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | for CORS in dev |
| `JWT_SECRET` | — | **set a long random string** |
| `DATABASE_URL` | `file:./dev.db` | SQLite by default |
| `AI_PROVIDER` | `groq` | `groq` \| `gemini` \| `ollama` |
| `GROQ_API_KEY` / `GROQ_MODEL` | — / `llama-3.3-70b-versatile` | |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — / `gemini-2.0-flash` | |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `qwen2.5-coder:7b` | |

The client can optionally override `VITE_API_URL` and `VITE_WS_URL` (in `client/.env`); the localhost defaults work out of the box.

## Production

### One container (Docker)

```bash
docker compose up --build
```

This builds the client, runs migrations, and serves the API **and** the compiled client on one port (4000). Pass your keys via env, e.g.:

```bash
JWT_SECRET=... GROQ_API_KEY=... docker compose up --build
```

### Deploy to a free tier

Any Node host works (Render, Railway, Fly.io all have free tiers). Build with `npm run build`, start with `npm start` (serves the client from the API in production). Set the same env vars in your host's dashboard.

### Switching to Postgres

1. In `server/prisma/schema.prisma`, change the datasource `provider` to `"postgresql"`.
2. Set `DATABASE_URL` to your Postgres connection string.
3. Run `npm --workspace server run prisma:migrate`.

Nothing else changes — Prisma and the Yjs persistence layer are provider-agnostic.

## Project structure

```
lumen/
├─ server/                 Express API + Hocuspocus collab + AI engine
│  ├─ prisma/schema.prisma Users · Projects · Members · Versions · Yjs Docs
│  └─ src/
│     ├─ index.ts          HTTP server + WebSocket upgrade
│     ├─ auth.ts           JWT register / login / me
│     ├─ projects.ts       Project CRUD + SSE build endpoint
│     ├─ ai.ts             Pluggable streaming providers (free)
│     └─ collab.ts         Hocuspocus auth + DB persistence
└─ client/                 React + Vite + CodeMirror
   └─ src/
      ├─ Editor.tsx        The collaborative room + build flow
      └─ components/        TopBar · Conversation · Composer · PreviewPane · CodeEditor · Cursors
```

## Security notes

- Generated apps run in a **sandboxed iframe** (`allow-scripts` only — no same-origin access to Lumen).
- AI provider keys are server-side only.
- Passwords are bcrypt-hashed; sessions are stateless JWTs.
- WebSocket connections are authenticated against the JWT **and** project membership before any document is shared.
- For public deployments, set a strong `JWT_SECRET`, serve over HTTPS/WSS, and consider moving to Postgres.

## License

MIT — use it, fork it, build on it.
