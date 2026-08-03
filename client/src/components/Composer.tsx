import { useRef, useState } from 'react'
import { Send, Mic, Pointer, Close } from '../icons'
import { useDictation } from '../speech'
import { toast } from '../toast'
import type { PickedElement } from '../picker'

export function Composer({
  onBuild,
  building,
  target,
  onClearTarget,
}: {
  onBuild: (prompt: string) => void
  building: boolean
  /** Element picked in the preview — the next message is about this, not the whole app. */
  target?: PickedElement | null
  onClearTarget?: () => void
}) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const { listening, supported, toggle, stop } = useDictation({
    onText: (text) => {
      setValue(text)
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

  const submit = () => {
    const text = value.trim()
    if (!text || building) return
    if (listening) stop()
    onBuild(text)
    setValue('')
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

  const placeholder = listening
    ? 'Listening… speak your idea'
    : building
      ? 'Building…'
      : target
        ? `Change this ${target.label}…`
        : 'Describe an app, or a change to make…'

  return (
    <div className="composer">
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
      <div className={`composer-box ${listening ? 'listening' : ''} ${target ? 'targeted' : ''}`}>
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            grow()
          }}
          onKeyDown={onKey}
          rows={1}
          placeholder={placeholder}
          disabled={building}
        />
        {supported && (
          <button
            className={`mic-btn ${listening ? 'on' : ''}`}
            onClick={() => toggle(value)}
            disabled={building}
            title={listening ? 'Stop listening' : 'Speak your idea'}
            aria-label={listening ? 'Stop listening' : 'Start voice input'}
          >
            <Mic width={17} height={17} />
          </button>
        )}
        <button className="send-btn" onClick={submit} disabled={building || !value.trim()} aria-label="Send">
          <Send width={17} height={17} />
        </button>
      </div>
    </div>
  )
}
