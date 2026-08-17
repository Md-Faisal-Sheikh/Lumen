import { useCallback, useEffect, useRef, useState } from 'react'
import { attachmentFromBlob, attachmentFromCanvas, dragHasFile, imageFromTransfer, type Attachment, type ImageKind } from '../vision'
import { toast } from '../toast'
import { Close, Eraser, ImageIcon, Pencil, Spark, Trash, Undo } from '../icons'

// ── The sketch pad ──────────────────────────────────────────────────
// Draw the app instead of describing it. What leaves here is an ordinary PNG,
// so the pad has one job: make the drawing legible to a model that has never
// seen the user's handwriting.
//
// Two decisions carry the rest of the file:
//
//   · Strokes are stored in *board space* — 0..1 on both axes, widths in units
//     of a 1000-wide board. The pad is resizable and the export is a fixed size
//     that has nothing to do with the window, so nothing may depend on pixels.
//   · Ink is composited as its own layer. Erasing is destination-out, which
//     would punch through an imported screenshot if it shared the backdrop's
//     canvas — the eraser has to remove your marks, not the thing you drew on.

interface Stroke {
  color: string
  /** Width in units of a 1000-wide board. */
  width: number
  erase: boolean
  /** Flat [x, y, x, y, …] in board space, 0..1. */
  pts: number[]
}

// Export resolution. Independent of the on-screen size, so a sketch drawn in a
// small window is handed to the model at the same fidelity as a maximized one.
const BOARD_W = 1152
const BOARD_H = 720
const NOM = 1000

const INKS = ['#16141f', '#7c3aed', '#db2777', '#0d9488', '#ca8a04']
const SIZES: Array<{ label: string; width: number }> = [
  { label: 'Fine', width: 3 },
  { label: 'Medium', width: 6.5 },
  { label: 'Bold', width: 14 },
]

function drawContained(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight)
  const dw = img.naturalWidth * scale
  const dh = img.naturalHeight * scale
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
}

// Quadratic through the midpoints of consecutive samples: pointer input is
// polyline-jagged, and a wireframe drawn in jagged lines reads as noise.
function tracePath(ctx: CanvasRenderingContext2D, pts: number[], w: number, h: number) {
  const n = pts.length / 2
  const X = (i: number) => pts[i * 2] * w
  const Y = (i: number) => pts[i * 2 + 1] * h
  if (n === 1) {
    // A tap is a dot, not nothing.
    ctx.beginPath()
    ctx.arc(X(0), Y(0), ctx.lineWidth / 2, 0, Math.PI * 2)
    ctx.fillStyle = ctx.strokeStyle as string
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(X(0), Y(0))
  for (let i = 1; i < n - 1; i++) {
    ctx.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2)
  }
  ctx.lineTo(X(n - 1), Y(n - 1))
  ctx.stroke()
}

function paintInk(ink: HTMLCanvasElement, strokes: Stroke[]) {
  const w = ink.width
  const h = ink.height
  const ctx = ink.getContext('2d')!
  ctx.clearRect(0, 0, w, h)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const k = w / NOM
  for (const s of strokes) {
    if (s.pts.length === 0) continue
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'
    ctx.strokeStyle = s.color
    ctx.lineWidth = Math.max(1, s.width * k)
    tracePath(ctx, s.pts, w, h)
  }
  ctx.globalCompositeOperation = 'source-over'
}

/** Paper, then the imported image, then the ink layer on top. */
function paintBoard(canvas: HTMLCanvasElement, backdrop: HTMLImageElement | null, strokes: Stroke[], scratch?: HTMLCanvasElement) {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  if (backdrop) drawContained(ctx, backdrop, w, h)

  const ink = scratch ?? document.createElement('canvas')
  if (ink.width !== w || ink.height !== h) {
    ink.width = w
    ink.height = h
  }
  paintInk(ink, strokes)
  ctx.drawImage(ink, 0, 0)
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('That image could not be opened.'))
    img.src = src
  })

