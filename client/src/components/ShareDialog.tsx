import { useEffect, useRef, useState } from 'react'
import { api, type Publication } from '../api'
import { toast } from '../toast'
import { Close, Copy, Globe, Share, Spark, Trash } from '../icons'

const copy = async (text: string, done: string) => {
  try {
    await navigator.clipboard.writeText(text)
    toast(done)
  } catch {
    toast('Copy failed — select the link and copy it manually.')
  }
}

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

// The two ways to share a project, side by side:
//   · invite a collaborator — needs a Lumen account, can edit
//   · publish — a read-only link that works for anyone, account or not
export function ShareDialog({
  projectId,
  projectName,
  isOwner,
  publishableHtml,
  hasApp,
  onClose,
}: {
  projectId: string
  projectName: string
  isOwner: boolean
  /** The app as it stands, assembled for publishing (no editor instrumentation). */
  publishableHtml: () => string
  hasApp: boolean
  onClose: () => void
}) {
  const [email, setEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [publication, setPublication] = useState<Publication | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'publish' | 'update' | 'unpublish' | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const projectLink = `${location.origin}${location.pathname}?p=${projectId}`

  useEffect(() => {
    let alive = true
    api
      .publication(projectId)
      .then(({ publication }) => alive && setPublication(publication))
      .catch(() => alive && setPublication(null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [projectId])

  // Escape closes; the backdrop swallows clicks outside the card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const invite = async () => {
    const value = email.trim()
    if (!value || inviting) return
    setInviting(true)
    try {
      await api.invite(projectId, value)
      setEmail('')
      toast(`Invited ${value}`)
    } catch (e: any) {
      toast(e?.message || 'Could not invite that person.')
    } finally {
      setInviting(false)
    }
  }

  const publish = async (mode: 'publish' | 'update') => {
    if (busy) return
    const html = publishableHtml()
    if (!html.trim()) {
      toast('Build something first — there is nothing to publish yet.')
      return
    }
    setBusy(mode)
    try {
      const { publication } = await api.publish(projectId, html)
      setPublication(publication)
      if (mode === 'publish') {
        await copy(publication.url, 'Published · link copied')
      } else {
        toast('Public page updated')
      }
    } catch (e: any) {
      toast(e?.message || 'Could not publish this project.')
    } finally {
      setBusy(null)
    }
  }

  const unpublish = async () => {
    if (busy) return
    if (!window.confirm('Take the public page down? Anyone holding the link will stop being able to open it.')) return
    setBusy('unpublish')
    try {
      await api.unpublish(projectId)
      setPublication(null)
      toast('Public page taken down')
    } catch (e: any) {
      toast(e?.message || 'Could not unpublish this project.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" ref={cardRef} role="dialog" aria-modal="true" aria-label={`Share ${projectName}`}>
        <div className="sheet-head">
          <Share width={15} height={15} />
          <span className="h-title trunc">Share “{projectName}”</span>
          <span className="spacer" />
          <button className="ract" onClick={onClose} title="Close" aria-label="Close">
            <Close width={15} height={15} />
          </button>
        </div>

        <div className="sheet-body">
          {/* ── Collaborators ─────────────────────────────── */}
          <section className="sh-block">
            <h3>Invite a collaborator</h3>
            <p>They edit the code, chat, and preview with you in real time — so they need a Lumen account.</p>
            <div className="sh-row">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && invite()}
                placeholder="teammate@example.com"
                disabled={!isOwner || inviting}
                spellCheck={false}
              />
              <button className="btn ghost" onClick={invite} disabled={!isOwner || inviting || !email.trim()}>
                {inviting ? 'Inviting…' : 'Invite'}
              </button>
            </div>
            {!isOwner && <div className="sh-note">Only the project owner can invite people.</div>}
            <button className="sh-link" onClick={() => copy(projectLink, 'Project link copied')}>
              <Copy width={13} height={13} /> Copy the project link for people already invited
            </button>
          </section>

          {/* ── Public link ───────────────────────────────── */}
          <section className="sh-block">
            <h3>
              <Globe width={14} height={14} /> Publish to the web
            </h3>
            <p>
              A read-only page anyone can open — no account, no sign-in. It shows a snapshot of the app taken when you
              publish, so what you're still working on stays private.
            </p>

            {loading ? (
              <div className="sh-note">Checking…</div>
            ) : publication ? (
              <>
                <div className="sh-row">
                  <input className="sh-url" value={publication.url} readOnly onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn primary" onClick={() => copy(publication.url, 'Public link copied')}>
                    <Copy width={14} height={14} /> Copy
                  </button>
                </div>
                <div className="sh-meta">
                  <span className="sh-live">
                    <i /> Live
                  </span>
                  <span>{publication.views === 1 ? '1 view' : `${publication.views} views`}</span>
                  <span>updated {fmtWhen(publication.updatedAt)}</span>
                </div>
                <div className="sh-actions">
                  <a className="btn ghost" href={publication.url} target="_blank" rel="noopener noreferrer">
                    Open
                  </a>
                  {isOwner && (
                    <>
                      <button className="btn ghost" onClick={() => publish('update')} disabled={busy !== null}>
                        <Spark width={14} height={14} /> {busy === 'update' ? 'Updating…' : 'Update to current code'}
                      </button>
                      <button className="btn ghost danger" onClick={unpublish} disabled={busy !== null}>
                        <Trash width={14} height={14} /> {busy === 'unpublish' ? 'Removing…' : 'Unpublish'}
                      </button>
                    </>
                  )}
                </div>
                {!isOwner && <div className="sh-note">Only the project owner can update or remove the public page.</div>}
              </>
            ) : isOwner ? (
              <button className="btn primary wide" onClick={() => publish('publish')} disabled={busy !== null || !hasApp}>
                <Globe width={15} height={15} /> {busy === 'publish' ? 'Publishing…' : 'Publish this project'}
              </button>
            ) : (
              <div className="sh-note">This project isn't published. Only its owner can publish it.</div>
            )}
            {!hasApp && isOwner && !publication && <div className="sh-note">Build something first — there's nothing to publish yet.</div>}
          </section>
        </div>
      </div>
    </div>
  )
}
