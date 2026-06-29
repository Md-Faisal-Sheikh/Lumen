import { useEffect, useRef } from 'react'
import type * as Y from 'yjs'
import { EditorState } from '@codemirror/state'
import { EditorView, basicSetup } from 'codemirror'
import { html } from '@codemirror/lang-html'
import { oneDark } from '@codemirror/theme-one-dark'
import { yCollab } from 'y-codemirror.next'

// A real collaborative editor: text and remote cursors both flow through Yjs.
export function CodeEditor({ ytext, awareness }: { ytext: Y.Text; awareness: any }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        html(),
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
  }, [ytext, awareness])

  return <div className="cm-host" ref={host} />
}
