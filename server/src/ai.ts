import { env } from './env'
import { buildCompletionPrompt, completionModels, completionProvider, COMPLETION_SYSTEM } from './completion'
import { visionCapability, visionModel, visionModels, type ImageAttachment, type ImageKind } from './vision'
import type { Runtime } from './runtime'

// The system instruction handed to whichever free model is configured.
export const SYSTEM = `You are the build engine for Lumen, a collaborative vibe-coding platform.
Turn the user's request into a small, polished multi-file web project.

Output format (follow EXACTLY, no markdown, no code fences, no commentary):
1. The VERY FIRST line MUST be an HTML comment exactly of this form:
   <!-- SUMMARY: one short, friendly sentence describing what you built or changed -->
2. Then output every file of the project. Each file starts with a marker line of exactly this form,
   followed immediately by that file's complete contents:
===== FILE: index.html =====
3. Split the code across separate files: index.html (structure only), styles.css (ALL CSS),
   app.js (ALL JavaScript). Add more .css/.js files when it genuinely helps organize a bigger app.
4. index.html must reference the other files with relative paths, e.g.
   <link rel="stylesheet" href="styles.css"> in <head> and <script src="app.js"></script> before </body>.
5. Do NOT put <style> or <script> blocks inside index.html — keep CSS in .css files and JS in .js files.
6. The only external resources allowed are fonts from fonts.googleapis.com and scripts from cdnjs.cloudflare.com.
7. Write plain HTML/CSS/JavaScript that runs directly in the browser — no build step, no TypeScript, no server code.
8. Make it genuinely polished and responsive, with tasteful micro-interactions, and immediately interactive.
9. If current project files are provided, MODIFY them to satisfy the request rather than starting over,
   and output the complete contents of EVERY file the project needs (including files you did not change).

Keep it reasonably compact, but complete and working.`

// ── The Python runtime ──────────────────────────────────────────────
// A project whose runtime is "python" is executed by CPython compiled to
// WebAssembly (Pyodide) inside the same sandboxed iframe the web preview uses.
// That changes what "an app" means here, and the prompt has to say so plainly:
// there is no browser DOM to build against, the output surface is a terminal,
// and the program has to *end* — a `while True:` with no exit hangs the tab.
//
// The marker protocol is deliberately identical to the web prompt's. The client
// parser, the build cache, the version snapshots, the ZIP writer and the GitHub
// push all read that one format, so a second runtime is a different instruction
// about *what to write*, never a different wire format.
export const PYTHON_SYSTEM = `You are the build engine for Lumen, a collaborative vibe-coding platform.
Turn the user's request into a small, polished Python program.

Output format (follow EXACTLY, no markdown, no code fences, no commentary):
1. The VERY FIRST line MUST be an HTML comment exactly of this form:
   <!-- SUMMARY: one short, friendly sentence describing what you built or changed -->
2. Then output every file of the project. Each file starts with a marker line of exactly this form,
   followed immediately by that file's complete contents:
===== FILE: main.py =====
3. main.py is the entry point and MUST exist — it is the file that gets run.
4. Split genuinely separate concerns into their own modules (e.g. game.py, board.py) and import
   them from main.py with plain "import board" / "from board import Board". Everything sits in one
   flat directory unless the user asks otherwise, so no packages and no relative imports.
5. Guard the entry point with "if __name__ == '__main__':" and keep the top level import-safe.

How this program runs — these are hard constraints, not style notes:
6. It runs as CPython 3 in the browser via Pyodide. The standard library is available, plus any
   package in the Pyodide distribution (numpy, pandas, matplotlib, sympy, scipy, requests-free
   pure-Python wheels). There is NO network access, no threading, no subprocess, no tkinter,
   no pygame, and no local filesystem beyond files this project itself creates.
7. The user sees a TEXT CONSOLE. print() is the interface. Never assume a GUI, a window, or a DOM.
8. The program MUST TERMINATE. Never write an unbounded "while True:" loop that waits for input —
   the whole page freezes. Simulate a fixed number of turns, iterate a bounded range, or run a
   short scripted demo instead.
9. input() works but blocks the page on a modal dialog, so use it sparingly and never in a loop.
   Prefer driving the program with values defined at the top of main.py that are easy to change.
10. Print something the moment it runs. A program whose output is an empty console reads as broken
   even when it worked — show the result, a small table, or a few frames of state.

Style:
11. Idiomatic, readable Python 3: type hints on function signatures, docstrings on anything
   non-obvious, dataclasses over dicts-of-dicts, f-strings over concatenation.
12. Make the console output genuinely nice to look at — aligned columns, box-drawing characters,
   clear section headings. That presentation is this runtime's equivalent of good CSS.
13. If current project files are provided, MODIFY them to satisfy the request rather than starting
   over, and output the complete contents of EVERY file the project needs (including unchanged ones).

Keep it reasonably compact, but complete and working.`

