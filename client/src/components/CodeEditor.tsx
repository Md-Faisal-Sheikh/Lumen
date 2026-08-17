import { useCallback, useEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { EditorState, Prec, StateEffect, StateField } from '@codemirror/state'
import { EditorView, basicSetup } from 'codemirror'
import { Decoration, keymap, type DecorationSet } from '@codemirror/view'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { yCollab } from 'y-codemirror.next'
import { inlineCompletion, type CompletionRequest } from '../ghost'
import { Send, Spark } from '../icons'

// Pick a CodeMirror language by file extension (html covers unknown files too).
function languageFor(path: string) {
  if (/\.css$/i.test(path)) return css()
  if (/\.(ts|tsx)$/i.test(path)) return javascript({ typescript: true, jsx: /x$/i.test(path) })
  if (/\.(m?js|jsx)$/i.test(path)) return javascript({ jsx: /x$/i.test(path) })
  if (/\.json$/i.test(path)) return javascript()
  return html()
}

// ── The span the inline prompt is aimed at ──────────────────────────
// Highlighting it is not decoration: while the prompt is open the editor has
// lost focus, so the native selection fades and the user would otherwise have
// no idea which lines they are about to hand to the model.
const setTarget = StateEffect.define<{ from: number; to: number } | null>()

const targetField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes) // follow collaborators' edits above the span
    for (const e of tr.effects) {
      if (!e.is(setTarget)) continue
      deco =
        e.value && e.value.to > e.value.from
          ? Decoration.set([Decoration.mark({ class: 'cm-ai-target' }).range(e.value.from, e.value.to)])
          : Decoration.none
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

interface PromptState {
  start: number // 1-based first line of the selection
  end: number // 1-based last line, inclusive
  top: number
  left: number
}

// A real collaborative editor: text and remote cursors both flow through Yjs.
// Ctrl/Cmd-K opens an inline prompt over the selection — because the exact line
// range is known, the request goes straight to the model as bounds instead of
// being inferred from the wording.
export function CodeEditor({
  ytext,
  awareness,
  path = 'index.html',
  onInlineEdit,
  onComplete,
  suggestions = false,
}: {
  ytext: Y.Text
  awareness: any
  path?: string
  /** Rewrite lines start..end of this file. Rejects if the edit fails, so the prompt can stay open. */
  onInlineEdit?: (file: string, start: number, end: number, instruction: string) => Promise<void>
  /** Ask for the text that belongs at the caret. Resolve null for no suggestion. */
  onComplete?: (req: CompletionRequest) => Promise<string | null>
  /** Whether ghost text is switched on right now. */
  suggestions?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  // The keymap is baked into the editor once, so it reads the current handler
  // through a ref rather than closing over a stale prop.
  const editRef = useRef(onInlineEdit)
  editRef.current = onInlineEdit

  // Same reason, and one more: these are read on every completion trigger rather
  // than captured when the editor mounts, so toggling suggestions off stops them
  // immediately instead of tearing down and rebuilding the editor — which would
  // drop the user's scroll position, undo history, and collaborative cursors.
  const completeRef = useRef(onComplete)
  completeRef.current = onComplete
  const suggestRef = useRef(suggestions)
  suggestRef.current = suggestions
  const pathRef = useRef(path)
  pathRef.current = path

  // Open the prompt over the selection, snapped out to whole lines.
  const openPrompt = useCallback((view: EditorView) => {
    if (!editRef.current) return false
    const sel = view.state.selection.main
    const first = view.state.doc.lineAt(sel.from)
    const last = view.state.doc.lineAt(sel.to)
    const rect = host.current?.getBoundingClientRect()
    const coords = view.coordsAtPos(first.from)
    if (!rect || !coords) return true // off-screen: swallow the key rather than misplace the box
    view.dispatch({ effects: setTarget.of({ from: first.from, to: last.to }) })
    setValue('')
    setPrompt({
      start: first.number,
      end: last.number,
      top: Math.max(6, coords.bottom - rect.top + 6),
      left: Math.min(Math.max(8, coords.left - rect.left), Math.max(8, rect.width - 348)),
    })
    return true
  }, [])

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        languageFor(path),
        oneDark,
        yCollab(ytext, awareness),
        targetField,
        // Ghost text. Mounted unconditionally and gated on the ref above, so the
        // toggle never remounts the editor.
        inlineCompletion({
          enabled: () => suggestRef.current && !!completeRef.current,
          file: () => pathRef.current,
          fetch: (req) => completeRef.current?.(req) ?? Promise.resolve(null),
        }),
        // Highest precedence: the browser and CodeMirror both want Mod-k.
        Prec.highest(keymap.of([{ key: 'Mod-k', preventDefault: true, run: openPrompt }])),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: 'transparent' },
          '.cm-scroller': { fontFamily: 'var(--font-mono)' },
        }),
      ],
    })
    const view = new EditorView({ state, parent: host.current })
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [ytext, awareness, path, openPrompt])

  useEffect(() => {
    if (prompt) inputRef.current?.focus()
  }, [prompt])

  const close = useCallback(() => {
    setPrompt(null)
    setValue('')
    setBusy(false)
    const view = viewRef.current
    if (view) {
      view.dispatch({ effects: setTarget.of(null) })
      view.focus()
    }
  }, [])

  const submit = async () => {
    const instruction = value.trim()
    if (!instruction || !prompt || busy || !editRef.current) return
    setBusy(true)
    try {
      await editRef.current(path, prompt.start, prompt.end, instruction)
      close()
    } catch {
      // The caller reports the reason; keep the prompt open so it can be reworded.
      setBusy(false)
    }
  }

  const span = prompt && (prompt.start === prompt.end ? `Line ${prompt.start}` : `Lines ${prompt.start}–${prompt.end}`)

  return (
    <div className="cm-host">
      <div className="cm-mount" ref={host} />
      {prompt && (
        <div
          className={`ai-prompt ${busy ? 'busy' : ''}`}
          style={{ top: prompt.top, left: prompt.left }}
          role="dialog"
          aria-label="Edit the selected lines with Lumen"
        >
          <div className="aip-head">
            <Spark width={12} height={12} />
            <span className="aip-span">{span}</span>
            <span className="aip-file">{path}</span>
          </div>
          <div className="aip-row">
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  close()
                }
              }}
              placeholder="Rewrite this as…"
              disabled={busy}
              spellCheck={false}
            />
            <button className="aip-go" onClick={submit} disabled={busy || !value.trim()} aria-label="Apply this edit">
              {busy ? <span className="aip-spin" /> : <Send width={14} height={14} />}
            </button>
          </div>
          <div className="aip-hint">{busy ? 'Rewriting your selection…' : 'Enter to apply · Esc to cancel'}</div>
        </div>
      )}
    </div>
  )
}
