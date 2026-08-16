// Helpers for the multi-file project workspace: path rules, the explorer tree,
// and assembling the sandboxed preview from index.html + supporting files.

import type * as Y from 'yjs'
import type { ZipEntry } from './zip'

export const INDEX_FILE = 'index.html'

// Clean a user-typed path: forward slashes, no leading slash, no "..", sane charset.
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
  if (!/\.[A-Za-z0-9]+$/.test(file)) return null // require an extension
  return parts.join('/')
}

export type TreeNode =
  | { type: 'folder'; name: string; path: string; children: TreeNode[] }
  | { type: 'file'; name: string; path: string }

// Turn flat paths into a nested tree: folders first, then files, alphabetical —
// except index.html, which is pinned to the top as the app's entry point.
export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = []
  const folders = new Map<string, TreeNode[]>() // folder path -> children array

  const childrenOf = (folderPath: string): TreeNode[] => {
    if (!folderPath) return root
    let kids = folders.get(folderPath)
    if (!kids) {
      const idx = folderPath.lastIndexOf('/')
      const parentKids = childrenOf(idx < 0 ? '' : folderPath.slice(0, idx))
      kids = []
      folders.set(folderPath, kids)
      parentKids.push({ type: 'folder', name: folderPath.slice(idx + 1), path: folderPath, children: kids })
    }
    return kids
  }

  for (const path of paths) {
    const idx = path.lastIndexOf('/')
    const dir = idx < 0 ? '' : path.slice(0, idx)
    childrenOf(dir).push({ type: 'file', name: path.slice(idx + 1), path })
  }

  const sortLevel = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.path === INDEX_FILE) return -1
      if (b.path === INDEX_FILE) return 1
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const n of nodes) if (n.type === 'folder') sortLevel(n.children)
  }
  sortLevel(root)
  return root
}

// Starter content for a freshly created file.
export function starterContent(path: string): string {
  if (/\.css$/i.test(path)) return `/* ${path} */\n`
  if (/\.(m?js|jsx|ts|tsx)$/i.test(path)) return `// ${path}\n`
  if (/\.html?$/i.test(path))
    return `<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8" />\n  <title>${path}</title>\n</head>\n<body>\n\n</body>\n</html>\n`
  return ''
}

// ── AI build stream: multi-file marker format ───────────────────────
// The model emits every generated file as a section that starts with a
// marker line: `===== FILE: path =====`. Everything until the next marker
// (or the end of the stream) is that file's contents.

