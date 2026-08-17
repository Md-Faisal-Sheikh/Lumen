// ── The Python runtime ──────────────────────────────────────────────
//
// Lumen has no container and no server-side execution, so "run this Python" has
// exactly one honest answer available to it: run CPython in the browser. Pyodide
// is CPython 3 compiled to WebAssembly, and it loads into the *same* sandboxed
// iframe the web preview already uses — no new origin, no new trust boundary, no
// server process, nothing to install.
//
// What this file produces is a complete HTML document: a console UI, a loader,
// and the glue that puts the project's files into Pyodide's virtual filesystem
// and runs the entry module. It is handed to the same `srcDoc` iframe that runs
// web projects, with the same sandbox flags, which is what keeps the two
// runtimes from needing two security stories.
//
// Three consequences of that choice are worth knowing, because they shape the
// code below:
//
//   · The interpreter is a ~10 MB download on first run and cached by the
//     browser afterwards. That gap is long enough that a silent spinner reads as
//     a hang, so loading is narrated rather than hidden.
//   · Pyodide runs on the iframe's main thread. An unbounded loop wedges *this
//     frame* — the surrounding Lumen UI stays responsive, and re-running
//     replaces the frame outright, which is the escape hatch. The build prompt
//     also tells the model not to write one.
//   · There is no network and no host filesystem. `open()` reads and writes
//     Pyodide's in-memory FS, which is discarded when the frame is replaced.

/** Pinned rather than floating: a runtime that silently changes version under a
 *  project is a debugging problem nobody would think to look for. */
export const PYODIDE_VERSION = 'v314.0.4'
export const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`

/** Where the project's files are mounted inside the interpreter. */
const PROJECT_DIR = '/project'

/**
 * How long to wait for imported packages to download before running anyway.
 *
 * Generous, because the thing being waited on is a multi-megabyte wheel on
 * whatever connection the user has — but bounded, because the alternative to a
 * bound is a console that says "Resolving imports…" indefinitely and never
 * reaches the program at all. Running late beats not running.
 */
const PACKAGE_TIMEOUT_MS = 90_000

// A `</script>` inside a Python string literal would close the block that holds
// the project data and drop the rest of the file into the document as markup.
// JSON's `\/` escape means the payload survives being read back verbatim.
const embedJson = (value: unknown) => JSON.stringify(value).replace(/<\//g, '<\\/')

const CONSOLE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #0a0810;
    color: #e6e3f2;
    font: 13px/1.65 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 9px;
    padding: 9px 14px; flex: none;
    border-bottom: 1px solid rgba(176, 156, 255, 0.13);
    background: rgba(255, 255, 255, 0.025);
    font-size: 11.5px; letter-spacing: 0.02em; color: #9a95b8;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #6b6482; flex: none; }
  .dot.load { background: #f0a868; animation: pulse 1.1s ease-in-out infinite; }
  .dot.run  { background: #38e0d8; animation: pulse 0.9s ease-in-out infinite; }
  .dot.ok   { background: #5ef0b6; }
  .dot.err  { background: #ef6a6a; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.28; } }
  header b { color: #cfcae4; font-weight: 550; }
  header .ver { margin-left: auto; opacity: 0.5; font-size: 10.5px; }
  main {
    flex: 1; overflow: auto; padding: 12px 14px 22px;
    white-space: pre-wrap; word-break: break-word;
    scrollbar-width: thin; scrollbar-color: rgba(176, 156, 255, 0.22) transparent;
  }
  .out { color: #e6e3f2; }
  .err { color: #ff9d9d; }
  .sys { color: #7d7796; font-style: italic; }
  .trace {
    display: block; margin: 10px 0 2px; padding: 11px 13px;
    border-left: 2px solid #ef6a6a; border-radius: 0 8px 8px 0;
    background: rgba(239, 106, 106, 0.09); color: #ffb4b4;
  }
  .done {
    display: block; margin-top: 14px; padding-top: 11px;
    border-top: 1px dashed rgba(176, 156, 255, 0.18);
    color: #7d7796; font-size: 11.5px;
  }
  .done.bad { color: #ef8a8a; }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
`

/**
 * Build the document that runs a Python project.
 *
 * `files` is every file in the workspace keyed by path, entry module included —
 * not just the `.py` ones, because a program that reads `data.csv` should find
 * it where it put it.
 */
