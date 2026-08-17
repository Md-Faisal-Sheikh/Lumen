import { useEffect, useRef, useState } from 'react'
import { api, type Publication } from '../api'
import { toast } from '../toast'
import { Close, Copy, Fork, Globe, Share, Spark, Trash } from '../icons'

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
  isTemplate,
  description,
  onTemplateChange,
  onClose,
}: {
  projectId: string
  projectName: string
  isOwner: boolean
  /** The app as it stands, assembled for publishing (no editor instrumentation). */
  publishableHtml: () => string
  hasApp: boolean
  /** Whether this project is currently offered as a forkable starting point. */
  isTemplate: boolean
  description: string | null
  onTemplateChange: (next: { isTemplate: boolean; description: string | null }) => void
  onClose: () => void
}) {
  const [email, setEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [publication, setPublication] = useState<Publication | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'publish' | 'update' | 'unpublish' | 'listed' | null>(null)
  const [tmplBusy, setTmplBusy] = useState(false)
  const [desc, setDesc] = useState(description ?? '')
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

  // Listing is a separate call from publishing so it can be toggled without
  // re-uploading the snapshot — the page in the gallery stays exactly the page
  // that was published.
  const setListed = async (next: boolean) => {
    if (busy || !publication) return
    setBusy('listed')
    try {
      const { publication: updated } = await api.publish(projectId, publishableHtml(), next)
      setPublication(updated)
      toast(next ? 'Listed in the public gallery' : 'Removed from the gallery — the link still works')
    } catch (e: any) {
      toast(e?.message || 'Could not change the gallery listing.')
    } finally {
      setBusy(null)
    }
  }

  const saveTemplate = async (nextIsTemplate: boolean) => {
    if (tmplBusy) return
    setTmplBusy(true)
    try {
      const trimmed = desc.trim()
      const { project } = await api.setTemplate(projectId, {
        isTemplate: nextIsTemplate,
        description: trimmed || null,
      })
      onTemplateChange({ isTemplate: !!project.isTemplate, description: project.description ?? null })
      toast(
        nextIsTemplate
          ? 'Offered as a template — anyone signed in can fork it'
          : 'No longer offered as a template'
      )
    } catch (e: any) {
      toast(e?.message || 'Could not update the template setting.')
    } finally {
      setTmplBusy(false)
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
                {isOwner && (
                  <label className="sh-check" title="Show this page on the Discover → Gallery tab">
                    <input
                      type="checkbox"
                      checked={publication.listed}
                      disabled={busy !== null}
                      onChange={(e) => setListed(e.target.checked)}
                    />
                    <span>
                      <b>List in the public gallery</b>
                      <em>
                        Off by default. The link works either way — this only decides whether the page is findable
                        without it.
                      </em>
                    </span>
                  </label>
                )}
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

          {/* ── Template ──────────────────────────────────── */}
          <section className="sh-block">
            <h3>
              <Fork width={14} height={14} /> Offer as a template
            </h3>
            <p>
              A template is a starting point. Anyone signed in can fork it into a project of their own — they get an
              editable copy with its own history, and this project is never changed by them.
            </p>

            {isOwner ? (
              <>
                <input
                  className="sh-url"
                  value={desc}
                  maxLength={200}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="One line about what this template gives you"
                  disabled={tmplBusy}
                />
                <div className="sh-actions">
                  {isTemplate ? (
                    <>
                      <button className="btn ghost" onClick={() => saveTemplate(true)} disabled={tmplBusy}>
                        <Spark width={14} height={14} /> {tmplBusy ? 'Saving…' : 'Save description'}
                      </button>
                      <button className="btn ghost danger" onClick={() => saveTemplate(false)} disabled={tmplBusy}>
                        <Trash width={14} height={14} /> Stop offering
                      </button>
                    </>
                  ) : (
                    <button className="btn primary wide" onClick={() => saveTemplate(true)} disabled={tmplBusy || !hasApp}>
                      <Fork width={15} height={15} /> {tmplBusy ? 'Publishing…' : 'Offer as a template'}
                    </button>
                  )}
                </div>
                {isTemplate && (
                  <div className="sh-note ok">
                    Listed on the <b>Discover → Templates</b> tab.
                  </div>
                )}
                {!hasApp && !isTemplate && (
                  <div className="sh-note">Build something first — an empty project makes a poor starting point.</div>
                )}
              </>
            ) : (
              <div className="sh-note">Only the project owner can offer it as a template.</div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