const FILE_MARKER_RE = /^\s*={3,}\s*FILE:\s*(.+?)\s*={3,}\s*$/
const SUMMARY_LINE_RE = /^\s*<!--\s*SUMMARY\b/i
// A line that is nothing but a markdown fence, with an optional language tag.
const FENCE_RE = /^\s*(?:```|~~~)\s*([A-Za-z0-9+#.-]*)\s*$/

// Which file a fenced block belongs in. Smaller models — the vision models a
// sketch build runs on, in particular — ignore the marker protocol and answer
// in markdown instead, but they still split the project correctly and label
// each block with its language. That is the same information under a different
// name, so it is read rather than thrown away.
function pathForLanguage(lang: string): string | null {
  switch (lang.toLowerCase()) {
    case 'html':
    case 'htm':
      return INDEX_FILE
    case 'css':
      return 'styles.css'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'javascript':
      return 'app.js'
    default:
      return null
  }
}

// Serialize the whole workspace in the same marker format, so a rebuild can
// hand the model every current file to modify.
export function serializeWorkspace(indexHtml: string, files: Record<string, string>): string {
  const section = (path: string, content: string) => `===== FILE: ${path} =====\n${content.replace(/\s+$/, '')}\n`
  const parts = [section(INDEX_FILE, indexHtml)]
  for (const [path, content] of Object.entries(files)) parts.push(section(path, content))
  return parts.join('\n')
}

export interface BuildWriter {
  /** Feed a chunk of streamed model output. Call inside one Yjs transaction. */
  push(chunk: string): void
  /** Flush any trailing partial line once the stream ends. */
  end(): void
}

// Incrementally split the streamed output into files. Lines are the unit of
// work: a complete line is either a FILE marker (switch/reset target) or
// content appended to the current file. The trailing partial line is held
// back until its newline arrives, so a marker split across network chunks
// can never leak into a file as content.
export function createBuildWriter(target: {
  /** Start (or restart) a file with empty contents. */
  reset: (path: string) => void
  /** Append text to a file. */
  append: (path: string, text: string) => void
  /** A new file section just began. */
  onFile?: (path: string) => void
}): BuildWriter {
  let carry = ''
  let current: string | null = null // null until the first marker/content arrives
  let summarySkipped = false
  let heldBlanks = '' // blank lines withheld until we know they're interior, not section separators
  // Which shape the response turned out to be, decided by its first real line
  // and never revisited. A model that used the markers is read as before; one
  // that answered in markdown has its fences read as section boundaries. Fixing
  // the protocol once, up front, is what keeps a stray ``` inside a *generated*
  // app — a markdown editor's sample text, say — from being mistaken for one.
  let protocol: 'unknown' | 'marker' | 'fence' | 'plain' = 'unknown'
  let insideFence = false
  let openedAny = false

  const open = (path: string) => {
    current = path
    openedAny = true
    heldBlanks = ''
    // Every marker promises the file's complete contents, so restart it even
    // if this path already streamed once (a re-emit replaces, never doubles).
    target.reset(path)
    target.onFile?.(path)
  }

  const handleLine = (line: string) => {
    const marker = line.match(FILE_MARKER_RE)
    if (marker) {
      protocol = 'marker'
      const path = normalizePath(marker[1])
      if (path) open(path)
      // Unusable path — drop the marker line rather than writing it as code.
      return
    }

    // The summary is chat metadata, not code. By protocol it is the response's
    // very first line, ahead of any file — but a model that answers in markdown
    // puts it *inside* the first block instead, where it would be written into
    // index.html and shipped in the exported ZIP. Drop the first one wherever
    // it lands; a later one belongs to the generated app.
    if (!summarySkipped && SUMMARY_LINE_RE.test(line)) {
      summarySkipped = true
      return
    }

    if (protocol === 'unknown' || protocol === 'fence') {
      const fence = line.match(FENCE_RE)
      if (fence) {
        protocol = 'fence'
        if (insideFence) {
          insideFence = false
          current = null // between blocks until the next fence opens a file
        } else {
          insideFence = true
          // An unlabelled *first* block is the whole document. An unlabelled
          // later one can't be placed — appending it to whichever file happens
          // to be open would corrupt that file, so it is dropped instead.
          const path = pathForLanguage(fence[1]) ?? (openedAny ? null : INDEX_FILE)
          if (path) open(path)
          else current = null
        }
        return
      }
      // In a markdown answer, `current === null` means either the model's prose
      // between blocks ("Here's the CSS:") or a block we couldn't place.
      if (protocol === 'fence' && current === null) return
    }

    if (current === null) {
      if (!line.trim()) return // leading blank lines belong to no file
      if (protocol === 'unknown') {
        // Still deciding. A line that isn't a marker, a fence, or the start of
        // markup is the model clearing its throat — "Sure! Here's the page:".
        // Committing to the single-document shape on it would write the chatter
        // into index.html *and* make the fences that follow look like content.
        if (!/^\s*</.test(line)) return
        protocol = 'plain'
      }
      open(INDEX_FILE) // markup with no marker and no fence: a single document
    }
    if (!line.trim()) {
      heldBlanks += line // flushed only if real content follows in the same file
      return
    }
    if (heldBlanks) {
      target.append(current!, heldBlanks)
      heldBlanks = ''
    }
    target.append(current!, line)
  }

  return {
    push(chunk: string) {
      carry += chunk
      let nl: number
      while ((nl = carry.indexOf('\n')) >= 0) {
        handleLine(carry.slice(0, nl + 1))
        carry = carry.slice(nl + 1)
      }
    },
    end() {
      if (carry) {
        handleLine(carry)
        carry = ''
      }
    },
  }
}

// ── Line-level edits ("change line 14 in index.html") ───────────────
// The server turns such prompts into validated REPLACE / INSERT / DELETE line
// operations (already ordered bottom-up per file); we apply exactly those to
// the shared Yjs files, so untouched lines are never regenerated.

export type LineEdit =
  | { op: 'replace'; file: string; start: number; end: number; content: string }
  | { op: 'insert'; file: string; after: number; content: string }
  | { op: 'delete'; file: string; start: number; end: number }

