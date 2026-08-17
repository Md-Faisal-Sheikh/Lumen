// Prompt similarity for the shared build cache.
//
// The cache used to key on exact normalized text, so "a neon snake game" and
// "snake game with neon colors" were two different entries and the second one
// paid for a fresh generation. This scores two prompts for "would the same code
// satisfy both?" — cheaply, locally, with no model and no dependency.
//
// The asymmetry that shapes every decision here: a miss costs one AI call, but a
// FALSE match hands somebody a chess game when they asked for snake. So the
// scoring is deliberately conservative, and everything below is tuned against a
// labelled set of pairs (see the tests) rather than by feel.

// Words that say nothing about what the app IS.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as', 'at', 'by', 'for', 'from', 'in', 'into',
  'of', 'on', 'onto', 'to', 'with', 'without', 'is', 'are', 'was', 'be', 'been', 'am', 'it', 'its', 'this', 'that',
  'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'they', 'them', 'can', 'could', 'would', 'should',
  'will', 'shall', 'may', 'might', 'must', 'do', 'does', 'did', 'have', 'has', 'had', 'get', 'got', 'let', 'lets',
  'please', 'just', 'some', 'any', 'all', 'no', 'not', 'very', 'really', 'like', 'want', 'wants', 'need', 'needs',
  'make', 'makes', 'made', 'build', 'builds', 'create', 'creates', 'generate', 'give', 'show', 'add', 'using', 'use',
  'where', 'when', 'which', 'who', 'what', 'how', 'there', 'here', 'up', 'out', 'over', 'about', 'me',
])

// Words that appear in almost every request for a web app, plus the ones that
// describe how a thing LOOKS or how you POKE at it. Neither kind tells you what
// the app is: "neon" and "arrow keys" don't make a snake game something other
// than a snake game. They are kept rather than dropped — losing them entirely
// would make "todo" and "todo list" indistinguishable — but weighted down so
// they can never carry a match on their own.
const WEAK = new Set([
  // generic nouns for "a web thing"
  'app', 'application', 'page', 'website', 'site', 'web', 'webpage', 'project', 'thing', 'tool', 'ui', 'interface',
  'game', 'demo', 'example', 'work', 'working', 'version',
  // quality adjectives
  'simple', 'basic', 'small', 'little', 'quick', 'nice', 'cool', 'pretty', 'beautiful', 'clean', 'modern', 'polished',
  'responsive', 'good', 'great', 'awesome', 'minimal', 'sleek', 'fancy',
  // appearance
  'color', 'colour', 'colored', 'coloured', 'colorful', 'colourful', 'theme', 'themed', 'style', 'styled', 'mode',
  'dark', 'light', 'neon', 'pastel', 'gradient', 'glow', 'glowing', 'animated', 'animation', 'smooth', 'rounded',
  'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'black', 'white', 'grey', 'gray',
  // interaction
  'play', 'arrow', 'key', 'keyboard', 'mouse', 'click', 'clickable', 'drag', 'interactive', 'fullscreen', 'hover',
])

const WEAK_WEIGHT = 0.35

// Blend: token overlap decides, character trigrams only soften morphology and
// typos ("calender" vs "calendar"). Trigrams alone would happily match two
// prompts that share boilerplate wording, so they never dominate.
const TOKEN_SHARE = 0.72
const TRIGRAM_SHARE = 0.28

/**
 * Minimum blended score to reuse a cached build. Chosen from the labelled pair
 * set in the tests as the midpoint of the widest gap that separates every
 * should-match pair from every should-not-match pair.
 */
export const SIMILARITY_THRESHOLD = 0.62

// Below this many distinctive words a prompt is too thin to match loosely —
// "a game" must not pull back whichever game happens to be cached. Prompts under
// the bar can still match, but only if their distinctive words agree exactly.
const MIN_STRONG_TOKENS = 2

// IDF needs a corpus to mean anything; under this many entries every term keeps
// its static weight instead.
const MIN_CORPUS_FOR_IDF = 12

// Conservative plural folding, so "keys"/"key" and "colors"/"color" agree.
// Deliberately not a real stemmer: over-stemming collides unrelated words, and a
// collision here is a wrong app served to a user.
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

export interface PreparedPrompt {
  /** Distinctive words — everything that isn't a stopword, stemmed. */
  tokens: Set<string>
  /** Just the ones carrying full weight; these decide what the app actually is. */
  strong: Set<string>
  trigrams: Set<string>
}

