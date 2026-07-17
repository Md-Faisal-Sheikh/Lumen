import { useEffect, useState } from 'react'
import { api, type ChatSessionDetail, type ChatSessionSummary } from '../api'
import { toast } from '../toast'
import { ArrowLeft, Close, Spark, Trash } from '../icons'

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

const initials = (name?: string) =>
  (name || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

// Slide-over drawer listing the signed-in user's saved chat sessions.
// Click a session to read it; delete removes it from their history.
export function ChatHistory({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<ChatSessionSummary[] | null>(null)
  const [detail, setDetail] = useState<ChatSessionDetail | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const { sessions } = await api.chats()
      setSessions(sessions)
    } catch (e: any) {
      toast(e?.message || 'Could not load your chat history.')
      setSessions([])
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const open = async (id: string) => {
    setOpeningId(id)
    try {
      const { session } = await api.chat(id)
      setDetail(session)
    } catch (e: any) {
      toast(e?.message || 'Could not open that chat session.')
    } finally {
      setOpeningId(null)
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm('Delete this saved chat session?')) return
    try {
      await api.deleteChat(id)
      setSessions((prev) => (prev ? prev.filter((s) => s.id !== id) : prev))
      if (detail?.id === id) setDetail(null)
      toast('Chat session deleted')
    } catch (e: any) {
      toast(e?.message || 'Could not delete that session.')
    }
  }

  return (
    <div className="history">
      <div className="h-head">
        {detail ? (
          <button className="ract" onClick={() => setDetail(null)} title="Back to history" aria-label="Back to history">
            <ArrowLeft width={16} height={16} />
          </button>
        ) : (
          <span className="h-title">Chat history</span>
        )}
        {detail && (
          <span className="h-title trunc" title={detail.title}>
            {detail.title}
          </span>
        )}
        <span className="spacer" />
        <button className="ract" onClick={onClose} title="Close" aria-label="Close history">
          <Close width={16} height={16} />
        </button>
      </div>

      {!detail ? (
        <div className="h-list">
          {sessions === null && <div className="h-empty">Loading your saved chats…</div>}
          {sessions?.length === 0 && (
            <div className="h-empty">
              No saved chats yet.
              <br />
              Your conversations save here automatically as you build.
            </div>
          )}
          {sessions?.map((s) => (
            <div key={s.id} className={`h-item ${openingId === s.id ? 'busy' : ''}`} onClick={() => open(s.id)}>
              <div className="h-item-main">
                <div className="h-item-title">
                  {s.title}
                  {s.kind === 'auto' && <span className="h-badge">auto</span>}
                </div>
                <div className="h-meta">
                  <span className="h-proj">{s.projectName}</span>
                  <span>·</span>
                  <span>{s.messageCount} message{s.messageCount === 1 ? '' : 's'}</span>
                  <span>·</span>
                  <span>{fmtDate(s.updatedAt || s.createdAt)}</span>
                </div>
              </div>
              <button
                className="ract danger"
                title="Delete session"
                aria-label={`Delete ${s.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  remove(s.id)
                }}
              >
                <Trash width={14} height={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="h-detail">
          <div className="h-meta pad">
            <span className="h-proj">{detail.projectName}</span>
            <span>·</span>
            <span>{fmtDate(detail.createdAt)}</span>
          </div>
          {detail.messages.map((m: any, i: number) => (
            <div key={m?.id ?? i} className={`msg ${m?.role ?? 'user'}`}>
              <div className="msg-avatar" style={m?.role === 'user' ? { background: m?.color || '#8b5cf6' } : undefined}>
                {m?.role === 'assistant' || m?.role === 'error' ? <Spark width={15} height={15} /> : initials(m?.authorName)}
              </div>
              <div className="msg-body">
                <div className="msg-name">{m?.role === 'assistant' || m?.role === 'error' ? 'Lumen' : m?.authorName || 'You'}</div>
                <div className="msg-text">{m?.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
