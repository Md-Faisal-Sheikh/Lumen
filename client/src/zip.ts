// A dependency-free ZIP writer that runs entirely in the browser.
//
// Produces a standard PKZIP archive exactly as APPNOTE.TXT describes it: a local
// header + data for every entry, then a central directory listing them all, then
// an end-of-central-directory record. Every field is little-endian.
//
// File data is DEFLATE-compressed with the platform's own CompressionStream and
// falls back to "stored" (uncompressed) wherever deflate is unavailable or
// doesn't actually shrink the bytes — both are valid, so the archive opens in
// Explorer, Finder, unzip and 7-Zip either way.

export interface ZipEntry {
  /** Relative path inside the archive, forward slashes, e.g. "styles/theme.css". */
  path: string
  content: string
}

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const EOCD_SIZE = 22

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

const VERSION = 20 // 2.0 — the lowest version that understands DEFLATE
const UTF8_FLAG = 0x0800 // general-purpose bit 11: the file name is UTF-8
const DOS_DIR_ATTR = 0x10 // FAT attribute byte: this entry is a directory

// Beyond either limit the format requires ZIP64, which a generated web project
// will never approach — fail loudly rather than write a corrupt archive.
const MAX_ENTRIES = 0xffff
const MAX_BYTES = 0xffffffff

// ── CRC-32 (IEEE), the checksum stamped on every entry ──────────────
let crcTable: Uint32Array | null = null

function table(): Uint32Array {
  if (crcTable) return crcTable
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  crcTable = t
  return t
}

export function crc32(bytes: Uint8Array): number {
  const t = table()
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ── Compression ─────────────────────────────────────────────────────
// Every array here is backed by a plain (never shared) ArrayBuffer — the stream
// APIs below only accept that flavour, and TypeScript 5.7+ distinguishes them.
type Bytes = Uint8Array<ArrayBuffer>

// "deflate-raw" is the bare stream ZIP method 8 stores; plain "deflate" would
// wrap it in a zlib header and trailer that no extractor expects here.
async function deflateRaw(bytes: Bytes): Promise<Bytes | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const source = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    const compressed = source.pipeThrough(new CompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(compressed).arrayBuffer())
  } catch {
    return null // engine without "deflate-raw" — store the bytes instead
  }
}

// ── MS-DOS timestamp ────────────────────────────────────────────────
// ZIP records wall-clock local time in packed 16-bit fields, with two-second
// resolution and an epoch of 1980. Both ends are clamped to stay in range.
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()))
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >>> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

// ── Byte assembly ───────────────────────────────────────────────────
function byteWriter(size: number) {
  const bytes = new Uint8Array(size)
  const view = new DataView(bytes.buffer)
  let at = 0
  return {
    get offset() {
      return at
    },
    u16(v: number) {
      view.setUint16(at, v & 0xffff, true)
      at += 2
    },
    u32(v: number) {
      view.setUint32(at, v >>> 0, true)
      at += 4
    },
    raw(b: Uint8Array) {
      bytes.set(b, at)
      at += b.length
    },
    done: () => bytes,
  }
}

// Expand "styles/theme.css" into the directory entries a real archive carries
// ahead of it ("styles/"), each emitted once and before anything inside it.
// content === null marks a directory.
function withDirectories(entries: ZipEntry[]): { name: string; content: string | null }[] {
  const out: { name: string; content: string | null }[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const parts = entry.path.split('/')
    let prefix = ''
    for (let i = 0; i < parts.length - 1; i++) {
      prefix += `${parts[i]}/`
      if (seen.has(prefix)) continue
      seen.add(prefix)
      out.push({ name: prefix, content: null })
    }
    out.push({ name: entry.path, content: entry.content })
  }
  return out
}

interface Staged {
  nameBytes: Uint8Array
  flag: number
  method: number
  crc: number
  body: Uint8Array // what actually goes in the file — deflated or stored
  size: number // uncompressed length
  isDir: boolean
  offset: number // filled in as local headers are written
}

