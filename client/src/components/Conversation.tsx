import { useEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { useYArray, useYMap } from '../yhooks'
import { api } from '../api'
import { Composer } from './Composer'
import { ChatHistory } from './ChatHistory'
import { HistoryIcon, Spark } from '../icons'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'error'
  text: string
  authorName?: string
  color?: string
  hasBuild?: boolean
  ts?: number
}

const initials = (name?: string) =>
  (name || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

export function Conversation({
  projectId,
  messages,
  meta,
  onBuild,
}: {
  projectId: string
  messages: Y.Array<Y.Map<any>>
  meta: Y.Map<any>
  onBuild: (prompt: string) => void
}) {
  const list = useYArray<Message>(messages)
  const metaState = useYMap(meta)
  const building = !!metaState.building
  const scroller = useRef<HTMLDivElement>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [retryTick, setRetryTick] = useState(0)
  const lastSavedRef = useRef('')

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [list.length, building])

  const empty = list.length === 0 && !building

  // Auto-save: whenever the conversation changes (and no build is mid-stream),
  // debounce briefly and upsert this user's live session for the project.
  // A failed attempt quietly retries; the next change also re-triggers it.
  useEffect(() => {
    if (building || list.length === 0) return
    const payload = JSON.stringify(list)
    if (payload === lastSavedRef.current) return
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      setSaveState('saving')
      api
        .autosaveChat(projectId, list)
        .then(() => {
          lastSavedRef.current = payload
          setSaveState('saved')
        })
        .catch(() => {
          setSaveState('idle')
          retryTimer = setTimeout(() => setRetryTick((t) => t + 1), 4000)
        })
    }, 1200)
    return () => {
      clearTimeout(timer)
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [list, building, projectId, retryTick])

  return (
    <section className="conv">
      <div className="conv-head">
        <div className="conv-title">
          <Spark width={14} height={14} />
          <span>Chat</span>
        </div>
        <span className="spacer" />
        {list.length > 0 && (
          <span
            className={`autosave ${saveState}`}
            title="This chat saves to your history automatically"
            role="status"
            aria-live="polite"
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : 'Autosave'}
          </span>
        )}
        <button
          className={`ract ${historyOpen ? 'on' : ''}`}
          onClick={() => setHistoryOpen((v) => !v)}
          title="Your chat history"
          aria-label="Your chat history"
        >
          <HistoryIcon width={15} height={15} />
        </button>
      </div>

      <div className="messages" ref={scroller}>
        {empty && (
          <div className="hero">
            <h1>
              Describe it.<br />
              <span className="grad">Watch it come alive.</span>
            </h1>
            <p>Tell Lumen what you want to make. It writes the code and runs it live — and anyone in the room sees it happen with you.</p>
          </div>
        )}

        {list.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="msg-avatar" style={m.role === 'user' ? { background: m.color || '#8b5cf6' } : undefined}>
              {m.role === 'assistant' ? <Spark width={15} height={15} /> : initials(m.authorName)}
            </div>
            <div className="msg-body">
              <div className="msg-name">{m.role === 'assistant' ? 'Lumen' : m.role === 'error' ? 'Lumen' : m.authorName || 'You'}</div>
              <div className="msg-text">{m.text}</div>
              {m.hasBuild && (
                <div className="buildcard">
                  <div className="bc-icon">
                    <Spark width={14} height={14} />
                  </div>
                  <div>
                    <div className="bc-t">App updated</div>
                    <div className="bc-s">Running live in the preview</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {building && (
          <div className="msg assistant">
            <div className="msg-avatar">
              <Spark width={15} height={15} />
            </div>
            <div className="msg-body">
              <div className="msg-name">Lumen</div>
              <div className="building">
                <span className="orb" />
                <span>
                  {metaState.building?.by ? `${metaState.building.by} is building` : 'Building'}
                  <span className="ddd" />
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      <Composer onBuild={onBuild} building={building} showExamples={empty} />

      {historyOpen && <ChatHistory onClose={() => setHistoryOpen(false)} />}
    </section>
  )
}
