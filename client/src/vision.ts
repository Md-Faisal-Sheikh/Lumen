import { API_URL } from './api'

// ── Turning a picture into a prompt ─────────────────────────────────
// A sketch or screenshot goes to the model as base64, so the browser does the
// work of getting it into a shape worth sending: scaled down, flattened onto
// white, and encoded in whichever format is actually smaller for that image.
//
// Everything here is platform API — canvas and createImageBitmap — for the same
// reason the ZIP writer is hand-rolled: there is nothing to install, nothing to
// upload, and it costs nothing to host.

export type ImageKind = 'sketch' | 'screenshot'

export interface Attachment {
  kind: ImageKind
  /** image/png or image/jpeg — whichever encoded smaller. */
  mime: string
  /** Base64 with no `data:` prefix. This is what the server forwards. */
  data: string
  /** Full data: URL, for showing the attachment in the composer. */
  url: string
  /** A much smaller data: URL. This is the one that goes into the chat. */
  thumb: string
  width: number
  height: number
  /** Decoded size of `data`, for the size line in the composer. */
  bytes: number
  name?: string
}

// Longest edge of what we send. Vision models tile their input, so past roughly
// this size you pay for tiles that add nothing — a UI screenshot is entirely
// legible at 1152px, and the payload stays a couple of hundred KB.
const MAX_EDGE = 1152
// The thumbnail is stored in the Yjs document and in every autosaved chat, so
// it has to stay small: this lands around 4 KB.
const THUMB_EDGE = 168
// Guard before decoding. A 25 MB source is a mistake, not a screenshot, and
// decoding it to find that out costs a lot of memory on a modest laptop.
const MAX_SOURCE_BYTES = 25 * 1024 * 1024

export const formatBytes = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`)

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void }

async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob)
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() }
    } catch {
      /* Safari has refused perfectly good WebP here — fall through to <img>. */
    }
  }
  return new Promise<Decoded>((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () =>
      resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) })
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("That file isn't an image Lumen can read."))
    }
    img.src = url
  })
}

const fit = (w: number, h: number, maxEdge: number) => {
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
}

// Scale onto an opaque white canvas. The white matters: a transparent PNG —
// which is most exported wireframes — becomes black once flattened by a
// provider, and a model asked to read black-on-black sees an empty page.
function flatten(src: CanvasImageSource, sw: number, sh: number, maxEdge: number): HTMLCanvasElement {
  const { w, h } = fit(sw, sh, maxEdge)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, w, h)
  return canvas
}

// PNG is lossless and wins outright on flat UI colour — a wireframe, or a
// screenshot of an app. A photograph or a heavy gradient encodes many times
// smaller as JPEG, and that is exactly where JPEG's artefacts are least
// harmful. Encoding both and keeping the smaller picks correctly per image,
// rather than guessing from the file extension.
function encode(canvas: HTMLCanvasElement): { mime: string; url: string } {
  const png = canvas.toDataURL('image/png')
  const jpeg = canvas.toDataURL('image/jpeg', 0.9)
  return jpeg.length < png.length ? { mime: 'image/jpeg', url: jpeg } : { mime: 'image/png', url: png }
}

const payload = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1)
// Base64 with padding: every 4 characters are 3 bytes, minus the '=' padding.
const decodedBytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)

function finish(src: CanvasImageSource, sw: number, sh: number, kind: ImageKind, name?: string): Attachment {
  const canvas = flatten(src, sw, sh, MAX_EDGE)
  const { mime, url } = encode(canvas)
  const data = payload(url)
  // The thumbnail comes off the already-scaled canvas, not the original — one
  // less full-size decode, and it is already flattened onto white.
  const thumbCanvas = flatten(canvas, canvas.width, canvas.height, THUMB_EDGE)
  return {
    kind,
    mime,
    data,
    url,
    thumb: thumbCanvas.toDataURL('image/jpeg', 0.62),
    width: canvas.width,
    height: canvas.height,
    bytes: decodedBytes(data),
    name,
  }
}

/** Normalize a dropped, pasted, or chosen file into something sendable. */
export async function attachmentFromBlob(blob: Blob, kind: ImageKind, name?: string): Promise<Attachment> {
  if (blob.type && !blob.type.startsWith('image/')) throw new Error('Attach an image — a screenshot or a photo of a sketch.')
  if (blob.size > MAX_SOURCE_BYTES) throw new Error(`That image is ${formatBytes(blob.size)} — pick one under ${formatBytes(MAX_SOURCE_BYTES)}.`)
  const decoded = await decode(blob)
  try {
    return finish(decoded.source, decoded.width, decoded.height, kind, name)
  } finally {
    decoded.close()
  }
}

/** Same, for the sketch pad's own canvas — no decode step needed. */
export function attachmentFromCanvas(canvas: HTMLCanvasElement, kind: ImageKind, name?: string): Attachment {
  return finish(canvas, canvas.width, canvas.height, kind, name)
}

/** The first image in a paste or a drop, if there is one. */
export function imageFromTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return Array.from(dt.files ?? []).find((f) => f.type.startsWith('image/')) ?? null
}

/** True when a drag is carrying a file at all (types are all you get on dragover). */
export const dragHasFile = (dt: DataTransfer | null) =>
  !!dt && (Array.from(dt.types ?? []).includes('Files') || Array.from(dt.items ?? []).some((i) => i.kind === 'file'))

// ── Can this server look at an image? ───────────────────────────────
// It depends on which provider and model the deployment configured, so the
// client asks instead of assuming — and hides the feature rather than offering
// a button that can only fail.

export interface VisionCapability {
  supported: boolean
  provider: string
  model: string | null
  reason: string | null
}

const UNAVAILABLE: VisionCapability = {
  supported: false,
  provider: 'unknown',
  model: null,
  reason: "Lumen couldn't reach the server to check whether image builds are available.",
}

let cached: VisionCapability | null = null
let inflight: Promise<VisionCapability> | null = null

/** Memoized on success only — a server that was down when we asked may come back. */
export function visionCapability(): Promise<VisionCapability> {
  if (cached) return Promise.resolve(cached)
  if (!inflight) {
    inflight = fetch(`${API_URL}/api/health`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        const v = body?.vision
        if (v && typeof v.supported === 'boolean') {
          cached = v as VisionCapability
          return cached
        }
        return UNAVAILABLE
      })
      .catch(() => UNAVAILABLE)
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}
