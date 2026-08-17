// Inline completion — the ghost text that appears ahead of the cursor.
//
// This is a different job from every other AI path in Lumen. A build or an edit
// is a request the user made and waited for; a completion is unasked-for, has to
// arrive in a few hundred milliseconds, and is *wrong by default* — the user sees
// it and keeps typing. That changes what matters: it must be short, it must never
// repeat what is already on screen, and a bad one must cost nothing.
//
// Everything here is pure so it can be tested without a model: the prompt is a
// function of the cursor position, and the cleanup is a function of the raw
// answer plus the text either side of the caret.

import { env } from './env'

/** How much of the file travels with the request, either side of the caret. */
export const PREFIX_BUDGET = 2400
export const SUFFIX_BUDGET = 800

/** Which provider answers completions: COMPLETION_PROVIDER if set, else the
 *  build provider. See env.ts for why these are allowed to differ. */
export const completionProvider = () => env.COMPLETION_PROVIDER || env.AI_PROVIDER

/**
 * The models to try for a completion, in order — see OPENROUTER_COMPLETION_MODEL
 * in env.ts for why this is not the build model. Empty means this deployment
 * cannot complete, and the editor is told so rather than asking and failing.
 */
export function completionModels(provider = completionProvider()): string[] {
  const configured =
    provider === 'gemini'
      ? env.GEMINI_COMPLETION_MODEL || env.GEMINI_MODEL
      : provider === 'ollama'
        ? env.OLLAMA_COMPLETION_MODEL
        : env.OPENROUTER_COMPLETION_MODEL
  return configured
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
}

/** Whether ghost text is available at all on this server. */
export const completionSupported = (): boolean => completionModels().length > 0

/** Backstops on what comes back. The provider's token cap is the real limit;
 *  these catch a model that ignores it and starts rewriting the file. */
const MAX_LINES = 12
const MAX_CHARS = 700

export const COMPLETION_SYSTEM = `You are the inline code completion engine for Lumen.
You are given one file split at the user's caret: the code before it inside <PREFIX>, the code
after it inside <SUFFIX>. Output the text that belongs at the caret and NOTHING else.

Rules:
- Output raw code only. No explanation, no commentary, no markdown, no code fences.
- Never repeat any part of <PREFIX>. Your output is inserted at the caret, so the prefix is
  already there. Continue from exactly where it stops, mid-word or mid-token if that is where it stops.
- Never repeat any part of <SUFFIX>. Do not close a bracket, tag, or quote that <SUFFIX> already closes.
- Complete the immediate thought — finish the line, the attribute, the statement, or the short
  block that is obviously being written. A few lines at most. Stop rather than write a whole feature.
- Match the file's existing indentation, quote style, naming, and framework-free plain-web idiom.
- If the caret is somewhere nothing sensible can be added, output nothing at all.`

/** Names the language for the model without depending on a parser. */
export function languageOf(path: string): string {
  const p = path.toLowerCase()
  if (p.endsWith('.css')) return 'CSS'
  if (/\.(tsx|ts)$/.test(p)) return 'TypeScript'
  if (/\.(jsx|mjs|js)$/.test(p)) return 'JavaScript'
  if (p.endsWith('.json')) return 'JSON'
  if (/\.html?$/.test(p)) return 'HTML'
  if (p.endsWith('.md')) return 'Markdown'
  if (p.endsWith('.svg')) return 'SVG'
  return 'code'
}

/**
 * The user turn. The window is trimmed to the budgets above rather than sending
 * the file: a completion's whole value is being fast, and the tokens that decide
 * what comes next at the caret are the ones beside it.
 *
 * Truncation is marked with an ellipsis comment so the model reads a clipped
 * window as clipped instead of as the start of the file — otherwise it tries to
 * "finish" a function whose opening it cannot see.
 */