const systemFor = (runtime: Runtime) => (runtime === 'python' ? PYTHON_SYSTEM : SYSTEM)

// ── Building from a picture ─────────────────────────────────────────
// Appended to SYSTEM when an image comes along, so every rule above about the
// output format still holds — only the reading of the request changes.
//
// The two kinds of image are genuinely different requests. A wireframe is a
// *blueprint*: its lines carry layout and nothing else, and reproducing how it
// looks would be exactly wrong. A screenshot is a *target*: its look is the
// whole point. Sending one instruction for both produced sketchy-looking output
// from wireframes and traced, non-reflowing markup from screenshots.

const SKETCH_RULES = `The user attached a hand-drawn wireframe of the interface they want. Build what it describes.

Reading the drawing:
- It is LAYOUT, not artwork. Boxes are containers, horizontal lines are lines of text,
  a box with a cross or diagonal through it is an image placeholder, circles are avatars or
  icons, a row of short words along the top is navigation, and a long thin box is an input.
- Handwritten words are LABELS. Use them as the real text of the element they sit in or beside.
  Never render the handwriting itself, and never reproduce arrows, callouts, or margin notes —
  those are the user talking to you, not parts of the interface.
- Reproduce the spatial arrangement faithfully: what sits above what, what sits side by side,
  relative widths and heights, and which elements are grouped inside a common frame.
- Where the sketch is ambiguous or a box is unlabelled, choose the most conventional
  interpretation for that kind of screen and fill it with plausible sample content.

Making it real:
- The result must look professionally designed — considered spacing, a real type scale, a
  coherent palette, hover and focus states. The drawing is the blueprint, not the visual style.
- Nothing may look hand-drawn, sketchy, or wobbly unless the user asked for that in words.`

const SCREENSHOT_RULES = `The user attached a screenshot or reference image of an interface. Rebuild it as a working web page.

Matching it:
- Match the layout, proportions, and visual hierarchy as closely as you can: the grid, the
  spacing rhythm, relative sizes, and where the weight of the page sits.
- Match the palette by eye — background, surfaces, text, and accent — and approximate the type
  sizes and weights. Transcribe visible text accurately; invent plausible content for anything
  cropped, blurred, or illegible.
- Rebuild it with real elements. Never embed the image itself, and never trace it with
  absolutely-positioned boxes at fixed pixel offsets — the page must reflow and stay responsive.
- Anything that looks interactive should actually work: tabs switch, menus open, inputs accept
  text, buttons respond.

If the image carries hand-drawn marks on top of it — arrows, circles, crossings-out, scribbled
notes — those are instructions about the design, not part of it. Apply what they ask for and
never reproduce the marks themselves.`

const visionRules = (kind: ImageKind) => (kind === 'sketch' ? SKETCH_RULES : SCREENSHOT_RULES)

// What the user is asking for when an image is the main content of the request.
const imageLead = (kind: ImageKind) =>
  kind === 'sketch'
    ? 'The attached image is a hand-drawn wireframe of the app to build. Build the interface it describes.'
    : 'The attached image shows the interface to build. Rebuild it as a working web page.'

