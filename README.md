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
- **The editor completes as you type** — pause mid-line and the rest of it appears in grey ahead of the caret; <kbd>Tab</kbd> takes it, <kbd>Esc</kbd> dismisses it, <kbd>Alt</kbd>+<kbd>\\</kbd> asks on demand. The suggestion never enters the shared document until you accept it, so nobody else in the room sees a proposal you didn't take.
- **Push to GitHub** — connect an account once, point the project at a repository, and every file lands at its real path in one real commit. Add a README on GitHub and Lumen leaves it alone; delete a file here and the next push removes it there.
- **Voice mode** — tap the mic and *talk*. Dictation keeps listening through the pauses you take to think, you can still type mid-sentence without the two fighting over the box, and Lumen can read its replies back aloud. Powered by the browser's built-in Web Speech API — free, no key, nothing to install.
- **Draw it instead of describing it** — open the sketch pad and scribble a wireframe: boxes, lines, a few labels. Lumen reads the drawing as *layout* and builds the interface it describes. Drop a screenshot in instead and it rebuilds that screen as a real, responsive page — and anything you scrawl on top of the screenshot is read as an instruction, not copied.
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
| Git hosting | **GitHub REST API** + a pasted personal access token | no OAuth app to register, no client secret to host |
| Sketch input | `<canvas>` + the same free providers' vision models | drawing, scaling and encoding all happen in the browser |
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
  - **Ollama** *(fully local, no key)* — install from <https://ollama.com>, then `ollama pull qwen2.5-coder:7b` (and `ollama pull qwen2.5vl:7b` if you want to build from sketches)

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

Tap the **mic** in the composer and talk. Words appear in a strip above the box while they're still being heard, and drop into the prompt once the recognizer commits them — so you can review and edit before sending. Toggle the **speaker** in the top bar to have Lumen read its replies aloud. It's the browser's native Web Speech API throughout (Chrome, Edge, and Safari); where it isn't supported the mic simply doesn't appear and typing works as normal.

Three things about that API make a naïve wiring of it feel broken, and most of `client/src/speech.ts` is about them:

- **Recognition is not continuous**, whatever `continuous = true` suggests. Chrome ends the session after a few seconds of quiet, so pausing to think ended dictation with nothing on screen to say so. Staying on means restarting it — which is why the user's *intent* is tracked separately from whether the engine happens to be running. The restart is invisible: the indicator doesn't blink and nothing is lost across it.
- **Synthesis and recognition share a room.** With voice output on and the mic open, Lumen's reply was read aloud straight into the microphone and transcribed back into the composer. Speaking now stands dictation down and hands it back afterwards, and the strip says so rather than just going dark. The pause isn't charged against you as silence.
- **A long utterance is cut off partway through** in Chrome. Replies are split at sentence boundaries into pieces that each stay under the limit, so a four-sentence summary is read out completely.

Because it restarts constantly, a real failure has to be told apart from an ordinary pause — and the only difference is *timing*. Nothing is heard for 25 seconds and the microphone is released rather than left live with the browser's recording indicator lit; the engine dies and revives a dozen times in ten seconds and it stops and says so. Every failure that has a fix now names it: a blocked microphone, no input device, and being offline (the browser transcribes in the cloud) used to be one indistinguishable *"Voice input stopped unexpectedly."*

Dictation also no longer owns the text box. It reports finished phrases and the composer appends them, so you can type mid-sentence without your keystrokes being overwritten — the previous version snapshotted the field when the mic opened, rewrote it wholesale on every result, and flattened any line breaks already in it. Pressing Enter mid-phrase sends those words too, rather than dropping them and pasting them into the next, empty message. Recognition follows your browser's language instead of assuming `en-US`.

> All of that logic is a plain state machine with no React in it (`createDictation`), taking its clock and scheduler as arguments. That's what makes it testable: the restart, the silence release, the give-up threshold, the hand-off while Lumen speaks, and every error path are exercised against a fake recognizer in milliseconds, with no browser, no microphone, and no 25-second waits.

### Draw it instead of describing it

