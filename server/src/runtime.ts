// ── Runtimes ────────────────────────────────────────────────────────
//
// Which engine executes a project's code. Lumen started as one runtime and the
// assumption was everywhere — `index.html` was hard-coded as *the* entry file in
// the build prompt, the preview, the exporter and the GitHub push. This module
// is where that assumption now lives, so adding a third runtime is a matter of
// adding a row here and a prompt in ai.ts rather than hunting for string
// literals.
//
//   web    — static HTML/CSS/JS, assembled into one document and run in a
//            sandboxed iframe. The original, and still the default.
//   python — CPython 3 compiled to WebAssembly (Pyodide), loaded inside that
//            same sandboxed iframe. Real Python, no container, no server-side
//            execution: the interpreter is a download the browser runs.

export type Runtime = 'web' | 'python'

export const RUNTIMES: readonly Runtime[] = ['web', 'python']

export const DEFAULT_RUNTIME: Runtime = 'web'

export const isRuntime = (v: unknown): v is Runtime => v === 'web' || v === 'python'

/** Read a runtime off untrusted input, falling back to the default. */
export const asRuntime = (v: unknown): Runtime => (isRuntime(v) ? v : DEFAULT_RUNTIME)

/**
 * The file that gets run.
 *
 * For the web runtime this is the page the browser opens; for Python it is the
 * module the interpreter executes. Both are stored in the same place in the Yjs
 * document (the `code` Y.Text), which is what lets every feature built on top —
 * streaming builds, version snapshots, the ZIP export, the GitHub commit — stay
 * runtime-agnostic.
 */
const ENTRY: Record<Runtime, string> = {
  web: 'index.html',
  python: 'main.py',
}

export const entryFile = (runtime: Runtime): string => ENTRY[runtime] ?? ENTRY.web

/** Human label for the runtime, used in errors and the UI. */
export const runtimeLabel = (runtime: Runtime): string => (runtime === 'python' ? 'Python' : 'Web')
