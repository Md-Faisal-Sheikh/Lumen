import { useEffect, useRef, useState } from 'react'
import { Send, Mic, Pointer, Close, SketchIcon, Pencil } from '../icons'
import { useDictation } from '../speech'
import { toast } from '../toast'
import type { PickedElement } from '../picker'
import {
  attachmentFromBlob,
  dragHasFile,
  formatBytes,
  imageFromTransfer,
  visionCapability,
  type Attachment,
  type VisionCapability,
} from '../vision'
import { SketchPad } from './SketchPad'

// Append a spoken phrase to whatever is already in the box, leaving existing
// text — including its line breaks — exactly as it was.
const join = (base: string, addition: string) => {
  const extra = addition.trim()
  if (!extra) return base
  if (!base) return extra
  return /\s$/.test(base) ? base + extra : `${base} ${extra}`
}

export function Composer({
  onBuild,
  building,
  target,
  onClearTarget,
}: {
  onBuild: (prompt: string, image?: Attachment) => void
  building: boolean
  /** Element picked in the preview — the next message is about this, not the whole app. */
  target?: PickedElement | null
  onClearTarget?: () => void
}) {
  const [value, setValue] = useState('')
  const [image, setImage] = useState<Attachment | null>(null)
  const [padOpen, setPadOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  // null while we're still asking the server; the sketch button waits rather
  // than flickering in and out.
  const [vision, setVision] = useState<VisionCapability | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let alive = true
    visionCapability().then((cap) => alive && setVision(cap))
    return () => {
      alive = false
    }
  }, [])

  const { listening, suspended, interim, supported, toggle, cancel } = useDictation({
    // Appended to whatever is in the box at the moment the phrase lands, rather
    // than to a copy taken when the microphone opened — so typing mid-sentence
    // survives, and two phrases arriving in one event can't overwrite each
    // other the way reading a snapshot would.
    onFinal: (phrase) => {
      setValue((current) => join(current, phrase))
      requestAnimationFrame(grow)
    },
    onError: (m) => toast(m),
  })

  function grow() {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }

  // Scale, flatten, and encode a dropped or pasted file. Anything that arrives
  // when the server can't look at images is refused here with the reason,
  // rather than after a round trip.
  const attach = async (blob: Blob, name?: string) => {
    if (vision && !vision.supported) {
      toast(vision.reason || 'This Lumen server cannot build from an image.')
      return
    }
    setLoading(true)
    try {
      setImage(await attachmentFromBlob(blob, 'screenshot', name))
    } catch (e: any) {
      toast(e?.message || 'That image could not be read.')
    } finally {
      setLoading(false)
    }
  }

  const submit = () => {
    // Fold in the phrase still being heard. Pressing Enter mid-sentence has to
    // send those words — otherwise they are dropped from this message and then
    // arrive in the next, empty one.
    const text = join(value, interim).trim()
    // A picture is a complete request on its own — words are optional with one
    // attached, and required without.
    if ((!text && !image) || building) return
    if (listening) cancel()
    onBuild(text, image ?? undefined)
    setValue('')
    setImage(null)
    requestAnimationFrame(() => {
      if (ref.current) ref.current.style.height = 'auto'
    })
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const file = imageFromTransfer(e.clipboardData)
    if (!file) return
    e.preventDefault()
    void attach(file, file.name)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = imageFromTransfer(e.dataTransfer)
    if (file) void attach(file, file.name)
  }

  const canSketch = vision?.supported === true
  // The action buttons are absolutely positioned over the textarea, so it needs
  // to reserve room for however many are actually showing.
  const actionCount = 1 + (supported ? 1 : 0) + (canSketch ? 1 : 0)
  // Words being heard right now count as something to send, even though they
  // aren't in the box yet.
  const canSend = !!value.trim() || !!interim.trim() || !!image

  const placeholder = listening
    ? 'Listening… speak your idea'
    : building
      ? 'Building…'
      : image
        ? image.kind === 'sketch'
          ? 'Anything to add about the sketch? (optional)'
          : 'Anything to change about it? (optional)'
        : target
          ? `Change this ${target.label}…`
          : 'Describe an app, draw one, or drop a screenshot…'

  return (
    <div
      className={`composer ${dragging ? 'dropping' : ''}`}
      onDragOver={(e) => {
        if (!dragHasFile(e.dataTransfer) || building) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragging(false)
      }}
      onDrop={onDrop}
    >
      {target && (
        <div className="target-chip">
          <Pointer width={12} height={12} />
          <code>{target.label}</code>
          {target.text && <span className="tc-text">“{target.text}”</span>}
          <button onClick={onClearTarget} title="Stop editing this element" aria-label="Stop editing this element">
            <Close width={12} height={12} />
          </button>
        </div>
      )}

      {image && (
        <div className="shot-chip">
          <img src={image.thumb} alt={image.kind === 'sketch' ? 'The sketch you drew' : 'The image you attached'} />
          <div className="sc-main">
            <div className="sc-t">{image.kind === 'sketch' ? 'Your sketch' : image.name || 'Screenshot'}</div>
            <div className="sc-s">
              {image.width}×{image.height} · {formatBytes(image.bytes)} ·{' '}
              {image.kind === 'sketch' ? 'built as a wireframe' : 'rebuilt as a real page'}
            </div>
          </div>
          <button onClick={() => setPadOpen(true)} title="Open in the sketch pad" aria-label="Open in the sketch pad" disabled={building}>
            <Pencil width={13} height={13} />
          </button>
          <button onClick={() => setImage(null)} title="Remove this image" aria-label="Remove this image" disabled={building}>
            <Close width={13} height={13} />
          </button>
        </div>
      )}

      {loading && !image && <div className="shot-chip loading">Reading that image…</div>}

      {/* Words reach the box only once the recognizer commits them, so the ones
          still being heard need somewhere to show — otherwise nothing happens
          on screen until a whole phrase lands and it looks broken. Keeping them
          out of the textarea is also what lets you type while talking. */}
      {listening && (
        <div className={`hearing ${suspended ? 'held' : ''}`} role="status" aria-live="polite">
          <span className="hear-dot" />
          {suspended ? (
            <span className="hear-idle">Paused so Lumen isn't transcribed…</span>
          ) : interim ? (
            <span className="hear-text">{interim}</span>
          ) : (
            <span className="hear-idle">Listening — speak whenever you're ready</span>
          )}
        </div>
      )}

      <div
        className={`composer-box ${listening ? 'listening' : ''} ${target ? 'targeted' : ''} ${image ? 'attached' : ''}`}
        style={{ '--actions': actionCount } as React.CSSProperties}
      >
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            grow()
          }}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={1}
          placeholder={placeholder}
          disabled={building}
        />
        <div className="composer-actions">
          {canSketch && (
            <button
              className={`act-btn ${padOpen ? 'on' : ''}`}
              onClick={() => setPadOpen(true)}
              disabled={building}
              title="Draw the app instead of describing it"
              aria-label="Draw the app instead of describing it"
            >
              <SketchIcon width={17} height={17} />
            </button>
          )}
          {supported && (
            <button
              className={`act-btn mic-btn ${listening ? 'on' : ''} ${suspended ? 'held' : ''}`}
              onClick={toggle}
              disabled={building}
              title={listening ? 'Stop listening' : 'Speak your idea'}
              aria-label={listening ? 'Stop listening' : 'Start voice input'}
              aria-pressed={listening}
            >
              <Mic width={17} height={17} />
            </button>
          )}
          <button className="send-btn" onClick={submit} disabled={building || !canSend} aria-label="Send">
            <Send width={17} height={17} />
          </button>
        </div>
      </div>

      {padOpen && (
        <SketchPad
          initial={image ? { url: image.url, name: image.name, kind: image.kind } : null}
          onCancel={() => setPadOpen(false)}
          onUse={(attachment) => {
            setImage(attachment)
            setPadOpen(false)
            ref.current?.focus()
          }}
        />
      )}
    </div>
  )
}