// Does the prompt reference specific line numbers? ("change line 14 …",
// "update lines 3-5", "delete line #7"). Digit-first phrases like "add 3 lines
// of text" deliberately do NOT match — those stay normal build requests.
const LINE_EDIT_RE = /\blines?\s*(?:#|no\.?|number)?\s*\d+/i
export const isLineEditPrompt = (prompt: string) => LINE_EDIT_RE.test(prompt)

const spliceIndex = (op: LineEdit) => (op.op === 'insert' ? op.after : op.start - 1)
const spliceCount = (op: LineEdit) => (op.op === 'insert' ? 0 : op.end - op.start + 1)

// Apply one file's ordered ops to its current content. Bounds are clamped:
// the ops were validated against a snapshot, and a collaborator may have
// typed since it was taken.
export function applyOpsToContent(content: string, ops: LineEdit[]): string {
  const lines = content.split('\n')
  for (const op of ops) {
    const index = Math.max(0, Math.min(spliceIndex(op), lines.length))
    const count = Math.max(0, Math.min(spliceCount(op), lines.length - index))
    const body = op.op === 'delete' ? '' : op.content
    lines.splice(index, count, ...(body === '' ? [] : body.split('\n')))
  }
  return lines.join('\n')
}

// Move a Y.Text to new content by replacing only the changed middle span
// (common prefix/suffix left untouched), so collaborators' cursors and
// concurrent edits elsewhere in the file survive the change.
export function replaceTextRanged(t: Y.Text, next: string) {
  const prev = t.toString()
  if (prev === next) return
  let head = 0
  const maxHead = Math.min(prev.length, next.length)
  while (head < maxHead && prev[head] === next[head]) head++
  let tail = 0
  const maxTail = Math.min(prev.length, next.length) - head
  while (tail < maxTail && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++
  t.delete(head, prev.length - head - tail)
  const middle = next.slice(head, next.length - tail)
  if (middle) t.insert(head, middle)
}

// Map an href/src to a workspace file, or null if it's external.
function resolveLocal(ref: string, files: Record<string, string>): string | null {
  if (/^(https?:)?\/\//i.test(ref) || /^(data|blob):/i.test(ref)) return null
  const clean = ref.replace(/^\.\//, '').replace(/^\/+/, '').split(/[?#]/)[0]
  return clean in files ? clean : null
}

// Inline local <link rel="stylesheet"> and <script src> references into the
// document so the whole multi-file project runs inside one sandboxed iframe.
export function assemblePreview(indexHtml: string, files: Record<string, string>): string {
  if (!indexHtml || Object.keys(files).length === 0) return indexHtml

  let out = indexHtml.replace(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/gi, (tag, href: string) => {
    const key = resolveLocal(href, files)
    if (key === null || !/\.css$/i.test(key)) return tag
    // Only inline actual stylesheets: skip links whose rel is something else.
    const rel = tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const relValue = rel ? (rel[1] ?? rel[2] ?? rel[3] ?? '') : ''
    if (rel && !/\bstylesheet\b/i.test(relValue)) return tag
    return `<style>\n${files[key]}\n</style>`
  })

  out = out.replace(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src: string) => {
    const key = resolveLocal(src, files)
    if (key === null) return tag
    return `<script>\n${files[key].replace(/<\/script/gi, '<\\/script')}\n</script>`
  })

  return out
}

// ── Export ──────────────────────────────────────────────────────────
// The preview inlines everything into one document, but the project on disk is
// the real thing: separate files at their real paths. These build that list for
// the ZIP writer — nothing is merged, rewritten, or flattened.

// index.html first (it's the page you open), then every other file by path.
// Sorted by code unit rather than locale so the archive is byte-deterministic.
// Empty files are kept: a file someone created is part of their project.
export function exportEntries(indexHtml: string, files: Record<string, string>): ZipEntry[] {
  const entries: ZipEntry[] = []
  if (indexHtml.trim()) entries.push({ path: INDEX_FILE, content: indexHtml })
  for (const path of Object.keys(files).filter((p) => p !== INDEX_FILE).sort()) {
    entries.push({ path, content: files[path] })
  }
  return entries
}

// "My First Project" → "my-first-project.zip"
export function exportFileName(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return `${slug || 'lumen-project'}.zip`
}
