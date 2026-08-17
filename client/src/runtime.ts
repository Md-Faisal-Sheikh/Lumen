// Which engine runs a project's code. Mirrors server/src/runtime.ts — the two
// halves can't share a module (separate tsconfigs, separate bundles), so the
// contract is the string values, and the entry-file table is the part that must
// not drift. A mismatch here would mean the build prompt writes main.py while
// the editor is looking at index.html.

export type Runtime = 'web' | 'python'

export const RUNTIMES: readonly Runtime[] = ['web', 'python']

export const DEFAULT_RUNTIME: Runtime = 'web'

export const isRuntime = (v: unknown): v is Runtime => v === 'web' || v === 'python'

export const asRuntime = (v: unknown): Runtime => (isRuntime(v) ? v : DEFAULT_RUNTIME)

/** The file that gets run: the page the browser opens, or the module Python executes. */
export const entryFile = (runtime: Runtime): string => (runtime === 'python' ? 'main.py' : 'index.html')

export const runtimeLabel = (runtime: Runtime): string => (runtime === 'python' ? 'Python' : 'Web')

/** One line for the runtime picker, explaining what you get. */
export const runtimeBlurb = (runtime: Runtime): string =>
  runtime === 'python'
    ? 'Real CPython in the browser. Output goes to a console.'
    : 'HTML, CSS and JavaScript, running live in a preview.'