// The system instruction for precise line edits ("change line 14 in index.html").
// The model sees the files WITH line numbers and must answer with a minimal set
// of line operations — never a full rebuild.
export const EDIT_SYSTEM = `You are the precision line-editor for Lumen, a collaborative coding platform.
The user gives you the current project files with line numbers, plus an instruction that
references specific lines. Apply the instruction as a MINIMAL set of line operations.
Do NOT rewrite whole files. Do NOT touch lines the user didn't ask about.

Output format (follow EXACTLY, no markdown, no code fences, no commentary):
1. The VERY FIRST line MUST be an HTML comment exactly of this form:
   <!-- SUMMARY: one short, friendly sentence describing the change -->
2. Then one or more operations, in any order:

Replace an inclusive range of lines with new content:
===== REPLACE path @ start-end =====
the new line(s) of raw code
===== END =====

Insert new lines AFTER a given line (use 0 to insert at the very top of the file):
===== INSERT path @ line =====
the new line(s) of raw code
===== END =====

Delete an inclusive range of lines (no body, no END):
===== DELETE path @ start-end =====

Rules:
- Line numbers ALWAYS refer to the ORIGINAL numbering shown in the input. Never renumber
  to account for your own earlier operations.
- Operations on the same file must not overlap.
- A REPLACE may produce more or fewer lines than it removes — that is fine.
- NEVER include the "NN| " line-number prefixes in the content you output.
- Only reference files that exist in the input.
- A single-line operation may be written as "@ 14" instead of "@ 14-14".`

// The system instruction for a selection-scoped edit (Ctrl+K in the editor).
// The model is handed an exact span the user highlighted and answers with the
// replacement for that span — there are no line numbers to guess at and no
// operations to parse, so it cannot touch a line the user didn't select.
export const INLINE_SYSTEM = `You are the inline editor for Lumen, a collaborative coding platform.
The user highlighted an exact span of lines in one file and described a change.
Rewrite ONLY that span.

Output format (follow EXACTLY, no markdown, no code fences, no commentary):
1. The VERY FIRST line MUST be an HTML comment exactly of this form:
   <!-- SUMMARY: one short, friendly sentence describing the change -->
2. Every line after that is the replacement text for the highlighted span, raw.

Rules:
- Output the replacement for the highlighted span ONLY. Never repeat the rest of the file.
- Keep the indentation level of the original span and the file's indentation style.
- You may output more or fewer lines than were highlighted.
- To remove the span entirely, output exactly one line after the summary: <!-- DELETE -->
- NEVER include the "NN| " line-number prefixes from the input.
- Do not wrap the output in backticks.
- The other files are shown for context only — do not modify them.`

export type OnDelta = (text: string) => void

/**
 * Per-request knobs that differ between Lumen's AI paths.
 *
 * `maxTokens` exists for inline completion: a build wants room for a whole
 * project, a completion wants to stop after a line or two, and asking a model
 * for 8000 tokens when you intend to use 30 is most of the latency.
 *
 * `signal` exists for the same reason — a completion is superseded by the next
 * keystroke, and the request it replaces should stop costing quota the moment
 * nobody is waiting for it.
 */
export interface RunOpts {
  maxTokens?: number
  signal?: AbortSignal
  /**
   * Candidate models, tried in order, overriding the provider's configured one.
   * Completion uses this to run on a small fast model while builds keep the good
   * one; OpenRouter walks the whole list on a retryable failure, and the
   * providers that don't do fallback take the first name.
   */
  models?: string[]
  /**
   * Pin the reasoning effort for this call, overriding OPENROUTER_REASONING.
   * Only completion uses it, and only to ask for none — see below.
   */
  reasoning?: string
  /** Send this call to a specific provider instead of AI_PROVIDER. Completion
   *  uses it so ghost text can run locally while builds stay remote. */
  provider?: 'openrouter' | 'gemini' | 'ollama'
  /** Ollama context window for this call. Smaller means a smaller KV cache,
   *  which is what lets a model load at all on a machine short of memory. */
  numCtx?: number
}

const DEFAULT_MAX_TOKENS = 8000

/**
 * The `reasoning` field for an OpenRouter request, or nothing.
 *
 * Returns undefined when OPENROUTER_REASONING is blank so that the request body
 * is byte-identical to what it was before this existed — an unset variable must
 * not change how anybody's builds behave.
 */
function reasoningField(): { effort: string } | undefined {
  const effort = env.OPENROUTER_REASONING.trim().toLowerCase()
  return effort ? { effort } : undefined
}