export function buildPythonRunner(files: Record<string, string>, entry: string): string {
  const sources = Object.entries(files)
    .filter(([path]) => /\.py$/i.test(path))
    .map(([, content]) => content)
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Python</title>
<style>${CONSOLE_CSS}</style>
</head>
<body>
<header>
  <span class="dot load" id="dot"></span>
  <b id="status">Starting Python…</b>
  <span class="ver">CPython · Pyodide ${PYODIDE_VERSION}</span>
</header>
<main id="out"></main>

<script id="lumen-files" type="application/json">${embedJson(files)}</script>
<script id="lumen-config" type="application/json">${embedJson({ entry, sources, dir: PROJECT_DIR })}</script>
<script src="${PYODIDE_CDN}pyodide.js"></script>
<script>
(function () {
  var out = document.getElementById('out')
  var dot = document.getElementById('dot')
  var statusEl = document.getElementById('status')
  var files = JSON.parse(document.getElementById('lumen-files').textContent)
  var cfg = JSON.parse(document.getElementById('lumen-config').textContent)
  var started = Date.now()

  // Appending a text node per write keeps a program that prints in a loop from
  // re-parsing the whole console on every line.
  function write(text, cls) {
    var span = document.createElement('span')
    span.className = cls || 'out'
    span.appendChild(document.createTextNode(text))
    out.appendChild(span)
    // Only follow the tail when the reader is already at it, so scrolling back
    // through output isn't yanked away by the next print().
    var nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60
    if (nearBottom) out.scrollTop = out.scrollHeight
  }

  function status(text, cls) {
    statusEl.textContent = text
    dot.className = 'dot ' + cls
  }

  // Tell the parent what happened, so Lumen can show a state without having to
  // reach into a frame it deliberately has no same-origin access to.
  function report(state, detail) {
    try {
      parent.postMessage({ lumen: 'python-state', state: state, detail: detail || null }, '*')
    } catch (e) { /* the parent went away; nothing to do about it */ }
  }

  function elapsed() {
    var ms = Date.now() - started
    return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'
  }

  // Pyodide's traceback starts inside its own machinery — eval_code_async,
  // CodeRunner.run_async, then runpy's frames — and only then reaches the user's
  // code. Six frames of somebody else's stack above "ZeroDivisionError" makes a
  // one-line bug look like a bug in the runtime, so everything above the first
  // frame in the project is dropped. If no project frame appears, the error came
  // from the harness and the whole thing is worth showing.
  function cleanTraceback(text) {
    var lines = String(text).split('\\n')
    var first = -1
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('File "' + cfg.dir + '/') >= 0) { first = i; break }
    }
    if (first < 0) return text
    return 'Traceback (most recent call last):\\n' + lines.slice(first).join('\\n')
  }

  function finish(ok, note) {
    var el = document.createElement('span')
    el.className = 'done' + (ok ? '' : ' bad')
    el.textContent = note
    out.appendChild(el)
    out.scrollTop = out.scrollHeight
    status(ok ? 'Finished' : 'Stopped on an error', ok ? 'ok' : 'err')
    report(ok ? 'done' : 'error', note)
  }

  // Write the workspace into the interpreter's virtual filesystem at its real
  // paths, creating directories as it goes — so "from board import Board" and
  // open('data/seed.txt') both resolve exactly as they would on disk.
  function mount(pyodide) {
    var FS = pyodide.FS
    try { FS.mkdir(cfg.dir) } catch (e) { /* already there */ }
    Object.keys(files).forEach(function (path) {
      var parts = path.split('/')
      var dir = cfg.dir
      for (var i = 0; i < parts.length - 1; i++) {
        dir += '/' + parts[i]
        try { FS.mkdir(dir) } catch (e) { /* already there */ }
      }
      FS.writeFile(cfg.dir + '/' + path, files[path], { encoding: 'utf8' })
    })
  }

  async function main() {
    if (typeof loadPyodide !== 'function') {
      status('Python could not be loaded', 'err')
      write(
        "Couldn't download the Python runtime.\\n\\n" +
        'It is fetched from ${PYODIDE_CDN.replace(/'/g, "\\'")} the first time you run a\\n' +
        'Python project, so this needs a working connection. After that it is cached\\n' +
        'by the browser and runs offline.',
        'err'
      )
      report('error', 'runtime-unavailable')
      return
    }

    var pyodide
    try {
      status('Downloading Python… (first run only)', 'load')
      pyodide = await loadPyodide({ indexURL: '${PYODIDE_CDN}' })
    } catch (err) {
      status('Python could not be loaded', 'err')
      write('Failed to start the Python runtime:\\n' + (err && err.message ? err.message : String(err)), 'err')
      report('error', 'runtime-failed')
      return
    }

    pyodide.setStdout({ batched: function (s) { write(s + '\\n') } })
    pyodide.setStderr({ batched: function (s) { write(s + '\\n', 'err') } })
    // input() blocks on a modal, which the sandbox permits. Cancelling it raises
    // EOFError in Python rather than silently feeding the program an empty line.
    pyodide.setStdin({
      stdin: function () {
        var value = window.prompt('Input requested by the program:')
        return value === null ? null : value
      },
    })

    try {
      mount(pyodide)
    } catch (err) {
      status('Could not prepare the files', 'err')
      write('Failed to write the project files:\\n' + (err && err.message ? err.message : String(err)), 'err')
      report('error', 'mount-failed')
      return
    }

    // Packages named by an import are fetched from the Pyodide distribution
    // before the program runs — numpy, pandas, sympy and friends work without
    // anyone installing anything. A package that isn't in the distribution is
    // not an error here; it becomes an ordinary ImportError below, which is a
    // far clearer message than a failed download.
    // Packages named by an import are fetched from the Pyodide distribution
    // before the program runs — numpy, pandas, sympy and friends work without
    // anyone installing anything.
    //
    // Two things can go wrong and neither may be allowed to end the run here.
    // A package that isn't in the distribution throws, and a fetch that stalls
    // never settles at all — and an un-raced await on that second case leaves
    // the console sitting on "Resolving imports…" with no output and no error,
    // forever. Both are therefore bounded and then ignored: the program runs
    // regardless, and a missing module surfaces as an ordinary ImportError,
    // which names the module and points at the line that wanted it.
    try {
      status('Resolving imports…', 'load')
      // Narrated rather than swallowed. numpy is several megabytes, and a silent
      // wait on a slow connection is indistinguishable from a hang.
      var loading = pyodide.loadPackagesFromImports(cfg.sources, {
        messageCallback: function (msg) {
          if (msg) write(msg + '\\n', 'sys')
        },
        errorCallback: function () {},
      })
      var timedOut = false
      await Promise.race([
        loading,
        new Promise(function (resolve) {
          setTimeout(function () { timedOut = true; resolve(null) }, ${PACKAGE_TIMEOUT_MS})
        }),
      ])
      if (timedOut) {
        write(
          'Gave up waiting for a package to download after ${Math.round(PACKAGE_TIMEOUT_MS / 1000)}s — running anyway.\\n',
          'sys'
        )
      }
    } catch (e) { /* fall through to the ImportError */ }

    status('Running ' + cfg.entry, 'run')
    started = Date.now()

    try {
      // run_path with run_name='__main__' is what makes the conventional
      // "if __name__ == '__main__':" guard fire, and puts the project directory
      // on sys.path so sibling modules import normally.
      await pyodide.runPythonAsync(
        'import sys, runpy\\n' +
        'sys.path.insert(0, ' + JSON.stringify(cfg.dir) + ')\\n' +
        'runpy.run_path(' + JSON.stringify(cfg.dir + '/' + cfg.entry) + ", run_name='__main__')\\n"
      )
      finish(true, '— ' + cfg.entry + ' finished in ' + elapsed())
    } catch (err) {
      // A PythonError's message is already the formatted traceback; anything
      // else is a JavaScript-side failure and is shown as-is.
      var text = err && err.message ? cleanTraceback(err.message) : String(err)
      var trace = document.createElement('span')
      trace.className = 'trace'
      trace.appendChild(document.createTextNode(text.replace(/\\s+$/, '')))
      out.appendChild(trace)
      finish(false, '— ' + cfg.entry + ' stopped after ' + elapsed())
    }
  }

  main()
})()
</script>
</body>
</html>`
}

/** The message a Python frame posts back as it moves through its states. */
export const PYTHON_STATE_MESSAGE = 'python-state'

export type PythonState = 'done' | 'error'

/** The placeholder shown before anything has been run. */
export function pythonIdleDocument(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><style>${CONSOLE_CSS}</style></head>
<body>
<header><span class="dot"></span><b>Idle</b><span class="ver">CPython · Pyodide ${PYODIDE_VERSION}</span></header>
<main><span class="sys">Press Run to execute this project.</span></main>
</body>
</html>`
}