export function buildCompletionPrompt(file: string, prefix: string, suffix: string): string {
  const head = prefix.length > PREFIX_BUDGET ? `…\n${prefix.slice(-PREFIX_BUDGET)}` : prefix
  const tail = suffix.length > SUFFIX_BUDGET ? `${suffix.slice(0, SUFFIX_BUDGET)}\n…` : suffix
  return (
    `File: ${file} (${languageOf(file)})\n\n` +
    `<PREFIX>\n${head}\n</PREFIX>\n` +
    `<SUFFIX>\n${tail}\n</SUFFIX>\n\n` +
    `Output only the code to insert at the caret between them.`
  )
}

// ── Cleaning up the answer ──────────────────────────────────────────

const FENCE_OPEN_RE = /^[ \t]*```[\w-]*[ \t]*$/
const FENCE_CLOSE_RE = /^[ \t]*```[ \t]*$/

/**
 * Small models answer a code question in markdown however firmly you ask them
 * not to, often with a sentence in front of it. If there is a fenced block, its
 * contents *are* the answer — taking them is more reliable than trying to spot
 * and delete prose, because prose is only recognizable by not being code.
 * With no fence the text is returned unchanged.
 */
export function unfence(raw: string): string {
  const lines = raw.split('\n')
  const open = lines.findIndex((l) => FENCE_OPEN_RE.test(l))
  if (open === -1) return raw
  const close = lines.findIndex((l, i) => i > open && FENCE_CLOSE_RE.test(l))
  return lines.slice(open + 1, close === -1 ? undefined : close).join('\n')
}

/**
 * Drop a leading echo of the prefix.
 *
 * The failure this fixes is the common one: asked to continue `const total = `
 * the model helpfully answers `const total = items.length`, which inserted at
 * the caret reads `const total = const total = items.length`.
 *
 * Only two overlaps are trusted, because a wrong strip corrupts code and is
 * worse than a duplicated bracket:
 *   · the caret's own line so far — the model restarted the line it was given
 *   · a run of at least MIN_ECHO characters of the prefix's tail
 * A one or two character coincidence (`(` continuing into `((`) is left alone.
 */
const MIN_ECHO = 4
export function stripPrefixEcho(text: string, prefix: string): string {
  if (!text) return text

  // The line the caret sits on, up to the caret.
  const nl = prefix.lastIndexOf('\n')
  const lineHead = prefix.slice(nl + 1)
  if (lineHead.trim() && text.startsWith(lineHead)) return text.slice(lineHead.length)
  // Same, ignoring the line's leading indentation — a model that re-emits the
  // line usually re-indents it to column zero.
  const bare = lineHead.trimStart()
  if (bare.trim() && text.startsWith(bare)) return text.slice(bare.length)

  const limit = Math.min(prefix.length, text.length, 240)
  for (let k = limit; k >= MIN_ECHO; k--) {
    if (text.startsWith(prefix.slice(prefix.length - k))) return text.slice(k)
  }
  return text
}

/**
 * Drop a trailing duplicate of the suffix.
 *
 * This is the `}}` bug, and the `</div></div>` bug. The model completes a block
 * and closes it, not registering that the closing brace it can see in <SUFFIX>
 * is the same brace. Inserting that gives a file with one too many.
 *
 * The comparison is **literal, indentation included**, and that is the whole
 * trick. A closer the model duplicated sits at the same indentation as the real
 * one, because it is meant to be the same line:
 *
 *     suffix "\n}"   completion "…\n}"     → the same brace, strip it
 *
 * while a closer that genuinely belongs to a block opened inside the completion
 * is nested deeper, and must survive:
 *
 *     suffix "\n}"   completion "…\n  }"   → closes an inner block, keep it
 *
 * Normalizing the whitespace away — which an earlier version of this did — makes
 * those two cases identical and quietly deletes the inner closer.
 */
const MIN_SUFFIX_ECHO = 1
export function stripSuffixEcho(text: string, suffix: string): string {
  if (!text || !suffix.trim()) return text

  const limit = Math.min(suffix.length, 240)
  for (let k = limit; k >= MIN_SUFFIX_ECHO; k--) {
    const candidate = suffix.slice(0, k)
    // An all-whitespace candidate can only match trailing whitespace, which
    // sanitizeCompletion has already removed — and matching it would be a
    // coincidence rather than a duplicate.
    if (!candidate.trim()) continue
    if (!text.endsWith(candidate)) continue
    const kept = text.slice(0, text.length - candidate.length)
    // A suggestion that is *entirely* the suffix is no suggestion; returning
    // empty lets sanitizeCompletion drop it.
    return kept.trim() === '' ? '' : kept.replace(/[ \t]+$/, '')
  }
  return text
}