Some things are far quicker to draw than to write down. *"A top bar with four links, a sidebar of six items, and a 2×2 grid of cards, each with an image, a heading and two lines of text"* is a sentence nobody wants to type — but it's ten seconds with a pen.

Press the **sketch** button in the composer and a white board opens. Draw the layout, then send it. There is nothing to type at all: with an image attached the words become optional.

The pad is a plain `<canvas>` with a pen, an eraser, undo, and a few ink colours. Two things about it are worth knowing:

- **Strokes are stored in board space** — normalized to 0..1, with widths in units of a 1000-wide board. The pad is resizable and the export is a fixed 1152×720 regardless of your window, so nothing may depend on screen pixels. Resize mid-drawing and the sketch is unchanged.
- **Ink is its own layer.** Erasing is a `destination-out` composite, which would punch a hole through an imported screenshot if it shared a canvas with it. The eraser removes *your marks*, never the thing you drew them on.

Drop a **screenshot** in — onto the pad, or straight onto the composer, or just paste it with <kbd>Ctrl</kbd>+<kbd>V</kbd> — and you get the other half of the feature: Lumen rebuilds that screen as a real page, with real elements that reflow, rather than tracing it with absolutely-positioned boxes. Scribble on top of it and the marks become instructions: *circle a button, draw an arrow to where it should go*.

The two are genuinely different requests and the server treats them as such. A wireframe is a **blueprint** — its lines carry layout and nothing else, so reproducing how it *looks* would be precisely wrong; the build instruction says boxes are containers, horizontal lines are text, a crossed box is an image, handwriting is a label to typeset and never to draw. A screenshot is a **target** — its look is the entire point. Sending one instruction for both produced sketchy-looking output from wireframes and rigid traced markup from screenshots, so `server/src/ai.ts` carries one for each.

**What the browser does before anything is sent.** [`client/src/vision.ts`](client/src/vision.ts) scales the image to 1152px on its longest edge — past that you pay for image tiles that add nothing — and flattens it onto **white**. The white is not cosmetic: most exported wireframes have a transparent background, which a provider flattens to black, and a model asked to read black ink on black sees an empty page. It then encodes the result as *both* PNG and JPEG and keeps whichever came out smaller, which picks losslessly for flat wireframe colour and compactly for a photograph without having to guess from the file extension. A typical screenshot leaves as ~200 KB. It's all `<canvas>` and `createImageBitmap` — the same reason the ZIP writer is hand-rolled: nothing to install, no upload, nothing to host.

**Only a thumbnail is kept.** The chat shows the picture each build came from, but what lives in the Yjs document — permanently, synced to everyone in the room, saved into every autosaved chat — is a 168px thumbnail of a few KB, never the full image.

**Image builds never touch the build library.** The cache in the section below is keyed on prompt text, and here the text is a footnote to a picture: two people can type *"build this"* over completely different wireframes, so a text match would hand one of them the other's app. The lookup is skipped and the result is not stored, which also keeps that key clean for the text builds that do use it. The reply says so explicitly rather than leaving you to infer it.

> **On free-tier vision models.** A provider's best *coding* model usually can't see, so an attached image is routed to a separate vision model and text builds keep running on whatever you already configured. For OpenRouter that setting is a comma-separated **fallback list**, and it earns its keep: while this was being built the shipped default had been retired outright (404) and its replacement answered 429 from a saturated shared pool the same afternoon. A model that is gone or busy hands over to the next one; only the opening response is retried, because once code is streaming the room has already watched it arrive. Pin the variable to a single name if you'd rather be told than quietly substituted. If nothing is configured that can see, the sketch button doesn't appear at all — the client asks `/api/health` rather than offering a button that can only fail.