export function SketchPad({
  initial,
  onCancel,
  onUse,
}: {
  /** An existing attachment to annotate, when the pad is opened from a chip. */
  initial?: { url: string; name?: string; kind?: ImageKind } | null
  onCancel: () => void
  onUse: (attachment: Attachment) => void
}) {
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [past, setPast] = useState<Stroke[][]>([])
  const [color, setColor] = useState(INKS[0])
  const [width, setWidth] = useState(SIZES[1].width)
  const [erasing, setErasing] = useState(false)
  const [backdrop, setBackdrop] = useState<HTMLImageElement | null>(null)
  const [backdropName, setBackdropName] = useState<string | undefined>(undefined)
  // What the backdrop *is*, which is not the same as where it is drawn.
  // Reopening your own sketch to add to it paints it onto the board like any
  // other image — but it is still a wireframe, and sending it back as a
  // screenshot would have the server rebuild it as a design instead of reading
  // it as a blueprint. That distinction has to survive the round trip.
  const [backdropKind, setBackdropKind] = useState<ImageKind>('screenshot')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // The live canvas keeps one ink layer for its lifetime; reallocating it every
  // frame while drawing is pure garbage.
  const scratchRef = useRef<HTMLCanvasElement>(document.createElement('canvas'))
  // Drawing reads these, never the state — a pointermove must paint what is on
  // the board right now, not what the last render closed over.
  const strokesRef = useRef<Stroke[]>(strokes)
  const backdropRef = useRef<HTMLImageElement | null>(null)
  const liveRef = useRef<Stroke | null>(null)
  const frameRef = useRef(0)

  strokesRef.current = strokes

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const live = liveRef.current
    const all = live ? [...strokesRef.current, live] : strokesRef.current
    paintBoard(canvas, backdropRef.current, all, scratchRef.current)
  }, [])

  const schedule = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      redraw()
    })
  }, [redraw])

  // Size the backing store to the CSS box at device resolution, and repaint.
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const resize = () => {
      const rect = wrap.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(rect.width * dpr))
      const h = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width === w && canvas.height === h) return
      canvas.width = w
      canvas.height = h
      redraw()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [redraw])

  useEffect(redraw, [strokes, backdrop, redraw])
  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    },
    []
  )

  const setImage = useCallback(async (blob: Blob, name?: string) => {
    setBusy(true)
    try {
      // Route it through the same normalizer the composer uses, so what you
      // trace over is exactly what the model will be shown.
      const normalized = await attachmentFromBlob(blob, 'screenshot', name)
      const img = await loadImage(normalized.url)
      backdropRef.current = img
      setBackdrop(img)
      setBackdropName(normalized.name)
      setBackdropKind('screenshot') // imported from outside: a reference, not a wireframe
    } catch (e: any) {
      toast(e?.message || 'That image could not be opened.')
    } finally {
      setBusy(false)
    }
  }, [])

  // Opened from an existing attachment: start with it on the board.
  useEffect(() => {
    if (!initial?.url) return
    let alive = true
    loadImage(initial.url)
      .then((img) => {
        if (!alive) return
        backdropRef.current = img
        setBackdrop(img)
        setBackdropName(initial.name)
        setBackdropKind(initial.kind ?? 'screenshot')
      })
      .catch(() => toast('That attachment could not be reopened.'))
    return () => {
      alive = false
    }
  }, [initial?.url, initial?.name, initial?.kind])

  const commit = (stroke: Stroke) => {
    // Snapshot before queueing: the updater below runs after this frame, by
    // which time strokesRef has already been repointed by the re-render.
    const before = strokesRef.current
    setPast((p) => [...p, before])
    setStrokes((s) => [...s, stroke])
  }

  const undo = () => {
    if (past.length === 0) return
    setStrokes(past[past.length - 1])
    setPast((p) => p.slice(0, -1))
  }

  const clear = () => {
    if (strokes.length === 0) return
    setPast((p) => [...p, strokes])
    setStrokes([])
  }

  const removeImage = () => {
    backdropRef.current = null
    setBackdrop(null)
    setBackdropName(undefined)
  }

  // ── Drawing ───────────────────────────────────────────────────────
  const pointAt = (e: React.PointerEvent | PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height]
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const [x, y] = pointAt(e)
    liveRef.current = { color, width, erase: erasing, pts: [x, y] }
    redraw()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current
    if (!live) return
    e.preventDefault()
    // Coalesced events recover the samples the browser batched into this frame —
    // without them a fast stroke is a handful of straight segments.
    const events = e.nativeEvent.getCoalescedEvents?.() ?? []
    const points = events.length > 0 ? events : [e.nativeEvent]
    for (const ev of points) {
      const [x, y] = pointAt(ev)
      live.pts.push(x, y)
    }
    schedule()
  }

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current
    if (!live) return
    liveRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    commit(live)
  }

  // ── Shortcuts, paste, drop ────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      }
    }
    const onPaste = (e: ClipboardEvent) => {
      const file = imageFromTransfer(e.clipboardData)
      if (!file) return
      e.preventDefault()
      void setImage(file, file.name)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('paste', onPaste)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel, past, setImage])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = imageFromTransfer(e.dataTransfer)
    if (file) void setImage(file, file.name)
  }

  // ── Handing it over ───────────────────────────────────────────────
  const empty = strokes.length === 0 && !backdrop
  // An imported image is the design; anything else on this board is a wireframe.
  // The two are read very differently on the server, so the distinction travels
  // with the attachment rather than being re-guessed from what's on screen.
  const kind: ImageKind = backdrop ? backdropKind : 'sketch'

  const use = () => {
    if (empty) return
    const out = document.createElement('canvas')
    out.width = BOARD_W
    out.height = BOARD_H
    paintBoard(out, backdropRef.current, strokes)
    onUse(attachmentFromCanvas(out, kind, kind === 'sketch' ? 'sketch.png' : backdropName ?? 'reference.png'))
  }

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="sheet pad" role="dialog" aria-modal="true" aria-label="Draw the app you want">
        <div className="sheet-head">
          <Pencil width={15} height={15} />
          <span className="h-title trunc">Draw it</span>
          <span className="spacer" />
          <button className="ract" onClick={onCancel} title="Close" aria-label="Close">
            <Close width={15} height={15} />
          </button>
        </div>

        <div className="pad-tools">
          <div className="pt-group" role="group" aria-label="Ink colour">
            {INKS.map((ink) => (
              <button
                key={ink}
                className={`pt-ink ${!erasing && color === ink ? 'on' : ''}`}
                style={{ '--ink': ink } as React.CSSProperties}
                onClick={() => {
                  setColor(ink)
                  setErasing(false)
                }}
                title={`Draw in ${ink}`}
                aria-label={`Draw in ${ink}`}
                aria-pressed={!erasing && color === ink}
              />
            ))}
          </div>

          <div className="pt-group" role="group" aria-label="Stroke width">
            {SIZES.map((s) => (
              <button
                key={s.label}
                className={`pt-size ${width === s.width ? 'on' : ''}`}
                onClick={() => setWidth(s.width)}
                title={`${s.label} stroke`}
                aria-label={`${s.label} stroke`}
                aria-pressed={width === s.width}
              >
                <i style={{ width: Math.max(3, s.width), height: Math.max(3, s.width) }} />
              </button>
            ))}
          </div>

          <button
            className={`ract ${erasing ? 'on' : ''}`}
            onClick={() => setErasing((v) => !v)}
            title="Eraser — removes your marks, not the image"
            aria-label="Eraser"
            aria-pressed={erasing}
          >
            <Eraser width={15} height={15} />
          </button>
          <button className="ract" onClick={undo} disabled={past.length === 0} title="Undo (Ctrl+Z)" aria-label="Undo">
            <Undo width={15} height={15} />
          </button>
          <button className="ract" onClick={clear} disabled={strokes.length === 0} title="Clear the drawing" aria-label="Clear the drawing">
            <Trash width={15} height={15} />
          </button>

          <span className="spacer" />

          <button className="btn ghost pt-import" onClick={() => fileRef.current?.click()} disabled={busy}>
            <ImageIcon width={14} height={14} />
            {busy ? 'Opening…' : backdrop ? 'Replace image' : 'Add an image'}
          </button>
          {backdrop && (
            <button className="ract danger" onClick={removeImage} title="Remove the image" aria-label="Remove the image">
              <Close width={15} height={15} />
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void setImage(file, file.name)
              e.target.value = '' // so choosing the same file twice still fires
            }}
          />
        </div>

        <div
          className={`pad-board ${dragging ? 'dragging' : ''}`}
          ref={wrapRef}
          onDragOver={(e) => {
            if (!dragHasFile(e.dataTransfer)) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            setDragging(false)
          }}
          onDrop={onDrop}
        >
          <canvas
            ref={canvasRef}
            className={erasing ? 'erasing' : ''}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
          />
          {empty && !dragging && (
            <div className="pad-empty">
              <Pencil width={22} height={22} />
              <p>Draw the layout you want — boxes, lines, labels.</p>
              <span>Or drop a screenshot in to rebuild or mark up.</span>
            </div>
          )}
          {dragging && <div className="pad-drop">Drop the image to place it on the board</div>}
        </div>

        <div className="pad-foot">
          <p className="pad-hint">
            {kind === 'screenshot'
              ? 'Lumen rebuilds the image as a real page. Anything you draw on top — arrows, circles, notes — is read as an instruction, never copied.'
              : 'Boxes become containers, lines become text, and anything you write becomes the real label. The handwriting itself is never drawn.'}
          </p>
          <div className="pad-actions">
            <button className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
            <button className="btn primary" onClick={use} disabled={empty || busy}>
              <Spark width={15} height={15} /> {kind === 'screenshot' ? 'Use this image' : 'Use this sketch'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
