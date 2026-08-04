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
- **Point at it instead of describing it** — arm the picker, hover the live preview to outline elements, and click one. The chat then knows exactly which element you mean, so *"make it bigger and green"* lands on that button and nothing else.
- **Inline edits with Ctrl+K** — select lines in the editor, press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd>, and say what to change. Because the exact line range travels with the request, only those lines are rewritten — the rest of the file stays byte-identical.
- **Voice mode** — tap the mic to *speak* your idea instead of typing, and optionally have Lumen read its replies back aloud. Powered by the browser's built-in Web Speech API — free, no key, nothing to install.
- **A build library that recognises paraphrases** — ask for *"snake game with neon colors"* when someone already built *"a neon snake game"* and you get it instantly, with no AI call. The cache matches on meaning, not on exact wording, and always tells you when it reused something.
- **Publish to a public link** — one click gives the project a `/p/<slug>` page that *anyone* can open. No account, no sign-in, nothing to install — just send the link.
- **Export as a real project** — one click downloads a `.zip` of actual files in actual folders: `index.html`, `styles.css`, `app.js`, `styles/theme.css`. Unzip it and double-click `index.html`; there's no build step and nothing to install. The archive is written in the browser by hand — no library, no server round-trip.
- **Accounts, projects & history** — sign in, create projects, invite teammates, and every build is snapshotted as a version.

## Tech stack (all free / open-source)

| Layer | Choice | Why it's free |
|---|---|---|
| Client | React 18 + Vite + TypeScript | open-source |
| Editor | CodeMirror 6 + `y-codemirror.next` | collaborative editing + in-editor cursors |
| Real-time | **Yjs** CRDT over self-hosted **Hocuspocus** WebSocket server | you host it; no SaaS |
| AI engine | **OpenRouter** · **Google Gemini** · **Ollama** (pluggable) | all have free tiers; Ollama is fully local |
| API | Node + Express | open-source |
| Auth | JWT + bcrypt (local) | no external auth provider |
| Database | Prisma + **SQLite** (swap to Postgres) | file-based, zero-config |
| Export | hand-written ZIP writer + the browser's `CompressionStream` | no dependency, no server |

```
┌──────────────┐    REST + SSE (build stream)    ┌───────────────────────────┐
│  React client │ ───────────────────────────────▶│  Express API              │
│  CodeMirror   │                                  │   ├─ JWT auth (bcrypt)    │
│  Yjs document │◀──────── WebSocket (Yjs) ───────▶│   ├─ Projects / versions  │──▶ free AI
│  iframe preview│   shared code · chat · cursors  │   └─ Hocuspocus collab    │   (OpenRouter/Gemini/
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
  - **OpenRouter** *(default)* — get a free key at <https://openrouter.ai/keys>
  - **Google Gemini** — get a free key at <https://aistudio.google.com/apikey>
  - **Ollama** *(fully local, no key)* — install from <https://ollama.com>, then `ollama pull qwen2.5-coder:7b`

## Quick start

```bash
# 1. Configure the server
cp .env.example server/.env
#    then open server/.env and set JWT_SECRET + your provider key
#    (e.g. AI_PROVIDER=openrouter and OPENROUTER_API_KEY=...)

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

> Collaborators are added by their Lumen email, so each one needs an account first. The **Share** button opens a dialog that invites them and hands you the project link — or publishes a public page for people who aren't collaborating at all (below).

### Voice mode

Tap the **mic** in the composer and speak — your words are transcribed into the prompt for you to review, then send. Toggle the **speaker** button in the top bar to have Lumen read its replies aloud. Voice uses the browser's native Web Speech API (best support in Chrome, Edge, and Safari); if a browser doesn't support it, the mic simply doesn't appear and typing works as normal.

### The build library

Every first-time build is saved to a cache shared by all users, so nobody pays to generate the same app twice. That cache used to key on the exact normalized text — which meant a real database of ours held *three separate entries* for tic tac toe (`build a tic tac toe game app`, `make a tic tac toe game app`, `make a tic tac toe app`) and two for the same coffee shop site. Every one of those was a full generation that didn't need to happen.

It now falls through to a similarity pass ([`server/src/similarity.ts`](server/src/similarity.ts)) — no model, no dependency, no API key:

- prompts are stopworded and conservatively stemmed, then split into **distinctive** words and **weak** ones (`app`, `simple`, `neon`, `arrow keys` — words that describe how a thing looks or how you poke at it, not what it *is*)
- scoring blends a weighted **cosine** with **coverage of the smaller prompt**, because cosine alone punishes elaboration exactly as hard as disagreement — `a neon snake game I can play with arrow keys` would otherwise score no better against `snake game with neon colors` than a chess game does
- **IDF over the cache itself** means that with a hundred cached games, `game` earns a low weight from the evidence rather than from a hard-coded list
- character trigrams contribute a little, to absorb typos and morphology