Smaller vision models also tend to answer in **markdown** instead of Lumen's `===== FILE: path =====` protocol — but they still split the project correctly and label each block with its language, which is the same information under a different name. [`client/src/files.ts`](client/src/files.ts) reads it: the response's shape is decided once, from its first real line, and a markdown answer has its fences treated as file boundaries (`html` → `index.html`, `css` → `styles.css`, `js` → `app.js`), its between-block prose dropped, and its summary comment stripped. Deciding the shape once, up front, is what stops a ``` inside a *generated* app — a markdown editor's sample text — from being mistaken for a boundary.

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

### The editor finishes your line

Stop typing for a moment and the rest of the line appears in grey ahead of the caret. <kbd>Tab</kbd> accepts it, <kbd>Esc</kbd> dismisses it, <kbd>Alt</kbd>+<kbd>\\</kbd> asks for one at a caret that has been sitting still. The toggle for it is in the top bar.

The suggestion is a **decoration, never text**. That distinction matters more here than in a normal editor, because this document is a CRDT shared with everyone else in the room: a suggestion that lived in the document would stream into their editors as though somebody had typed it, land in the live preview, and be captured by the next version snapshot. So it exists only in the view, and accepting it is an ordinary insertion the collaborative layer syncs like any keystroke.

Three things about an *unasked-for* feature shape the rest of it:

- **Only the person typing triggers a request.** During a build the document changes every 90ms, and a collaborator's edits arrive constantly. Chasing either would fire a model call per chunk and suggest into a file nobody is looking at, so the trigger distinguishes local typing from every other way text can appear — and an accepted suggestion is marked so that pressing Tab doesn't immediately request the next one.
- **A failure is silence.** There is nothing a user can do about a completion that didn't arrive, so nothing is reported: no toast, no inline error. Suggestions simply stop appearing. The one exception is the server, which returns a real error status so a misconfigured deployment is diagnosable from the network tab instead of looking like a model that never has an idea.
- **Superseded requests are aborted.** When the next keystroke arrives, the browser drops the request and the server aborts its own upstream call rather than finishing into nobody's screen. Together with the debounce this is what keeps a held-down key from becoming a burst of concurrent calls — each keystroke cancels the one before it, so there is one live request at a time regardless of typing speed. There is no request-count limit; if you deploy publicly on a shared provider key, that is the point at which to add one.

**It runs on its own model, and that is not a detail.** Asked to finish `const sorted = items.`, the default build model — a reasoning model — replied *"The user wants to sort the items array in ascending order. The prefix shows…"* for three paragraphs and hit the token cap before writing any code. A completion has about a second to be useful, so it gets a small instruct model of its own (`OPENROUTER_COMPLETION_MODEL`) and builds keep the good one. This is the same split, for a different reason, as the separate vision model above. A `looksLikeProse` guard catches the reasoning case anyway if someone points the variable at a thinking model.

> A general "this looks like prose, not code" check was tried there and removed. Scoring how little code punctuation the answer contains does flag reasoning — and also flags two things that are perfectly good completions: a paragraph of page copy inside a tag, and a sentence-long code comment. Withholding those to catch a case that configuration already fixes was the wrong trade, so the guard stays narrow and the README says so.

What actually comes back is cleaned up before it is shown, because small models are consistently wrong in the same three ways. They answer in markdown, so a fenced block's contents are taken as the answer. They re-type the line they were given, so `const sorted = items.` + `const sorted = items.length` is detected and the echo dropped. And they close a brace the file already closes:

```
suffix "\n}"   completion "…\n}"     → the same brace, dropped
suffix "\n}"   completion "…\n  }"   → closes an inner block, kept
```

That comparison is **literal, indentation included**, and that is the whole trick — a duplicate sits at the same indentation as the real closer, while a closer belonging to a block opened inside the completion is nested deeper. An earlier version normalized the whitespace away first, which makes those two cases identical and silently deletes the inner brace. It was caught by a test, and both cases are now in the suite.

> **On latency.** Against OpenRouter's free pool a suggestion takes roughly 1–8 seconds, and the slow end is slow enough that you will often have typed past it — in which case it is correctly discarded rather than shown. That is the cost of a shared free tier, not of the feature: on a local Ollama the same completions come back in a few hundred milliseconds, which is what this is meant to feel like.

### Push to GitHub

The ZIP export gives you a folder. This gives you history.

**Share → the GitHub button** connects an account, points the project at a repository, and commits. Every file lands at its real path in a single commit on a branch you can clone, deploy from Pages, or open a pull request against.

Three decisions are worth knowing:

**A pasted token, not an OAuth app.** OAuth would mean registering an application, holding a client secret, and hosting a callback URL — three things every self-hosted Lumen would have to be configured with. A personal access token needs none of them and works on a laptop with no public hostname, which is the deployment this project is actually built for. Lumen validates the token with GitHub *before* storing it, so a bad paste is an error in the dialog rather than a mysterious failure on the first push.

**The commit is built through the Git Data API.** Writing files one at a time through the contents API would produce one commit per file and leave the repository in a broken half-state if the third of five failed. Instead Lumen does what `git` does: read the branch, build a tree on top of its tree, write a commit with the old head as its parent, then move the ref. Nothing is visible in the repository until that last step, so a failure anywhere leaves the branch exactly where it was. An identical tree means the workspace already matches the branch, and it reports *"already up to date"* rather than adding an empty commit to your history every time you press the button.

> **A repository with no commits is a special case, and getting it wrong is what broke the first version of this.** Every Git-database endpoint — blobs, trees, commits, refs — answers `409 Conflict · "Git Repository is empty."` until a repository contains something, so the tree-based push above cannot bootstrap one. [GitHub's own guidance](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database) is to initialize through the *contents* API instead, which creates a file, the first commit, and the branch in one call.
>
> So an empty repo is initialized with a throwaway `.lumen-init`, and then the workspace goes in as a **root commit** which the branch is moved onto — leaving the placeholder unreferenced and the branch's entire history as your own single commit. No `.lumen-init`, no "Initial commit" sitting above your work. That move is the one place Lumen forces a ref, and it is safe in a way a real force push is not: the commit being discarded was written by the same request seconds earlier and contains one file nobody has ever seen. The two 409s are also told apart — *empty* is handled, while *"repository is unavailable"* (GitHub still creating it) is the one that really is worth retrying.

**A push adds and updates; it deletes only what Lumen itself put there.** The commit sets `base_tree` to the branch's current tree, so a README, a licence, or a CI workflow that Lumen never wrote is carried through untouched. That alone would leave a file you deleted in Lumen living in the repository forever — so each push records the paths it wrote, and the next one explicitly removes the ones that are gone. Nothing outside that list is ever touched, and re-linking to a different repository clears it, since it describes what Lumen wrote in the *old* one.

Who can do what follows the same rule as inviting and publishing: **the owner chooses the repository** (it decides where everyone's pushes land), and **any member can push with their own account**. The repository belongs to the project; the credential, and therefore the commit's authorship, belongs to the person.

> **The token is encrypted at rest.** A token with `repo` scope can push to every repository its owner can reach, so it is not something to keep in a column next to an email address. It is sealed with AES-256-GCM before it is written, never returned to the browser, and only ever opened to make one request. The key is derived from `JWT_SECRET` with scrypt rather than being a fourth thing to configure — which does couple them: **changing `JWT_SECRET` makes stored tokens unreadable**, and everyone is asked to reconnect rather than seeing a crash.

Errors are translated, because the raw ones are unhelpful at exactly the moments that matter. A token missing the `repo` scope and a repository that does not exist both answer `404`, since GitHub will not confirm the existence of something you cannot see — so Lumen says which two things to check instead of relaying "Not Found". A `403` is both "rate limited" and "not allowed", separated by the remaining-quota header. And if someone pushes to the branch between Lumen reading the head and moving the ref, that is reported rather than resolved by force — nobody's commit is discarded to make the button work.

**Importing a repository is deliberately not included.** Lumen runs static HTML/CSS/JS in a sandboxed iframe, so importing an arbitrary repository would mostly produce files that cannot run — a React project would land in the editor and do nothing. Pushing out is a complete story; pulling in is a different feature that needs a different runtime.

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

## If builds feel slow

Three separate things get blamed on "the model is slow", and they have different fixes.

**The daily cap, which is usually the real one.** OpenRouter's free tier allows roughly 50 requests a day; past that everything answers `429 Rate limit exceeded: free-models-per-day`. Before you hit the wall, free requests are also deprioritised behind paying traffic, so they queue — and queueing is indistinguishable from a slow model from the outside. A one-time 10-credit top-up raises the ceiling to 1000/day. Check it first: if a build fails outright rather than crawling, this is why.

**The model's size.** The default is `nvidia/nemotron-3-ultra-550b-a55b:free` — 550B parameters, the largest on the free list. What matters most here isn't total time but **time to first token**, because the whole room watches the code stream in; a model that starts writing in two seconds feels fast even if it finishes no sooner. `nvidia/nemotron-3.5-lightning:free`, `google/gemma-4-26b-a4b-it:free` (26B with 4B active), and `nvidia/nemotron-3-nano-30b-a3b:free` are all much smaller.

**Reasoning tokens.** Every model on the free tier is now a reasoning model, and each one thinks — in time and tokens — before the first character of your app appears. Lumen's request is *"emit these files in this marker format"*, which is a formatting job rather than a puzzle, so most of that deliberation buys nothing. `OPENROUTER_REASONING=none` (or `minimal`) skips it.

> How much this wastes is measurable at the small end: asked to complete the single line `const sorted = items.`, the default build model replied with three paragraphs about what the user probably meant and hit its token cap before writing any code. On a build the same thinking happens; you just don't see it, because [`files.ts`](client/src/files.ts) drops any prose that arrives before the first file marker rather than writing it into `index.html`.

**Inline suggestions make the cap much worse, and that is worth planning for.** Ghost text fires on every pause in typing, so on a ~50/day allowance a few minutes of editing can spend the whole day and leave nothing for builds. Two ways out, and they compose:

- **Point completions at a different model from builds.** Providers meter per model, so `GEMINI_COMPLETION_MODEL=gemini-2.5-flash-lite` draws down Lite's larger allowance while builds keep Flash's.
- **Point them at a different *provider*.** `COMPLETION_PROVIDER=ollama` runs ghost text on a small local model — free and instant, no allowance at all — while builds stay on whichever remote provider is configured. This is the configuration to want: the two jobs have opposite requirements, and nothing says one provider has to serve both.

**Running locally with Ollama** removes the queue, the cap and the shared pool entirely, and is the only setup where suggestions feel the way they are meant to — a few hundred milliseconds rather than 1–8 seconds.

```bash
ollama pull qwen2.5-coder:7b
# server/.env
AI_PROVIDER=ollama
```

> **Check the machine can hold the model first.** A 7B needs roughly 5–6 GB of *free* memory, a 3B about 2.5 GB, a 1.5B about 1.5 GB. Below that Ollama fails with `unable to allocate CPU_REPACK buffer`, which names the symptom and not the cause — so Lumen translates it into "not enough free memory on this machine" and suggests a smaller model. A laptop with 8 GB total is usually already near its limit running an editor, a browser and the dev server, which makes it a reasonable host for *completions* on a small model and a poor one for builds at any size.
>
> `OLLAMA_COMPLETION_NUM_CTX` is the lever that matters on a tight machine, and it is nearly free to pull: a completion's prompt is a fixed window around the caret, so 2048 tokens is already generous and everything above that is KV cache nobody reads. Measured on a 3B, dropping the context took the largest single allocation from 1.24 GiB to 569 MiB. Builds have no equivalent saving — they genuinely need the context — which is the concrete reason to run builds remotely and completions locally rather than trying to do both in one place.
>
> Check the fit before starting the server, so a failure is one clear line instead of silently absent suggestions:
>
> ```bash
> ollama run qwen2.5-coder:3b "say ok"
> ```

Two things already work in your favour whatever you choose. The **build library** answers a repeated or paraphrased prompt from the database with no model call at all, so the second person to ask for a tic-tac-toe game waits on nothing. And builds **stream**, so the wait is visible progress rather than a spinner.

## Tests

```bash
npm test
```

No test framework and nothing to install — the files are plain assertions run by `tsx`, in the same spirit as the hand-written ZIP writer. They cover the two places where being wrong is quiet rather than loud:

- **`completion.test.ts`** — the ghost-text sanitizer. Fences, prefix echoes, the duplicated-closer cases (including the nested `}` that must *survive*), the runaway-answer clamp, and the reasoning-model guard with the real captured failure as its fixture.
- **`github.test.ts`** — `pushCommit` driven against a stubbed GitHub, asserting the exact call sequence for all six states a branch can be in: empty repository, ordinary push, files Lumen never wrote, nothing-to-do, branch-not-created-yet, and a mid-flight race. Both bugs found in these paths were found here.

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
| `OPENROUTER_REASONING` | — | `none` \| `minimal` \| `low` \| `medium` \| `high`; blank leaves each model's default. See [If builds feel slow](#if-builds-feel-slow) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — / `gemini-2.5-flash` | |
| `COMPLETION_PROVIDER` | — | blank = same provider as builds; set it to run ghost text somewhere else (e.g. a local Ollama) |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `qwen2.5-coder:7b` | |
| `OPENROUTER_VISION_MODEL` | a 3-model free fallback list | used **only** when a sketch or screenshot is attached; comma-separated, tried in order |
| `GEMINI_VISION_MODEL` | — | blank = reuse `GEMINI_MODEL`, which is already multimodal |
| `OLLAMA_VISION_MODEL` | `qwen2.5vl:7b` | needs `ollama pull qwen2.5vl:7b` |
| `OPENROUTER_COMPLETION_MODEL` | a 3-model free fallback list | the editor's ghost text; a small instruct model, **not** the build model |
| `GEMINI_COMPLETION_MODEL` | — | blank = reuse `GEMINI_MODEL` |
| `OLLAMA_COMPLETION_MODEL` | `qwen2.5-coder:7b` | already small and fast; same as the build model is fine |

Blank out the vision variable for your provider to turn image builds off; the sketch button then doesn't appear. Blank out the completion variable to turn inline suggestions off; the toggle then doesn't appear. In both cases the client asks `/api/health` rather than offering a button that can only fail.

GitHub needs no configuration — each user connects their own token from inside the app.

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
│     ├─ projects.ts       Project CRUD + SSE build endpoint + completion endpoint
│     ├─ ai.ts             Pluggable streaming providers (free) + sketch/screenshot prompts
│     ├─ vision.ts         Image validation + which model can see
│     ├─ completion.ts     Ghost-text prompt + answer cleanup (pure, tested)
│     ├─ github.ts         Account, repo link, and the Git Data API commit
│     ├─ crypto.ts         AES-256-GCM seal/open for the stored GitHub token
│     └─ collab.ts         Hocuspocus auth + DB persistence
└─ client/                 React + Vite + CodeMirror
   └─ src/
      ├─ Editor.tsx        The collaborative room + build flow
      ├─ vision.ts         Scale · flatten · encode an attached image
      ├─ speech.ts         Dictation state machine + chunked speech output
      ├─ ghost.ts          CodeMirror inline-completion extension
      └─ components/        TopBar · Conversation · Composer · SketchPad · PreviewPane · CodeEditor · Cursors · GitHubDialog
```

