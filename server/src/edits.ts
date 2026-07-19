// The line-edit engine: turns "change line 14 in index.html" into precise,
// validated line operations.
//
// Flow: the client sends the whole workspace in the same `===== FILE: path =====`
// marker format used for builds. We number every line, hand it to the model with
// EDIT_SYSTEM, and parse its answer into REPLACE / INSERT / DELETE operations.
// Each operation is validated against the snapshot (file exists, lines in range,
// no overlaps) and ordered bottom-up so original line numbers stay valid while
// applying. The server applies them to produce the Version snapshot; the client
// applies the same ordered list to the shared Yjs document.

export const INDEX_FILE = 'index.html'

const FILE_MARKER_RE = /^\s*={3,}\s*FILE:\s*(.+?)\s*={3,}\s*$/
const REPLACE_RE = /^\s*={3,}\s*REPLACE\s+(.+?)\s*@\s*(\d+)(?:\s*-\s*(\d+))?\s*={3,}\s*$/i
const INSERT_RE = /^\s*={3,}\s*INSERT\s+(.+?)\s*@\s*(?:AFTER\s+)?(\d+)\s*={3,}\s*$/i
const DELETE_RE = /^\s*={3,}\s*DELETE\s+(.+?)\s*@\s*(\d+)(?:\s*-\s*(\d+))?\s*={3,}\s*$/i
const END_RE = /^\s*={3,}\s*END\s*={3,}\s*$/i
const FENCE_RE = /^\s*```[\w-]*\s*$/

export type LineEdit =
  | { op: 'replace'; file: string; start: number; end: number; content: string }
  | { op: 'insert'; file: string; after: number; content: string }
  | { op: 'delete'; file: string; start: number; end: number }

// Mirror of the client's path rules, so a model-mangled path can't escape them.
export function normalizePath(input: string): string | null {
  const raw = input.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '')
  if (!raw || raw.length > 120) return null
  const parts = raw.split('/')
  if (parts.length > 6) return null
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return null
    if (!/^[\w][\w .-]*$/.test(part)) return null
  }
  const file = parts[parts.length - 1]
  if (!/\.[A-Za-z0-9]+$/.test(file)) return null
  return parts.join('/')
}

// ── Workspace (de)serialization ─────────────────────────────────────

// Split the marker-serialized workspace back into { path: content }.
export function parseWorkspace(serialized: string): Record<string, string> {
  const files: Record<string, string> = {}
  let current: string | null = null
  let lines: string[] = []
  const close = () => {
    if (current !== null) files[current] = lines.join('\n').replace(/\s+$/, '')
  }
  for (const line of serialized.split('\n')) {
    const marker = line.match(FILE_MARKER_RE)
    if (marker) {
      close()
      current = normalizePath(marker[1])
      lines = []
      continue
    }
    if (current !== null) lines.push(line)
  }
  close()
  return files
}

export function serializeWorkspace(files: Record<string, string>): string {
  const section = (path: string, content: string) => `===== FILE: ${path} =====\n${content.replace(/\s+$/, '')}\n`
  const order = Object.keys(files).sort((a, b) => (a === INDEX_FILE ? -1 : b === INDEX_FILE ? 1 : 0))
  return order.map((p) => section(p, files[p])).join('\n')
}

// Render every file with "  N| " prefixes so the model and the user's editor
// gutter agree on what "line 14" means.
export function numberWorkspace(files: Record<string, string>): string {
  const sections = Object.entries(files).map(([path, content]) => {
    const lines = content.split('\n')
    const width = String(lines.length).length
    const body = lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join('\n')
    return `===== FILE: ${path} =====\n${body}`
  })
  return sections.join('\n\n')
}

// ── Parsing the model's operations ──────────────────────────────────

export function parseEditOps(raw: string): { ops: LineEdit[] } {
  const ops: LineEdit[] = []
  let pending: { header: LineEdit; body: string[] } | null = null

  // If every non-empty body line still carries a "NN| " prefix the model ignored
  // the rules — strip the prefixes rather than writing them into the code.
  const finishBody = (body: string[]): string => {
    const nonEmpty = body.filter((l) => l.trim())
    if (nonEmpty.length > 0 && nonEmpty.every((l) => /^\s*\d+\|\s?/.test(l))) {
      body = body.map((l) => l.replace(/^\s*\d+\|\s?/, ''))
    }
    return body.join('\n')
  }
  const close = () => {
    if (!pending) return
    const { header, body } = pending
    if (header.op === 'replace' || header.op === 'insert') header.content = finishBody(body)
    ops.push(header)
    pending = null
  }

  for (const line of raw.split('\n')) {
    if (FENCE_RE.test(line)) continue // tolerate a model wrapping output in code fences
    if (END_RE.test(line)) {
      close()
      continue
    }
    const rep = line.match(REPLACE_RE)
    const ins = line.match(INSERT_RE)
    const del = line.match(DELETE_RE)
    if (rep || ins || del) close() // a new header also terminates an unclosed op

    if (rep) {
      const start = parseInt(rep[2], 10)
      const end = rep[3] ? parseInt(rep[3], 10) : start
      pending = { header: { op: 'replace', file: rep[1].trim(), start, end, content: '' }, body: [] }
    } else if (ins) {
      pending = { header: { op: 'insert', file: ins[1].trim(), after: parseInt(ins[2], 10), content: '' }, body: [] }
    } else if (del) {
      const start = parseInt(del[2], 10)
      const end = del[3] ? parseInt(del[3], 10) : start
      ops.push({ op: 'delete', file: del[1].trim(), start, end })
    } else if (pending) {
      pending.body.push(line)
    }
  }
  close()
  return { ops }
}

// ── Validation + ordering ───────────────────────────────────────────

export interface SkippedEdit {
  op: LineEdit
  reason: string
}

// A splice on the ORIGINAL 0-based line array: remove `count` lines at `index`,
// insert the op's content there. All ops share the original numbering, so
// non-overlapping splices applied bottom-up compose correctly.
const spliceIndex = (op: LineEdit) => (op.op === 'insert' ? op.after : op.start - 1)
const spliceCount = (op: LineEdit) => (op.op === 'insert' ? 0 : op.end - op.start + 1)

// Validate each op against the snapshot, drop conflicting ones, and return the
// survivors ordered for bottom-up application (per file, descending position;
// at the same position, removals apply before insertions).
export function prepareEdits(
  rawOps: LineEdit[],
  files: Record<string, string>
): { applied: LineEdit[]; skipped: SkippedEdit[] } {
  const applied: LineEdit[] = []
  const skipped: SkippedEdit[] = []
  const claimed = new Map<string, Array<[number, number]>>() // file -> claimed [start,end] ranges

  for (const raw of rawOps) {
    const file = normalizePath(raw.file)
    if (!file || !(file in files)) {
      skipped.push({ op: raw, reason: `"${raw.file}" is not a file in this project` })
      continue
    }
    const op = { ...raw, file } as LineEdit
    const lineCount = files[file].split('\n').length

    if (op.op === 'insert') {
      if (op.after < 0 || op.after > lineCount) {
        skipped.push({ op, reason: `${file} has ${lineCount} lines — can't insert after line ${op.after}` })
        continue
      }
    } else {
      if (op.start < 1 || op.end < op.start || op.end > lineCount) {
        skipped.push({ op, reason: `${file} has ${lineCount} lines — lines ${op.start}-${op.end} are out of range` })
        continue
      }
      const ranges = claimed.get(file) ?? []
      if (ranges.some(([s, e]) => op.start <= e && op.end >= s)) {
        skipped.push({ op, reason: `lines ${op.start}-${op.end} of ${file} overlap another edit` })
        continue
      }
      ranges.push([op.start, op.end])
      claimed.set(file, ranges)
    }
    applied.push(op)
  }

  applied.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    const d = spliceIndex(b) - spliceIndex(a)
    if (d !== 0) return d
    return spliceCount(b) - spliceCount(a) // removal before insertion at the same index
  })
  return { applied, skipped }
}

