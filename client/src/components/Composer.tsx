import { useRef, useState } from 'react'
import { Send, Mic } from '../icons'
import { useDictation } from '../speech'
import { toast } from '../toast'

const EXAMPLES = [
  'A pomodoro timer with a circular progress ring',
  'A neon snake game I can play with arrow keys',
  'A landing page for a coffee subscription',
  'A markdown notepad with live preview',
]

export function Composer({ onBuild, building, showExamples }: { onBuild: (prompt: string) => void; building: boolean; showExamples: boolean }) {
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

  return (
    <div className="composer">
      {showExamples && (
        <div className="chips" style={{ marginBottom: 12 }}>
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => !building && onBuild(ex)}>
              {ex}
            </button>
          ))}
        </div>
      )}
      <div className={`composer-box ${listening ? 'listening' : ''}`}>
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            grow()
          }}
          onKeyDown={onKey}
          rows={1}
          placeholder={listening ? 'Listening… speak your idea' : building ? 'Building…' : 'Describe an app, or a change to make…'}
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
