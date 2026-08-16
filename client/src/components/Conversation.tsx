import { useEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { useYArray, useYMap } from '../yhooks'
import { api } from '../api'
import { Composer } from './Composer'
import { ChatHistory } from './ChatHistory'
import { HistoryIcon, Pointer, Recycle, Spark } from '../icons'
import type { PickedElement } from '../picker'
import type { Attachment, ImageKind } from '../vision'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'error'
  text: string
  authorName?: string
  color?: string
  /** Thumbnail of the sketch or screenshot this message was built from. */
  image?: string
  imageKind?: ImageKind
  hasBuild?: boolean
  /** Set on the reply when the build came from a picture rather than words. */
  fromImage?: ImageKind
  fromCache?: boolean // build served straight from the database cache
  reusedFrom?: string // the cached prompt this matched, when it wasn't word-for-word
  similarity?: number // how close the two prompts scored, 0..1
  prompt?: string // what was asked, so the build can be re-run without the cache
  hasEdit?: boolean // precise line edit (no rebuild)
  editNote?: string // e.g. "index.html · line 14"
  context?: string // what the message was aimed at: "button.cta" or "app.js · lines 3–5"
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
  onRebuild,
  target,
  onClearTarget,
}: {
  projectId: string
  messages: Y.Array<Y.Map<any>>
  meta: Y.Map<any>
  onBuild: (prompt: string, image?: Attachment) => void
  /** Re-run a prompt with the build cache bypassed. */
  onRebuild?: (prompt: string) => void
  target?: PickedElement | null
  onClearTarget?: () => void
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
  // saveSeq orders overlapping requests: a response that isn't from the newest
  // request is ignored, so a slow stale save can't mark newer data as saved.
  // (The server also refuses payloads with fewer messages than it holds.)
  const saveSeq = useRef(0)
  const listRef = useRef(list)
  listRef.current = list

  useEffect(() => {
    if (building || list.length === 0) return
    const payload = JSON.stringify(list)
    if (payload === lastSavedRef.current) return
    const seq = ++saveSeq.current
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    // When a newer request (debounced or flush) superseded this one, still settle
    // the badge from what actually got saved — never leave it stuck on "Saving…".
    const settle = () =>
      setSaveState(lastSavedRef.current === JSON.stringify(listRef.current) ? 'saved' : 'idle')
    const timer = setTimeout(() => {
      setSaveState('saving')
      api
        .autosaveChat(projectId, list)
        .then(() => {
          if (cancelled) return
          if (seq !== saveSeq.current) return settle()
          lastSavedRef.current = payload
          setSaveState('saved')
        })
        .catch(() => {
          if (cancelled) return
          if (seq !== saveSeq.current) return settle()
          setSaveState('idle')
          retryTimer = setTimeout(() => setRetryTick((t) => t + 1), 4000)
        })
    }, 1200)
    return () => {
      cancelled = true
      clearTimeout(timer)
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [list, building, projectId, retryTick])

  // Flush the tail of the conversation when it would otherwise be lost:
  // on tab hide (close/switch/minimize) and on unmount (switching projects) —
  // the 1.2s debounce above may not have fired yet.
  useEffect(() => {
    const flush = (unloading: boolean) => {
      const msgs = listRef.current
      if (msgs.length === 0) return
      const payload = JSON.stringify(msgs)
      if (payload === lastSavedRef.current) return
      saveSeq.current++ // any in-flight debounced save is now stale
      lastSavedRef.current = payload // optimistic — outcome is unknowable mid-unload
      setSaveState('saved')
      // fetch's keepalive mode caps bodies at 64 KiB — beyond that, send a
      // normal request (it still completes unless the tab is torn down first).
      const keepalive = unloading && new TextEncoder().encode(payload).length < 55_000
      api.autosaveChat(projectId, msgs, { keepalive }).catch(() => {
        lastSavedRef.current = '' // still alive and it failed: the next change retries
      })
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush(true)
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      flush(false) // unmount: project switch or sign-out with the tab still alive
    }
  }, [projectId])

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
              {m.context && (
                <div className="msg-context" title={m.context}>
                  <Pointer width={11} height={11} />
                  <code>{m.context}</code>
                </div>
              )}
              {m.image && (
                <img
                  className="msg-shot"
                  src={m.image}
                  alt={m.imageKind === 'sketch' ? 'The sketch this was built from' : 'The image this was built from'}
                  title={m.imageKind === 'sketch' ? 'Built from this sketch' : 'Built from this image'}
                />
              )}
              <div className="msg-text">{m.text}</div>
              {m.hasBuild &&
                (m.reusedFrom ? (
                  /* A loose cache match. Say so plainly, show what it matched,
                     and never leave "that's not what I asked for" as a dead end. */
                  <div className="buildcard reused">
                    <div className="bc-icon">
                      <Recycle width={14} height={14} />
                    </div>
                    <div className="bc-main">
                      <div className="bc-t">
                        Reused a similar build
                        {typeof m.similarity === 'number' && <span className="bc-score">{Math.round(m.similarity * 100)}% match</span>}
                      </div>
                      <div className="bc-s">
                        Someone already built <q>{m.reusedFrom}</q> — served instantly, no AI call.
                      </div>
                      {m.prompt && onRebuild && (
                        <button className="bc-action" onClick={() => onRebuild(m.prompt!)} disabled={building}>
                          Not what you meant? Build a fresh one
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="buildcard">
                    <div className="bc-icon">
                      <Spark width={14} height={14} />
                    </div>
                    <div>
                      <div className="bc-t">
                        {m.fromImage === 'sketch' ? 'Built from your sketch' : m.fromImage ? 'Rebuilt from your image' : 'App updated'}
                      </div>
                      <div className="bc-s">
                        {m.fromImage
                          ? 'Generated fresh — image builds never come from the library'
                          : m.fromCache
                            ? 'Served instantly from the build library'
                            : 'Running live in the preview'}
                      </div>
                    </div>
                  </div>
                ))}
              {m.hasEdit && (
                <div className="buildcard">
                  <div className="bc-icon">
                    <Spark width={14} height={14} />
                  </div>
                  <div>
                    <div className="bc-t">Lines updated</div>
                    <div className="bc-s">{m.editNote || 'Applied precisely to the code'}</div>
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
                  {metaState.building?.by
                    ? `${metaState.building.by} is ${metaState.building?.mode === 'edit' ? 'editing lines' : 'building'}`
                    : metaState.building?.mode === 'edit'
                      ? 'Editing lines'
                      : 'Building'}
                  <span className="ddd" />
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      <Composer onBuild={onBuild} building={building} target={target} onClearTarget={onClearTarget} />

      {historyOpen && <ChatHistory onClose={() => setHistoryOpen(false)} />}
    </section>
  )
}
