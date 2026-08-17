import { useEffect, useState } from 'react'
import { api, type GalleryCard, type TemplateCard } from '../api'
import { toast } from '../toast'
import { runtimeLabel } from '../runtime'
import { Close, Compass, EyeIcon, Fork, Globe, Spark, Terminal } from '../icons'

// ── Discover ────────────────────────────────────────────────────────
//
// Two lists that look similar and are not:
//
//   Templates — projects offered as starting points. Forking one gives you your
//               own editable copy, with its own history starting at the fork.
//   Gallery   — published pages their owners chose to list. You open them. There
//               is no Fork button, and that is deliberate: a publication is a
//               snapshot of HTML, not a workspace, and its author published a
//               *page* rather than volunteering their project as a base.
//
// Both endpoints are unauthenticated and return only what an owner explicitly
// made public, so nothing here is gated on being signed in — the fork button is,
// because forking creates something.

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

function RuntimeTag({ runtime }: { runtime: 'web' | 'python' }) {
  return (
    <span className={`rt-tag ${runtime}`} title={`${runtimeLabel(runtime)} runtime`}>
      {runtime === 'python' ? <Terminal width={11} height={11} /> : <Globe width={11} height={11} />}
      {runtimeLabel(runtime)}
    </span>
  )
}

export function DiscoverDialog({
  onForked,
  onClose,
}: {
  /** Called with the new project id once a fork lands, so the room can switch to it. */
  onForked: (projectId: string) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'templates' | 'gallery'>('templates')
  const [templates, setTemplates] = useState<TemplateCard[] | null>(null)
  const [pages, setPages] = useState<GalleryCard[] | null>(null)
  const [forking, setForking] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .templates()
      .then(({ templates }) => alive && setTemplates(templates))
      .catch(() => alive && setTemplates([]))
    api
      .gallery()
      .then(({ pages }) => alive && setPages(pages))
      .catch(() => alive && setPages([]))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const fork = async (t: TemplateCard) => {
    if (forking) return
    setForking(t.id)
    try {
      const { project } = await api.fork(t.id)
      toast(`Forked “${t.name}” — it's yours to change`)
      onForked(project.id)
      onClose()
    } catch (e: any) {
      toast(e?.message || 'Could not fork that template.')
    } finally {
      setForking(null)
    }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet disc" role="dialog" aria-modal="true" aria-label="Discover">
        <div className="sheet-head">
          <Compass width={15} height={15} />
          <span className="h-title">Discover</span>
          <span className="spacer" />
          <button className="ract" onClick={onClose} title="Close" aria-label="Close">
            <Close width={15} height={15} />
          </button>
        </div>

        <div className="disc-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'templates'}
            className={`tab ${tab === 'templates' ? 'active' : ''}`}
            onClick={() => setTab('templates')}
          >
            <Fork width={13} height={13} /> Templates
            {templates && templates.length > 0 && <b>{templates.length}</b>}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'gallery'}
            className={`tab ${tab === 'gallery' ? 'active' : ''}`}
            onClick={() => setTab('gallery')}
          >
            <Globe width={13} height={13} /> Gallery
            {pages && pages.length > 0 && <b>{pages.length}</b>}
          </button>
        </div>

        <div className="sheet-body disc-body">
          {tab === 'templates' && (
            <>
              <p className="disc-lede">
                Starting points other people have published. Forking one gives you an editable copy of your own — the
                original is never touched.
              </p>
              {templates === null && <div className="disc-empty">Loading…</div>}
              {templates?.length === 0 && (
                <div className="disc-empty">
                  <Spark width={22} height={22} />
                  <p>
                    No templates yet. Open <b>Share</b> on a project you own and offer it as a template to put the
                    first one here.
                  </p>
                </div>
              )}
              <div className="disc-grid">
                {templates?.map((t) => (
                  <article key={t.id} className="disc-card">
                    <header>
                      <span className="disc-title trunc">{t.name}</span>
                      <RuntimeTag runtime={t.runtime} />
                    </header>
                    <p className="disc-desc">{t.description || 'No description.'}</p>
                    <footer>
                      <span className="disc-by">
                        <i className="avatar tiny" style={{ background: t.authorColor }}>
                          {initials(t.authorName)}
                        </i>
                        {t.authorName}
                      </span>
                      <span className="disc-stat" title={`${t.forkCount} fork${t.forkCount === 1 ? '' : 's'}`}>
                        <Fork width={11} height={11} /> {t.forkCount}
                      </span>
                      <span className="spacer" />
                      <button className="btn ghost sm" onClick={() => fork(t)} disabled={forking !== null}>
                        <Fork width={13} height={13} /> {forking === t.id ? 'Forking…' : 'Fork'}
                      </button>
                    </footer>
                  </article>
                ))}
              </div>
            </>
          )}

          {tab === 'gallery' && (
            <>
              <p className="disc-lede">
                Published pages whose owners chose to list them. These open as read-only public links — nothing here
                is a copy you can edit.
              </p>
              {pages === null && <div className="disc-empty">Loading…</div>}
              {pages?.length === 0 && (
                <div className="disc-empty">
                  <Globe width={22} height={22} />
                  <p>
                    Nothing listed yet. Publishing stays unlisted unless its owner ticks <b>List in the gallery</b> —
                    so an empty gallery means nobody has opted in, not that nobody has published.
                  </p>
                </div>
              )}
              <div className="disc-grid">
                {pages?.map((p) => (
                  <article key={p.slug} className="disc-card">
                    <header>
                      <span className="disc-title trunc">{p.title}</span>
                      <RuntimeTag runtime={p.runtime} />
                    </header>
                    <p className="disc-desc mono">{p.url.replace(/^https?:\/\//, '')}</p>
                    <footer>
                      <span className="disc-by">
                        <i className="avatar tiny" style={{ background: p.authorColor }}>
                          {initials(p.authorName)}
                        </i>
                        {p.authorName}
                      </span>
                      <span className="disc-stat" title={`${p.views} view${p.views === 1 ? '' : 's'}`}>
                        <EyeIcon width={11} height={11} /> {p.views}
                      </span>
                      <span className="spacer" />
                      <a className="btn ghost sm" href={p.url} target="_blank" rel="noopener noreferrer">
                        Open
                      </a>
                    </footer>
                    <span className="disc-when">updated {fmtWhen(p.updatedAt)}</span>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