// ── Application ─────────────────────────────────────────────────────

// Apply one file's ordered ops to its line array (mutates and returns it).
export function spliceLines(lines: string[], ops: LineEdit[]): string[] {
  for (const op of ops) {
    // Clamp defensively: ops were validated against a snapshot, and the array
    // may differ if content changed since (the client applies to live text).
    const index = Math.max(0, Math.min(spliceIndex(op), lines.length))
    const count = Math.max(0, Math.min(spliceCount(op), lines.length - index))
    // An empty-content REPLACE removes the lines outright; split('') would
    // otherwise leave a stray blank line behind.
    const content = op.op === 'delete' ? '' : op.content
    lines.splice(index, count, ...(content === '' ? [] : content.split('\n')))
  }
  return lines
}

// Apply ordered ops across the whole workspace, returning the new file map.
export function applyEditsToFiles(files: Record<string, string>, ordered: LineEdit[]): Record<string, string> {
  const out: Record<string, string> = { ...files }
  const byFile = new Map<string, LineEdit[]>()
  for (const op of ordered) {
    const list = byFile.get(op.file) ?? []
    list.push(op)
    byFile.set(op.file, list)
  }
  for (const [file, ops] of byFile) {
    out[file] = spliceLines(out[file].split('\n'), ops).join('\n')
  }
  return out
}

// A compact, human-readable recap: "index.html · line 14 · app.js · lines 3–5".
export function describeEdits(ordered: LineEdit[]): string {
  const span = (op: LineEdit) =>
    op.op === 'insert'
      ? `after line ${op.after}`
      : op.start === op.end
        ? `line ${op.start}`
        : `lines ${op.start}–${op.end}`
  const byFile = new Map<string, string[]>()
  for (const op of [...ordered].reverse()) {
    // reversed → top-to-bottom reading order
    const list = byFile.get(op.file) ?? []
    list.push(span(op))
    byFile.set(op.file, list)
  }
  return [...byFile.entries()].map(([file, spans]) => `${file} · ${spans.join(', ')}`).join(' · ')
}