/**
 * Reject an answer that is the model thinking rather than code.
 *
 * This is not hypothetical. Pointed at a reasoning model — which the default
 * build model here is — a completion request comes back as *"The user wants to
 * sort the items array. The prefix shows `const sorted = items.` … So we should
 * complete with …"*, and the token cap cuts it off before the code ever arrives.
 * Inserting that at the caret would put an essay in the middle of a file.
 *
 * The real fix is configuration: completion has its own small instruct model
 * (completionModels above), so this path should not normally be reached. It is
 * kept because the model is a setting a user can change, and a wrong setting
 * should degrade to "no suggestions" rather than to prose in their code.
 *
 * The signal is a *meta* phrase: reasoning talks about the request rather than
 * answering it, and does so in a small, recognisable set of openings.
 *
 * A general "this looks like prose, not code" measure was tried here and removed.
 * Scoring the density of code punctuation does flag reasoning, but it also flags
 * two things that are perfectly good completions — a paragraph of page copy
 * inside a tag, and a sentence-long code comment — because neither contains any
 * punctuation either. Withholding those to catch a case that configuration
 * already handles was the wrong trade, so this stays narrow and admits it: an
 * essay with no recognisable opening will get through, and the answer to that is
 * to point OPENROUTER_COMPLETION_MODEL at an instruct model.
 */
const META_RE =
  /\b(?:the user (?:wants|is|asked)|we (?:need|should|must|can)|the (?:prefix|suffix|caret|completion) (?:shows|is|ends)|let'?s (?:think|complete)|here(?:'s| is) the|i (?:should|will|need))\b/i

export function looksLikeProse(text: string): boolean {
  // Anything short is a completion, whatever it says.
  if (text.trim().split(/\s+/).length < 12) return false
  return META_RE.test(text)
}

/** Hold the answer to a few lines. A model that starts rewriting the file gets
 *  cut at a line boundary rather than mid-token. */
function clamp(text: string): string {
  let out = text
  const lines = out.split('\n')
  if (lines.length > MAX_LINES) out = lines.slice(0, MAX_LINES).join('\n')
  if (out.length > MAX_CHARS) {
    const cut = out.slice(0, MAX_CHARS)
    const nl = cut.lastIndexOf('\n')
    out = nl > 0 ? cut.slice(0, nl) : cut
  }
  return out
}

/**
 * Raw model answer → the exact string to insert at the caret, or null for "no
 * suggestion". Null is the important half of the contract: ghost text that is
 * blank, or that only re-types what is already there, has to disappear rather
 * than render as an empty decoration the user can press Tab on.
 */
export function sanitizeCompletion(raw: string, prefix: string, suffix: string): string | null {
  if (!raw) return null

  let text = unfence(raw)
  // Checked on the unfenced text and before any trimming: a reasoning answer is
  // rejected whole, and there is no point cleaning up something being discarded.
  if (looksLikeProse(text)) return null
  // Providers habitually open with a newline after the system turn; a completion
  // that begins by breaking the user's line is almost never what was meant.
  // Leading spaces/tabs are kept — they may be real indentation.
  text = text.replace(/^\n+/, '')
  // Trailing whitespace is never worth suggesting, and a trailing newline would
  // put the caret somewhere the user didn't ask to go.
  text = text.replace(/\s+$/, '')

  text = stripPrefixEcho(text, prefix)
  text = stripSuffixEcho(text, suffix)
  text = clamp(text)

  if (!text.trim()) return null

  // The text immediately after the caret, ignoring layout: if the suggestion is
  // just that, accepting it would type what is already on screen.
  const dense = (s: string) => s.replace(/\s+/g, '')
  if (dense(text) && dense(suffix).startsWith(dense(text))) return null

  return text
}