## Security notes

- Generated apps run in a **sandboxed iframe** (`allow-scripts` only — no same-origin access to Lumen).
- AI provider keys are server-side only.
- Attached images are validated on the server before they reach a provider: PNG/JPEG/WebP only, checked against the file's **magic bytes** rather than its declared type, and capped at 4 MB. SVG is refused outright — it is a document that can carry script, not a picture.
- Passwords are bcrypt-hashed; sessions are stateless JWTs.
- **GitHub tokens are encrypted at rest** with AES-256-GCM under a key derived from `JWT_SECRET` via scrypt. They are never returned to the browser, never logged, and are decrypted only to make a single request. A value that fails its authentication tag — a token written under a different `JWT_SECRET`, or a row edited by hand — is treated as "reconnect", not as a crash. Rotating `JWT_SECRET` therefore invalidates every stored token as well as every session.
- Repository owner, name, and branch are validated against GitHub's own naming rules before ever reaching a URL path, since those are the only client-supplied strings that become path segments.
- The completion endpoint writes nothing — no version, no cache entry. A suggestion the user hasn't accepted is not a change to the project.
- WebSocket connections are authenticated against the JWT **and** project membership before any document is shared.
- For public deployments, set a strong `JWT_SECRET`, serve over HTTPS/WSS, and consider moving to Postgres.

## License

MIT