function buildUserContent(prompt: string, currentCode?: string, image?: ImageAttachment): string {
  // With an image attached, the picture is the request and anything typed is a
  // refinement of it — a bare "make it dark" alongside a wireframe must not read
  // as the whole brief.
  const ask = image
    ? prompt.trim()
      ? `${imageLead(image.kind)}\n\nAlso follow these instructions: ${prompt.trim()}`
      : imageLead(image.kind)
    : prompt

  if (currentCode && currentCode.trim()) {
    return `Current project files:\n\n${currentCode}\n\n---\nRequested change: ${ask}`
  }
  return ask
}

// Dispatch one generation to whichever provider is configured. An image, when
// present, is routed to that provider's vision model — see vision.ts.
async function runModel(
  system: string,
  user: string,
  temperature: number,
  onDelta: OnDelta,
  image?: ImageAttachment,
  opts?: RunOpts
): Promise<string> {
  switch (opts?.provider ?? env.AI_PROVIDER) {
    case 'gemini':
      return streamGemini(system, user, temperature, onDelta, image, opts)
    case 'ollama':
      return streamOllama(system, user, temperature, onDelta, image, opts)
    case 'openrouter':
    default:
      return streamOpenRouter(system, user, temperature, onDelta, image, opts)
  }
}

export async function streamBuild(
  prompt: string,
  currentCode: string | undefined,
  onDelta: OnDelta,
  image?: ImageAttachment,
  runtime: Runtime = 'web'
): Promise<string> {
  if (image) {
    // The route checks this before opening the SSE stream so the user gets a
    // real error instead of an empty build; this is the backstop for any other
    // caller.
    const cap = visionCapability()
    if (!cap.supported) throw new Error(cap.reason ?? 'This server is not configured to build from an image.')
  }
  // A sketch or screenshot describes an *interface*, which is a web request by
  // definition — there is no layout to reproduce in a console. The route refuses
  // the combination before the stream opens; this keeps the two rule sets from
  // being concatenated into a contradictory instruction if it ever gets here.
  const base = systemFor(runtime)
  const system = image ? `${SYSTEM}\n\n${visionRules(image.kind)}` : base
  // A picture is a specification. Reading it loosely invents layout that isn't
  // there, so image builds run cooler than the 0.6 a written prompt gets.
  return runModel(system, buildUserContent(prompt, currentCode, image), image ? 0.35 : 0.6, onDelta, image)
}

// Ask the model for line operations against the numbered workspace. Low temperature:
// this is surgery, not creativity. The full response is returned for parsing.
export async function runEditModel(prompt: string, numberedWorkspace: string): Promise<string> {
  const user = `Current project files with line numbers:\n\n${numberedWorkspace}\n\n---\nRequested edit: ${prompt}`
  return runModel(EDIT_SYSTEM, user, 0.2, () => {})
}

// Rewrite one highlighted span. The whole numbered workspace goes along for
// context (a CSS class the span references may live in another file), but the
// span itself is quoted verbatim so the model can't misidentify what to change.
export async function runInlineEditModel(
  instruction: string,
  numberedWorkspace: string,
  file: string,
  start: number,
  end: number,
  selection: string
): Promise<string> {
  const span = start === end ? `line ${start}` : `lines ${start}-${end}`
  const user =
    `Project files with line numbers:\n\n${numberedWorkspace}\n\n---\n` +
    `The user highlighted ${span} of ${file}. That text is exactly:\n\n${selection}\n\n---\n` +
    `Requested change: ${instruction}`
  return runModel(INLINE_SYSTEM, user, 0.2, () => {})
}