A wrong match is much worse than a miss — it hands somebody an app they didn't ask for — so the threshold is picked from a labelled set of 34 prompt pairs rather than by feel. At the configured **0.62** that set separates cleanly: **16/16** paraphrases matched, **0/18** false positives, with the nearest wrong pair 0.21 below the hardest right one. Those three tic-tac-toe entries score 0.94–1.00 against each other; `pomodoro timer` vs `countdown timer` scores 0.41 and stays a miss, as do `todo list` vs `shopping list`, `weather dashboard` vs `crypto dashboard`, and `a red button` vs `a blue button`.

Reuse is never silent. A loose match shows a **Reused a similar build** card naming the prompt it matched and the score, with a *Build a fresh one* button that re-runs the request with the cache bypassed. The file explorer footer carries the running numbers — entries, hit rate, how many were matched by similarity, and how many AI calls the library has saved — served from `GET /api/cache/stats`.

### Publishing to a public link

**Share** now does two different jobs, and the dialog separates them:

- **Invite a collaborator** — they edit the code, chat and preview with you live, so they need a Lumen account.
- **Publish to the web** — a read-only page at `http://localhost:4000/p/neon-snake-k4m2xqp` that works for *anyone* with the link. No account, no sign-in.

Publishing stores a **snapshot** taken when you press the button, not the live document — so half-finished work is never exposed and the link keeps working while you keep building. Press *Update to current code* when you want the public page to catch up. The slug never changes, so links you have already sent stay valid. *Unpublish* takes it down immediately.

Publishing is owner-only, matching how invites work: both hand access to someone who doesn't have it.

> **A note on how this is served.** The published page is HTML and JavaScript that a *user* wrote, hosted on the server's own origin. Served naively that is stored XSS — a published app could read the `localStorage` of any signed-in Lumen user who opened the link and walk off with their token. So the app never executes on that origin. `/p/<slug>` is a small page Lumen authors, which frames the project in an iframe with no `allow-same-origin`; `/p/<slug>/app` serves the raw project with a `Content-Security-Policy: sandbox` header so it stays on an opaque origin even if opened directly. Either layer alone would contain it. The sandbox flags match the in-app preview exactly, so a published app behaves just as it did while you were building it.

### Editing precisely

Two ways to change one thing without regenerating the app:

**Ctrl+K in the editor.** Select some lines, press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd>, and a prompt opens over the selection. The request carries the file and the exact line range, so the model is asked to rewrite *that span* and answers with the replacement text — not a whole file and not line operations to be re-parsed. The reply is swapped in with a ranged replace, so collaborators editing elsewhere in the same file keep their cursors and the untouched lines are never rewritten.

> Typing *"change line 14 in index.html"* into the chat still works — that path infers the range from your wording. Ctrl+K skips the inference entirely because the editor already knows what you highlighted.

**Click-to-edit in the preview.** Hit the pointer button in the preview toolbar and the running app becomes selectable: hovering outlines elements, and clicking one stages it in the composer as a chip. Your next message is scoped to that element — Lumen receives its CSS selector and current markup along with your words, so *"make it bigger and green"* can't land on the wrong node.

The picker is a small script injected into the preview document only. It stays inert until armed, swallows the click sequence so picking never fires the app's own buttons, and never touches the project's real files — it isn't in the editor, in a version snapshot, or in the exported ZIP. The preview iframe is sandboxed without `allow-same-origin`, so the two sides talk purely over `postMessage` and the parent authenticates replies by window identity.

### Take the project with you

The **download** button in the top bar packages the workspace as `your-project.zip` — every file at its real path, folders intact:

```
neon-snake/
├── index.html      ← open this
├── styles.css
├── app.js
└── styles/
    └── theme.css
```

That's the whole app. Unzip it and open `index.html`, drop the folder onto Netlify or GitHub Pages, or commit it — no bundler, no `npm install`, no Lumen required.

The archive is assembled in the browser by `client/src/zip.ts`, a from-scratch ZIP writer: CRC-32 checksums, DEFLATE via the platform's `CompressionStream`, local headers, a central directory, and the end-of-central-directory record. No JSZip, no upload, no server round-trip — which also means exporting works offline and costs nothing to host. Browsers without `CompressionStream` (older Safari) transparently get a valid uncompressed archive instead.

## Configuration (`server/.env`)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | HTTP + WebSocket port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | for CORS in dev |
| `PUBLIC_URL` | — | origin published `/p/<slug>` links are built from; blank = use the request host |
| `JWT_SECRET` | — | **set a long random string** |
| `DATABASE_URL` | `file:./dev.db` | SQLite by default |
| `AI_PROVIDER` | `openrouter` | `openrouter` \| `gemini` \| `ollama` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | — / `nvidia/nemotron-3-ultra-550b-a55b:free` | |
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
JWT_SECRET=... OPENROUTER_API_KEY=... docker compose up --build
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

MIT
