import { useEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { CodeEditor } from './CodeEditor'
import { Cursors } from './Cursors'
import { CodeIcon, EyeIcon, FileIcon, Play, Pointer, Refresh, Spark, Terminal } from '../icons'
import type { CompletionRequest } from '../ghost'
import { PICK_CANCELLED, PICK_MESSAGE, PICKED_MESSAGE, type PickedElement } from '../picker'
import { PYTHON_STATE_MESSAGE } from '../python'
import type { Runtime } from '../runtime'

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export function PreviewPane({
  tab,
  onTab,
  previewCode,
  runtime,
  runNonce,
  building,
  builderName,
  activeFile,
  activeText,
  awareness,
  onRun,
  onInlineEdit,
  onComplete,
  suggestions,
  picking,
  onPicking,
  onPick,
}: {
  tab: 'preview' | 'code'
  onTab: (t: 'preview' | 'code') => void
  previewCode: string
  /** Which engine runs this project — decides what the left tab is and does. */
  runtime: Runtime
  /**
   * Bumped on every explicit Run. The preview iframe is keyed on it, which is
   * what makes Run *restart* a Python program rather than leaving the finished
   * one on screen — and it is also the escape hatch from a program that hangs,
   * since remounting the frame destroys the interpreter along with it.
   */
  runNonce: number
  building: boolean
  builderName?: string
  activeFile: string
  activeText: Y.Text
  awareness: any
  onRun: () => void
  onInlineEdit: (file: string, start: number, end: number, instruction: string) => Promise<void>
  onComplete?: (req: CompletionRequest) => Promise<string | null>
  suggestions?: boolean
  picking: boolean
  onPicking: (on: boolean) => void
  onPick: (el: PickedElement) => void
}) {
  const isPython = runtime === 'python'
  const wsRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  // What the Python frame last reported. It runs inside a sandbox with no
  // same-origin access, so its state can only arrive by message — there is
  // nothing to read out of the document.
  const [pyState, setPyState] = useState<'running' | 'done' | 'error'>('running')

  // Track the workspace size so we can position normalized cursors.
  useEffect(() => {
    if (!wsRef.current) return
    const el = wsRef.current
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // ── Element picking ───────────────────────────────────────────────
  // The preview is sandboxed without allow-same-origin, so its origin is the
  // opaque "null" and there is nothing meaningful to match e.origin against.
  // Identity of the sending window is the check that actually means something.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return
      const d = e.data
      if (!d || typeof d !== 'object') return
      if (d.lumen === PICKED_MESSAGE) {
        onPick({
          selector: String(d.selector ?? ''),
          label: String(d.label ?? 'element'),
          text: String(d.text ?? ''),
          html: String(d.html ?? ''),
        })
      } else if (d.lumen === PICK_CANCELLED) {
        onPicking(false)
      } else if (d.lumen === PYTHON_STATE_MESSAGE) {
        setPyState(d.state === 'error' ? 'error' : 'done')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onPick, onPicking])

  // A fresh frame is a fresh interpreter, so the reported state resets with it.
  useEffect(() => setPyState('running'), [runNonce, previewCode])

  // Arm or disarm the picker. Re-sent whenever the document is replaced, since
  // srcDoc mounts a brand-new window that has never heard from us. Never sent to
  // a Python frame: there are no elements in a console to point at, and the
  // picker script isn't in that document to receive it.
  const arm = () => {
    if (isPython) return
    frameRef.current?.contentWindow?.postMessage({ lumen: PICK_MESSAGE, on: picking }, '*')
  }
  useEffect(arm, [picking, previewCode, isPython])

  // Picking is meaningless on the code tab, and a stale armed frame would keep
  // swallowing clicks — disarm on the way out.
  useEffect(() => {
    if (tab !== 'preview' && picking) onPicking(false)
  }, [tab, picking, onPicking])

  const onMove = (e: React.PointerEvent) => {
    const el = wsRef.current
    if (!el || !awareness) return
    const r = el.getBoundingClientRect()
    awareness.setLocalStateField('cursor', {
      nx: clamp01((e.clientX - r.left) / r.width),
      ny: clamp01((e.clientY - r.top) / r.height),
    })
  }
  const onLeave = () => awareness?.setLocalStateField('cursor', null)

  const hasApp = !!previewCode

  return (
    <section className="workspace">
      <div className="ws-head">
        <div className="tabs">
          <button className={`tab ${tab === 'preview' ? 'active' : ''}`} onClick={() => onTab('preview')}>
            {isPython ? <Terminal /> : <EyeIcon />} {isPython ? 'Console' : 'Preview'}
          </button>
          <button className={`tab ${tab === 'code' ? 'active' : ''}`} onClick={() => onTab('code')}>
            <CodeIcon /> Code
          </button>
        </div>
        {tab === 'code' && (
          <div className="file-chip" title={activeFile}>
            <FileIcon width={13} height={13} />
            <span>{activeFile}</span>
          </div>
        )}
        <div className="ws-url">
          {isPython ? (
            <div className={`ws-pill py ${pyState}`} title="This project runs CPython compiled to WebAssembly">
              <Terminal width={12} height={12} />
              <span>python3 main.py</span>
            </div>
          ) : (
            <div className="ws-pill">
              <svg className="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="5" y="11" width="14" height="9" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
              <span>lumen.app/preview</span>
            </div>
          )}
          {!isPython && (
            <button
              className={`btn ghost icon ${picking ? 'active' : ''}`}
              onClick={() => {
                if (tab !== 'preview') onTab('preview')
                onPicking(!picking)
              }}
              disabled={!hasApp || building}
              title={picking ? 'Cancel — click an element to edit it' : 'Point at an element in the app to edit it'}
              aria-label="Pick an element to edit"
              aria-pressed={picking}
            >
              <Pointer width={15} height={15} />
            </button>
          )}
          <button
            className="btn ghost icon"
            onClick={onRun}
            title={isPython ? 'Run main.py again — restarts the interpreter' : 'Refresh preview'}
            aria-label={isPython ? 'Run the program again' : 'Refresh preview'}
          >
            {isPython ? <Play width={14} height={14} /> : <Refresh width={15} height={15} />}
          </button>
        </div>
      </div>

      <div className="ws-body" ref={wsRef} onPointerMove={onMove} onPointerLeave={onLeave}>
        {/* Preview tab */}
        <div style={{ position: 'absolute', inset: 0, visibility: tab === 'preview' ? 'visible' : 'hidden' }}>
          {hasApp ? (
            <iframe
              // Keyed on the run counter so pressing Run tears the frame down and
              // builds a new one. For the web runtime that is a plain reload; for
              // Python it is the only way to restart an interpreter that has
              // already finished — or to escape one that never will.
              key={isPython ? `py-${runNonce}` : 'web'}
              ref={frameRef}
              className="preview-frame"
              title={isPython ? 'Python console' : 'App preview'}
              sandbox="allow-scripts allow-modals allow-popups allow-forms"
              srcDoc={previewCode}
              onLoad={arm}
            />
          ) : (
            <div className="empty-stage">
              <div className="inner">
                <div className="ill">{isPython ? <Terminal width={26} height={26} /> : <Spark width={26} height={26} />}</div>
                <h3>{isPython ? 'Your program will run here' : 'Your app will appear here'}</h3>
                <p>
                  {isPython
                    ? 'Describe what you want in the chat on the right. Lumen writes the Python and runs it in this console — real CPython, in your browser.'
                    : 'Describe what you want in the chat on the right. Lumen builds it and runs it live in this space.'}
                </p>
              </div>
            </div>
          )}
          {picking && hasApp && !isPython && (
            <div className="pick-hint" role="status">
              <Pointer width={13} height={13} />
              <span>Click any element to edit it</span>
              <em>Esc to cancel</em>
            </div>
          )}
        </div>

        {/* Code tab — remounts per file so the collab binding follows the selection */}
        <div style={{ position: 'absolute', inset: 0, visibility: tab === 'code' ? 'visible' : 'hidden' }}>
          <CodeEditor
            key={activeFile}
            ytext={activeText}
            awareness={awareness}
            path={activeFile}
            onInlineEdit={onInlineEdit}
            onComplete={onComplete}
            // Suggestions are pointless while a build is streaming the file in,
            // and would be asked for against text that is still arriving.
            suggestions={suggestions && !building}
          />
        </div>

        {/* Generation overlay */}
        {building && (
          <div className="gen">
            <div className="panel">
              <div className="ring" />
              <div className="gt">Building</div>
            </div>
          </div>
        )}

        <Cursors awareness={awareness} size={size} />
      </div>
    </section>
  )
}