// Ask for the text that belongs at the caret. Three things separate this from
// every other call: a hard token cap (a completion that runs long is a
// completion nobody waited for), near-zero temperature (there is one obviously
// correct continuation of `for (let i = 0; i` and creativity is not wanted), and
// an abort signal, because the next keystroke makes this answer worthless.
export async function runCompletionModel(
  file: string,
  prefix: string,
  suffix: string,
  signal?: AbortSignal
): Promise<string> {
  const models = completionModels()
  if (models.length === 0) throw new Error('No completion model is configured for this provider.')
  const user = buildCompletionPrompt(file, prefix, suffix)
  // Ghost text is capped at no reasoning, so that turning it *up* for complex
  // builds can't make the editor start deliberating over one line again. Only a
  // cap, never an introduction: with OPENROUTER_REASONING blank this stays
  // undefined and the request is unchanged.
  const reasoning = env.OPENROUTER_REASONING.trim() ? 'none' : undefined
  return runModel(COMPLETION_SYSTEM, user, 0.1, () => {}, undefined, {
    maxTokens: 160,
    signal,
    models,
    reasoning,
    provider: completionProvider(),
    numCtx: Number(env.OLLAMA_COMPLETION_NUM_CTX) || undefined,
  })
}

export function extractSummary(full: string): string | null {
  const m = full.match(/<!--\s*SUMMARY:\s*([\s\S]*?)-->/i)
  return m ? m[1].trim() : null
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text()
  } catch {
    return ''
  }
}

// Reads an SSE stream (`data: {...}` lines) and pushes extracted text via onDelta.
async function readSSE(
  body: ReadableStream<Uint8Array>,
  extract: (json: any) => string,
  onDelta: OnDelta
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line || !line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return full
      try {
        const piece = extract(JSON.parse(data))
        if (piece) {
          full += piece
          onDelta(piece)
        }
      } catch {
        /* ignore keep-alive / partial frames */
      }
    }
  }
  return full
}

// A model that can't see fails in a way worth translating: a provider answers
// 404 for a model that doesn't exist and 400 when it exists but rejects the
// image part. Either way the fix is the same, and it isn't obvious from the raw
// body — so say what to change.
const visionModelHint = (provider: string, models: string[], detail: string) =>
  `${models.join(', ')} could not read the image (${detail}). ` +
  `Set ${provider.toUpperCase()}_VISION_MODEL in server/.env to a model that accepts images.`

// Worth trying the next model in the list for: the model is gone, or its shared
// free pool is saturated. A 400 is the model refusing the request itself, and a
// 401/402 is the account — neither improves by asking a different model.
const worthFallingBack = (status: number) => status === 404 || status === 429 || status >= 500

// ── OpenRouter (OpenAI-compatible, free tier) ───────────────────────
async function streamOpenRouter(
  system: string,
  user: string,
  temperature: number,
  onDelta: OnDelta,
  image?: ImageAttachment,
  opts?: RunOpts
): Promise<string> {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set. Add a key from openrouter.ai/keys')

  // Text builds use the one configured model. Image builds walk the vision list
  // until one answers — see visionModels() for why that list exists. Only the
  // opening response is retried: once deltas are flowing the client has already
  // written them into the shared document, and starting over would double them.
  const candidates = opts?.models ?? (image ? visionModels('openrouter') : [env.OPENROUTER_MODEL])
  // OpenAI-compatible multimodal: the user turn becomes an array of parts. The
  // image goes first — the text that follows refers back to it.
  const content = image
    ? [
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } },
        { type: 'text', text: user },
      ]
    : user

  let lastStatus = 0
  let lastDetail = ''

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i]
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5173',
        'X-Title': 'Lumen',
      },
      signal: opts?.signal,
      body: JSON.stringify({
        model,
        stream: true,
        temperature,
        max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
        // A caller may pin this (completion asks for none outright); otherwise it
        // follows OPENROUTER_REASONING, and is omitted entirely when that is blank.
        ...(() => {
          const reasoning = opts?.reasoning === undefined ? reasoningField() : { effort: opts.reasoning }
          return reasoning ? { reasoning } : {}
        })(),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
      }),
    })

    if (r.ok && r.body) {
      if (i > 0) console.log(`  vision → fell back to ${model} (${candidates[i - 1]} answered ${lastStatus})`)
      return readSSE(r.body, (j) => {
        const d = j?.choices?.[0]?.delta?.content
        return typeof d === 'string' ? d : ''
      }, onDelta)
    }

    lastStatus = r.status
    lastDetail = await safeText(r)
    if (i < candidates.length - 1 && worthFallingBack(r.status)) continue

    if (image && (r.status === 400 || r.status === 404)) {
      throw new Error(visionModelHint('openrouter', candidates, `OpenRouter ${r.status}`))
    }
    throw new Error(`OpenRouter error ${r.status}: ${lastDetail}`)
  }

  // Only reachable if the list was empty, which visionCapability() rules out.
  throw new Error('No OpenRouter model is configured.')
}

