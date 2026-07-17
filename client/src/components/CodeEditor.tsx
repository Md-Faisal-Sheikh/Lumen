import { useEffect, useRef } from 'react'
import type * as Y from 'yjs'
import { EditorState } from '@codemirror/state'
import { EditorView, basicSetup } from 'codemirror'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { yCollab } from 'y-codemirror.next'

// Pick a CodeMirror language by file extension (html covers unknown files too).
function languageFor(path: string) {
  if (/\.css$/i.test(path)) return css()
  if (/\.(ts|tsx)$/i.test(path)) return javascript({ typescript: true, jsx: /x$/i.test(path) })
  if (/\.(m?js|jsx)$/i.test(path)) return javascript({ jsx: /x$/i.test(path) })
  if (/\.json$/i.test(path)) return javascript()
  return html()
}

// A real collaborative editor: text and remote cursors both flow through Yjs.
export function CodeEditor({ ytext, awareness, path = 'index.html' }: { ytext: Y.Text; awareness: any; path?: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        languageFor(path),
        oneDark,
        yCollab(ytext, awareness),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: 'transparent' },
          '.cm-scroller': { fontFamily: 'var(--font-mono)' },
        }),
      ],
    })
    const view = new EditorView({ state, parent: host.current })
    return () => view.destroy()
  }, [ytext, awareness, path])

  return <div className="cm-host" ref={host} />
}
