// Helpers for the multi-file project workspace: path rules, the explorer tree,
// and assembling the sandboxed preview from index.html + supporting files.

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

  const open = (path: string) => {
    current = path
    heldBlanks = ''
    // Every marker promises the file's complete contents, so restart it even
    // if this path already streamed once (a re-emit replaces, never doubles).
    target.reset(path)
    target.onFile?.(path)
  }

  const handleLine = (line: string) => {
    const marker = line.match(FILE_MARKER_RE)
    if (marker) {
      const path = normalizePath(marker[1])
      if (path) open(path)
      // Unusable path — drop the marker line rather than writing it as code.
      return
    }
    if (current === null) {
      if (!line.trim()) return // leading blank lines belong to no file
      if (!summarySkipped && SUMMARY_LINE_RE.test(line)) {
        summarySkipped = true // the summary comment is chat metadata, not code
        return
      }
      open(INDEX_FILE) // no marker yet → single-document fallback
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