// ── Google Gemini (free tier) ───────────────────────────────────────
async function streamGemini(
  system: string,
  user: string,
  temperature: number,
  onDelta: OnDelta,
  image?: ImageAttachment,
  opts?: RunOpts
): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set. Add a free key from aistudio.google.com/apikey')
  const model = opts?.models?.[0] ?? (image ? visionModel('gemini') : env.GEMINI_MODEL)
  const parts: Array<Record<string, unknown>> = image
    ? [{ inline_data: { mime_type: image.mime, data: image.data } }, { text: user }]
    : [{ text: user }]

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts?.signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature, maxOutputTokens: opts?.maxTokens ?? 8192 },
    }),
  })
  if (!r.ok || !r.body) {
    const detail = await safeText(r)
    if (image && (r.status === 400 || r.status === 404)) throw new Error(visionModelHint('gemini', [model], `Gemini ${r.status}`))
    throw new Error(`Gemini error ${r.status}: ${detail}`)
  }
  return readSSE(r.body, (j) => {
    const parts = j?.candidates?.[0]?.content?.parts
    if (!Array.isArray(parts)) return ''
    return parts.map((p: any) => p?.text ?? '').join('')
  }, onDelta)
}

// ── Ollama (fully local, free, newline-delimited JSON) ──────────────
async function streamOllama(
  system: string,
  user: string,
  temperature: number,
  onDelta: OnDelta,
  image?: ImageAttachment,
  opts?: RunOpts
): Promise<string> {
  const model = opts?.models?.[0] ?? (image ? visionModel('ollama') : env.OLLAMA_MODEL)
  // A caller's context wins (completion asks for a small one); otherwise
  // OLLAMA_NUM_CTX, and if that is blank, Ollama's own default.
  const numCtx = opts?.numCtx ?? (Number(env.OLLAMA_NUM_CTX) || 0)
  // Ollama takes images as a sibling array of bare base64 strings on the turn.
  const message = image
    ? { role: 'user', content: user, images: [image.data] }
    : { role: 'user', content: user }

  const r = await fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts?.signal,
    body: JSON.stringify({
      model,
      stream: true,
      options: {
        temperature,
        // Ollama's cap is num_predict; left unset it runs to the model's own limit.
        ...(opts?.maxTokens ? { num_predict: opts.maxTokens } : {}),
        // Explicit context beats Ollama's default in both directions: builds need
        // more than 4096 to avoid losing the end of the app, completions need far
        // less and save the memory.
        ...(numCtx ? { num_ctx: numCtx } : {}),
      },
      messages: [{ role: 'system', content: system }, message],
    }),
  })
  if (!r.ok || !r.body) {
    const detail = await safeText(r)
    // 404 from a local Ollama means the model was never pulled — a fixable thing
    // to be told, rather than "is Ollama running?" when it plainly is. True for
    // any model, not just a vision one: the completion default in particular is a
    // different size from the build default, so one can be present and the other not.
    if (r.status === 404) {
      throw new Error(`Ollama doesn't have "${model}". Run:  ollama pull ${model}`)
    }
    // A model too large for the machine's free memory fails here, and the raw
    // ggml text ("unable to allocate CPU_REPACK buffer") names the symptom rather
    // than the cause. On a small machine this is the most likely failure of all.
    if (/allocate|out of memory|insufficient/i.test(detail)) {
      throw new Error(
        `Ollama could not load "${model}" — not enough free memory on this machine. Close some applications, or pull a smaller model (e.g. qwen2.5-coder:1.5b).`
      )
    }
    throw new Error(`Ollama error ${r.status}: ${detail}. Is Ollama running?`)
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      try {
        const piece = JSON.parse(line)?.message?.content ?? ''
        if (piece) {
          full += piece
          onDelta(piece)
        }
      } catch {
        /* ignore */
      }
    }
  }
  return full
}