export function prepare(text: string): PreparedPrompt {
  const tokens = new Set<string>()
  for (const raw of text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (!raw) continue
    const t = stem(raw)
    if (t.length < 2 || STOPWORDS.has(t) || STOPWORDS.has(raw)) continue
    tokens.add(t)
  }
  const strong = new Set([...tokens].filter((t) => !WEAK.has(t)))
  // Trigrams over the sorted tokens, not the raw sentence: word order is a
  // phrasing choice, not a difference in what was asked for.
  return { tokens, strong, trigrams: trigrams([...tokens].sort().join(' ')) }
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s}  `
  const out = new Set<string>()
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3))
  return out
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return (2 * shared) / (a.size + b.size)
}

export type Idf = (token: string) => number

/**
 * Inverse document frequency across the cached prompts. This is what stops a
 * word everybody uses from looking distinctive: with a hundred cached games,
 * "game" earns a low weight on the evidence rather than because it is on a list.
 * Clamped at both ends so one rare typo can't dominate a comparison.
 */
export function buildIdf(corpus: PreparedPrompt[]): Idf {
  if (corpus.length < MIN_CORPUS_FOR_IDF) return () => 1
  const df = new Map<string, number>()
  for (const p of corpus) for (const t of p.tokens) df.set(t, (df.get(t) ?? 0) + 1)
  const n = corpus.length
  return (t) => {
    const seen = df.get(t) ?? 0
    return Math.min(1.6, Math.max(0.45, Math.log((n + 1) / (seen + 0.5)) / Math.log(n + 1) + 0.35))
  }
}

const staticWeight = (t: string) => (WEAK.has(t) ? WEAK_WEIGHT : 1)

// Cosine, and how much of the SMALLER prompt the larger one covers, from one
// pass. The pair matters: cosine alone punishes elaboration exactly as hard as
// disagreement, so "a neon snake game I can play with arrow keys" would score no
// better against "snake game with neon colors" than a chess game does. Coverage
// forgives the extra detail; cosine still stops a short prompt from matching
// something sprawling. Averaging them keeps both effects.
function overlap(a: Set<string>, b: Set<string>, w: (t: string) => number): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (const t of a) {
    const x = w(t)
    na += x * x
    if (b.has(t)) dot += x * x
  }
  for (const t of b) {
    const x = w(t)
    nb += x * x
  }
  if (na === 0 || nb === 0) return 0
  const cosine = dot / Math.sqrt(na * nb)
  const coverage = dot / Math.min(na, nb)
  return 0.5 * cosine + 0.5 * coverage
}

const setsEqual = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((t) => b.has(t))

// Plain, unweighted containment of the smaller token set in the larger.
function containment(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  if (small.size === 0) return 0
  let shared = 0
  for (const t of small) if (large.has(t)) shared++
  return shared / small.size
}

// In the thin-prompt regime the detail words are all the signal there is, so
// they stop being decoration and have to line up too.
const MIN_THIN_CONTAINMENT = 0.6

/**
 * How interchangeable two prompts are, in [0, 1]. Returns 0 whenever the pair is
 * disqualified outright, so a caller can simply compare against the threshold.
 */
export function similarity(a: PreparedPrompt, b: PreparedPrompt, idf: Idf = () => 1): number {
  if (a.tokens.size === 0 || b.tokens.size === 0) return 0

  // Too few distinctive words on either side for a loose match to be safe: with
  // one subject noun to go on, every difference is the whole request. Such a
  // pair can still qualify, but only by naming the same subject —
  // "calculator" ~ "a calculator app", never "calculator" ~ "tip calculator" —
  // and by agreeing on most of the detail words too, which is what keeps
  // "a red button" away from "a blue button".
  if (a.strong.size < MIN_STRONG_TOKENS || b.strong.size < MIN_STRONG_TOKENS) {
    if (!setsEqual(a.strong, b.strong)) return 0
    if (containment(a.tokens, b.tokens) < MIN_THIN_CONTAINMENT) return 0
  }

  const w = (t: string) => staticWeight(t) * idf(t)
  return TOKEN_SHARE * overlap(a.tokens, b.tokens, w) + TRIGRAM_SHARE * dice(a.trigrams, b.trigrams)
}

export interface Match<T> {
  entry: T
  score: number
}

/** The best candidate at or above the threshold, or null. */
export function bestMatch<T>(
  target: PreparedPrompt,
  candidates: Array<{ entry: T; prepared: PreparedPrompt }>,
  idf: Idf = () => 1,
  threshold = SIMILARITY_THRESHOLD
): Match<T> | null {
  let best: Match<T> | null = null
  for (const c of candidates) {
    const score = similarity(target, c.prepared, idf)
    if (score >= threshold && (!best || score > best.score)) best = { entry: c.entry, score }
  }
  return best
}
