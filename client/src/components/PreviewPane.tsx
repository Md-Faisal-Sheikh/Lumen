import { useEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { CodeEditor } from './CodeEditor'
import { Cursors } from './Cursors'
import { CodeIcon, EyeIcon, FileIcon, Pointer, Refresh, Spark } from '../icons'
import { PICK_CANCELLED, PICK_MESSAGE, PICKED_MESSAGE, type PickedElement } from '../picker'

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export function PreviewPane({
  tab,
  onTab,
  previewCode,
  building,
  builderName,
  activeFile,
  activeText,
  awareness,
  onRun,
  onInlineEdit,
  picking,
  onPicking,
  onPick,
}: {
  tab: 'preview' | 'code'
  onTab: (t: 'preview' | 'code') => void
  previewCode: string
  building: boolean
  builderName?: string
  activeFile: string
  activeText: Y.Text
  awareness: any
  onRun: () => void
  onInlineEdit: (file: string, start: number, end: number, instruction: string) => Promise<void>
  picking: boolean
  onPicking: (on: boolean) => void
  onPick: (el: PickedElement) => void
}) {
  const wsRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

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
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onPick, onPicking])

  // Arm or disarm the picker. Re-sent whenever the document is replaced, since
  // srcDoc mounts a brand-new window that has never heard from us.
  const arm = () => {
    frameRef.current?.contentWindow?.postMessage({ lumen: PICK_MESSAGE, on: picking }, '*')
  }
  useEffect(arm, [picking, previewCode])

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
            <EyeIcon /> Preview
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
          <div className="ws-pill">
            <svg className="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <span>lumen.app/preview</span>
          </div>
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
          <button className="btn ghost icon" onClick={onRun} title="Refresh preview" aria-label="Refresh preview">
            <Refresh width={15} height={15} />
          </button>
        </div>
      </div>

      <div className="ws-body" ref={wsRef} onPointerMove={onMove} onPointerLeave={onLeave}>
        {/* Preview tab */}
        <div style={{ position: 'absolute', inset: 0, visibility: tab === 'preview' ? 'visible' : 'hidden' }}>
          {hasApp ? (
            <iframe
              ref={frameRef}
              className="preview-frame"
              title="App preview"
              sandbox="allow-scripts allow-modals allow-popups allow-forms"
              srcDoc={previewCode}
              onLoad={arm}
            />
          ) : (
            <div className="empty-stage">
              <div className="inner">
                <div className="ill">
                  <Spark width={26} height={26} />
                </div>
                <h3>Your app will appear here</h3>
                <p>Describe what you want in the chat on the right. Lumen builds it and runs it live in this space.</p>
              </div>
            </div>
          )}
          {picking && hasApp && (
            <div className="pick-hint" role="status">
              <Pointer width={13} height={13} />
              <span>Click any element to edit it</span>
              <em>Esc to cancel</em>
            </div>
          )}
        </div>

        {/* Code tab — remounts per file so the collab binding follows the selection */}
        <div style={{ position: 'absolute', inset: 0, visibility: tab === 'code' ? 'visible' : 'hidden' }}>
          <CodeEditor key={activeFile} ytext={activeText} awareness={awareness} path={activeFile} onInlineEdit={onInlineEdit} />
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