/**
 * Build a ZIP archive from a list of text files.
 * Paths keep their folders, so the extracted result is the project's real tree.
 */
export async function createZip(entries: ZipEntry[], when: Date = new Date()): Promise<Blob> {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(when)
  const staged: Staged[] = []

  for (const item of withDirectories(entries)) {
    const isDir = item.content === null
    const nameBytes = encoder.encode(item.name)
    const content = isDir ? new Uint8Array(0) : encoder.encode(item.content as string)
    // Empty content can't compress, and deflate can grow tiny or already-packed
    // files — only take the compressed form when it genuinely wins.
    const deflated = content.length > 0 ? await deflateRaw(content) : null
    const compress = deflated !== null && deflated.length < content.length
    staged.push({
      nameBytes,
      // UTF-8 encoding only widens non-ASCII text, so equal lengths mean pure
      // ASCII — flag the name as UTF-8 only when it actually needs it.
      flag: nameBytes.length === item.name.length ? 0 : UTF8_FLAG,
      method: compress ? METHOD_DEFLATE : METHOD_STORE,
      crc: crc32(content),
      body: compress ? deflated! : content,
      size: content.length,
      isDir,
      offset: 0,
    })
  }

  const localBytes = staged.reduce((n, e) => n + LOCAL_HEADER_SIZE + e.nameBytes.length + e.body.length, 0)
  const centralBytes = staged.reduce((n, e) => n + CENTRAL_HEADER_SIZE + e.nameBytes.length, 0)
  const total = localBytes + centralBytes + EOCD_SIZE
  if (staged.length > MAX_ENTRIES || total > MAX_BYTES) {
    throw new Error('This project is too large to package as a ZIP.')
  }

  const w = byteWriter(total)

  // Local header + data for each entry, in order.
  for (const e of staged) {
    e.offset = w.offset
    w.u32(LOCAL_SIG)
    w.u16(VERSION) // version needed to extract
    w.u16(e.flag)
    w.u16(e.method)
    w.u16(time)
    w.u16(date)
    w.u32(e.crc)
    w.u32(e.body.length) // compressed size
    w.u32(e.size) // uncompressed size
    w.u16(e.nameBytes.length)
    w.u16(0) // extra field length
    w.raw(e.nameBytes)
    w.raw(e.body)
  }

  // Central directory: the same entries again, plus where each one starts.
  const centralStart = w.offset
  for (const e of staged) {
    w.u32(CENTRAL_SIG)
    w.u16(VERSION) // version made by (high byte 0 = MS-DOS/FAT attributes)
    w.u16(VERSION) // version needed to extract
    w.u16(e.flag)
    w.u16(e.method)
    w.u16(time)
    w.u16(date)
    w.u32(e.crc)
    w.u32(e.body.length)
    w.u32(e.size)
    w.u16(e.nameBytes.length)
    w.u16(0) // extra field length
    w.u16(0) // file comment length
    w.u16(0) // disk number where the file starts
    w.u16(0) // internal file attributes
    w.u32(e.isDir ? DOS_DIR_ATTR : 0) // external file attributes
    w.u32(e.offset) // offset of this entry's local header
    w.raw(e.nameBytes)
  }
  const centralEnd = w.offset

  // End of central directory — how an extractor finds everything above.
  w.u32(EOCD_SIG)
  w.u16(0) // this disk number
  w.u16(0) // disk holding the central directory
  w.u16(staged.length) // entries on this disk
  w.u16(staged.length) // entries in total
  w.u32(centralEnd - centralStart) // size of the central directory
  w.u32(centralStart) // where the central directory starts
  w.u16(0) // archive comment length

  return new Blob([w.done()], { type: 'application/zip' })
}

// ── Handing the file to the browser ─────────────────────────────────
// The anchor has to be in the document for Firefox to honour the click, and the
// object URL is released on the next tick — revoking it synchronously cancels
// the download in some browsers.
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
