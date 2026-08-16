import { env } from './env'

// ── Image input for the build engine ────────────────────────────────
// A sketch or a screenshot is a *second* kind of prompt: it says what to build
// in a way words are bad at. Everything about handling it that isn't specific
// to one provider's wire format lives here — validation of what the browser
// sent, and which model can actually look at it.

export type ImageKind = 'sketch' | 'screenshot'

export interface ImageAttachment {
  mime: string
  /** Base64 payload with no `data:` prefix — every provider wants it that way. */
  data: string
  kind: ImageKind
  /** Decoded size, for logging and the size ceiling. */
  bytes: number
}

// What the three providers reliably accept. GIF is deliberately absent: one
// frame of an animation is not what anybody means by "build this screen".
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp'])

// Decoded size. The client scales every image down to ~1150px on its longest
// edge before sending, which puts a normal screenshot around 200 KB — this
// ceiling is here so a hand-rolled request can't park megabytes in a provider
// payload. It also sits well under the 8 MB body limit once base64 inflates it.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

// Magic bytes. The declared mime decides how the provider decodes the payload,
// so it has to be checked against the bytes rather than trusted — a mismatch is
// either a broken client or someone poking at the endpoint.
function sniff(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

const asKind = (v: unknown): ImageKind => (v === 'sketch' ? 'sketch' : 'screenshot')

/**
 * Turn whatever arrived on the request body into an attachment we're willing to
 * forward, or an error sentence to show the user. Accepts either
 * `{ mime, data }` or a whole `data:image/png;base64,…` URL.
 */
export function parseImage(raw: unknown): { image: ImageAttachment } | { error: string } {
  if (raw === null || typeof raw !== 'object') return { error: 'That attachment could not be read.' }

  const body = raw as Record<string, unknown>
  let mime = typeof body.mime === 'string' ? body.mime.toLowerCase().trim() : ''
  let data = typeof body.data === 'string' ? body.data : ''

  // Tolerate a full data: URL in either field — it's what a browser hands you.
  const url = data || (typeof body.url === 'string' ? body.url : '')
  const asUrl = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s.exec(url)
  if (asUrl) {
    mime = mime || asUrl[1].toLowerCase()
    data = asUrl[2]
  }

  data = data.replace(/\s+/g, '')
  if (!data) return { error: 'That attachment arrived empty.' }
  if (!ALLOWED.has(mime)) return { error: 'Attach a PNG, JPEG, or WebP image.' }
  if (!BASE64.test(data)) return { error: 'That attachment is not valid base64 image data.' }

  // Reject on the encoded length first: decoding a huge string to find out it
  // was huge is the expensive way round.
  if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) {
    return { error: `That image is too large — keep it under ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.` }
  }

  const buf = Buffer.from(data, 'base64')
  if (buf.length === 0) return { error: 'That attachment is not valid base64 image data.' }
  if (buf.length > MAX_IMAGE_BYTES) {
    return { error: `That image is too large — keep it under ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.` }
  }

  const actual = sniff(buf)
  if (!actual) return { error: "That file isn't a PNG, JPEG, or WebP image." }
  if (actual !== mime) return { error: `That file is a ${actual.slice(6).toUpperCase()}, not a ${mime.slice(6).toUpperCase()}.` }

  return { image: { mime: actual, data, kind: asKind(body.kind), bytes: buf.length } }
}

// ── Which model does the looking ────────────────────────────────────
// The default text model of a provider often can't see. Rather than force the
// whole project onto a vision model, each provider gets a separate vision model
// that is used *only* when an image is attached — so text builds keep running
// on whatever was already configured.

export interface VisionCapability {
  supported: boolean
  provider: string
  /** The model images are actually sent to; null when nothing can look at them. */
  model: string | null
  /** Why it's unavailable, phrased for the person who has to fix it. */
  reason: string | null
}

/**
 * The vision models to try, in order.
 *
 * A list rather than a single name because free tiers move under you: the model
 * this shipped with was retired by OpenRouter, and its replacement answered 429
 * from a shared upstream pool the same afternoon. Both are recoverable if there
 * is somewhere else to go — see the fallback loop in ai.ts. Set the env var to
 * one name to pin it, or to a comma-separated list to choose the order.
 */
export function visionModels(provider = env.AI_PROVIDER): string[] {
  const configured =
    provider === 'gemini'
      ? env.GEMINI_VISION_MODEL || env.GEMINI_MODEL
      : provider === 'ollama'
        ? env.OLLAMA_VISION_MODEL
        : env.OPENROUTER_VISION_MODEL
  return configured
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
}

/** The model images normally go to — the first of the list. */
export const visionModel = (provider = env.AI_PROVIDER): string => visionModels(provider)[0] ?? ''

/** Can this deployment build from an image right now, and if not, why not? */
export function visionCapability(): VisionCapability {
  const provider = env.AI_PROVIDER
  const model = visionModel(provider)
  const no = (reason: string): VisionCapability => ({ supported: false, provider, model: null, reason })

  if (!model) {
    return no(`No vision model is configured for ${provider}. Set ${provider.toUpperCase()}_VISION_MODEL in server/.env.`)
  }
  if (provider === 'openrouter' && !env.OPENROUTER_API_KEY) return no('Set OPENROUTER_API_KEY in server/.env to build from an image.')
  if (provider === 'gemini' && !env.GEMINI_API_KEY) return no('Set GEMINI_API_KEY in server/.env to build from an image.')

  return { supported: true, provider, model, reason: null }
}
