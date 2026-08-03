import { env } from './env'

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

function buildUserContent(prompt: string, currentCode?: string): string {
  if (currentCode && currentCode.trim()) {
    return `Current project files:\n\n${currentCode}\n\n---\nRequested change: ${prompt}`
  }
  return prompt
}

// Dispatch one generation to whichever provider is configured.
async function runModel(system: string, user: string, temperature: number, onDelta: OnDelta): Promise<string> {
  switch (env.AI_PROVIDER) {
    case 'gemini':
      return streamGemini(system, user, temperature, onDelta)
    case 'ollama':
      return streamOllama(system, user, temperature, onDelta)
    case 'openrouter':
    default:
      return streamOpenRouter(system, user, temperature, onDelta)
  }
}

export async function streamBuild(prompt: string, currentCode: string | undefined, onDelta: OnDelta): Promise<string> {
  return runModel(SYSTEM, buildUserContent(prompt, currentCode), 0.6, onDelta)
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

// ── OpenRouter (OpenAI-compatible, free tier) ───────────────────────
async function streamOpenRouter(system: string, user: string, temperature: number, onDelta: OnDelta): Promise<string> {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set. Add a key from openrouter.ai/keys')
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:5173',
      'X-Title': 'Lumen',
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL,
      stream: true,
      temperature,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!r.ok || !r.body) throw new Error(`OpenRouter error ${r.status}: ${await safeText(r)}`)
  return readSSE(r.body, (j) => {
    const d = j?.choices?.[0]?.delta?.content
    return typeof d === 'string' ? d : ''
  }, onDelta)
}

// ── Google Gemini (free tier) ───────────────────────────────────────
async function streamGemini(system: string, user: string, temperature: number, onDelta: OnDelta): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set. Add a free key from aistudio.google.com/apikey')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature, maxOutputTokens: 8192 },
    }),
  })
  if (!r.ok || !r.body) throw new Error(`Gemini error ${r.status}: ${await safeText(r)}`)
  return readSSE(r.body, (j) => {
    const parts = j?.candidates?.[0]?.content?.parts
    if (!Array.isArray(parts)) return ''
    return parts.map((p: any) => p?.text ?? '').join('')
  }, onDelta)
}

// ── Ollama (fully local, free, newline-delimited JSON) ──────────────
async function streamOllama(system: string, user: string, temperature: number, onDelta: OnDelta): Promise<string> {
  const r = await fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.OLLAMA_MODEL,
      stream: true,
      options: { temperature },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!r.ok || !r.body) throw new Error(`Ollama error ${r.status}: ${await safeText(r)}. Is Ollama running?`)
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
