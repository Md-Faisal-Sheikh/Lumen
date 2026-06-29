import { useEffect, useRef } from 'react'
import type * as Y from 'yjs'
import { useYArray, useYMap } from '../yhooks'
import { Composer } from './Composer'
import { Spark } from '../icons'

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
  messages,
  meta,
  onBuild,
}: {
  messages: Y.Array<Y.Map<any>>
  meta: Y.Map<any>
  onBuild: (prompt: string) => void
}) {
  const list = useYArray<Message>(messages)
  const metaState = useYMap(meta)
  const building = !!metaState.building
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [list.length, building])

  const empty = list.length === 0 && !building

  return (
    <section className="conv">
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
    </section>
  )
}
