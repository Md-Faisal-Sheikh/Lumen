import { useEffect, useState } from 'react'
import { api, type Version, type VersionDetail } from '../api'
import { toast } from '../toast'
import { assemblePreview, parseWorkspace } from '../files'
import { buildPythonRunner } from '../python'
import { entryFile, type Runtime } from '../runtime'
import { Close, HistoryIcon, Restore, Spark } from '../icons'

// ── Checkpoints ─────────────────────────────────────────────────────
//
// Every build, line edit and inline edit has always written a Version row. This
// panel is the first thing that lets anyone see them: a timeline down the left,
// the selected checkpoint rendered on the right, and one button to go back.
//
// Restoring never destroys anything. The server snapshots the current workspace
// as its own checkpoint before handing the old one back, so the way out of a
// restore is another restore.

const fmtWhen = (iso: string) => {
  const then = new Date(iso)
  const mins = Math.round((Date.now() - then.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const fmtFull = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

// A restore and its paired "before" snapshot are bookkeeping, not work someone
// did. They stay in the list — hiding them would make the timeline lie — but
// they are marked so the eye skips to the actual builds.
const isBookkeeping = (prompt: string) => /^(Restored |Before restoring |Forked from )/.test(prompt)

export function HistoryDialog({
  projectId,
  projectName,
  runtime,
  currentWorkspace,
  onRestore,
  onClose,
}: {
  projectId: string
  projectName: string
  runtime: Runtime
  /** The live workspace in marker format — sent along so the restore is undoable. */
  currentWorkspace: () => string
  /** Apply a restored workspace to the shared document. Resolves when it has landed. */
  onRestore: (files: Record<string, string>, label: string) => Promise<void>
  onClose: () => void
}) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<VersionDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .versions(projectId)
      .then(({ versions }) => {
        if (!alive) return
        setVersions(versions)
        // Select the second entry by default, not the first: the newest
        // checkpoint is what is already on screen, so previewing it shows the
        // user nothing they can't already see.
        if (versions.length > 1) setSelected(versions[1].id)
        else if (versions.length > 0) setSelected(versions[0].id)
      })
      .catch((e: any) => alive && setError(e?.message || 'Could not load the history.'))
    return () => {
      alive = false
    }
  }, [projectId])

  useEffect(() => {
    if (!selected) return
    let alive = true
    setLoadingDetail(true)
    setDetail(null)
    api
      .version(projectId, selected)
      .then(({ version }) => alive && setDetail(version))
      .catch(() => alive && setDetail(null))
      .finally(() => alive && setLoadingDetail(false))
    return () => {
      alive = false
    }
  }, [projectId, selected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // What the preview frame shows for the selected checkpoint. Assembled exactly
  // as the live preview assembles it, minus the element picker — this is a
  // record of the past, not something to point at and edit.
  const previewDoc = (() => {
    if (!detail) return ''
    const files = parseWorkspace(detail.html, runtime)
    const entry = entryFile(runtime)
    if (runtime === 'python') return buildPythonRunner(files, entry)
    const rest: Record<string, string> = {}
    for (const [path, content] of Object.entries(files)) if (path !== entry) rest[path] = content
    return assemblePreview(files[entry] ?? '', rest)
  })()

  const fileCount = detail ? Object.keys(parseWorkspace(detail.html, runtime)).length : 0

  const restore = async () => {
    if (!detail || restoring) return
    const label = detail.prompt.slice(0, 80)
    if (
      !window.confirm(
        `Restore the project to this checkpoint for everyone in the room?\n\n“${label}”\n\nThe current code is saved as its own checkpoint first, so you can come back.`
      )
    ) {
      return
    }
    setRestoring(true)
    try {
      const { version } = await api.restoreVersion(projectId, detail.id, {
        currentCode: currentWorkspace(),
        label,
      })
      await onRestore(parseWorkspace(version.html, runtime), label)
      toast('Restored — the previous code is saved as a checkpoint')
      onClose()
    } catch (e: any) {
      toast(e?.message || 'Could not restore that checkpoint.')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet hist" role="dialog" aria-modal="true" aria-label={`History of ${projectName}`}>
        <div className="sheet-head">
          <HistoryIcon width={15} height={15} />
          <span className="h-title trunc">History — “{projectName}”</span>
          <span className="spacer" />
          <button className="ract" onClick={onClose} title="Close" aria-label="Close">
            <Close width={15} height={15} />
          </button>
        </div>

        <div className="hist-body">
          <div className="hist-list" role="listbox" aria-label="Checkpoints">
            {error && <div className="hist-empty">{error}</div>}
            {!error && versions === null && <div className="hist-empty">Loading…</div>}
            {versions?.length === 0 && (
              <div className="hist-empty">
                No checkpoints yet. Every build and edit saves one automatically — describe an app in the chat and
                this fills in.
              </div>
            )}
            {versions?.map((v, i) => (
              <button
                key={v.id}
                role="option"
                aria-selected={selected === v.id}
                className={`hist-item ${selected === v.id ? 'sel' : ''} ${isBookkeeping(v.prompt) ? 'meta' : ''}`}
                onClick={() => setSelected(v.id)}
                title={fmtFull(v.createdAt)}
              >
                <span className="hist-rail">
                  <i />
                </span>
                <span className="hist-text">
                  <span className="hist-prompt">{v.prompt}</span>
                  <span className="hist-when">
                    {fmtWhen(v.createdAt)}
                    {i === 0 && <em> · current</em>}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className="hist-preview">
            {loadingDetail ? (
              <div className="hist-empty">Loading checkpoint…</div>
            ) : detail ? (
              <>
                <div className="hist-frame">
                  {/* Same sandbox as the live preview: a checkpoint is user-authored
                      code and gets exactly the containment the running app gets. */}
                  <iframe
                    key={detail.id}
                    title="Checkpoint preview"
                    sandbox="allow-scripts allow-modals allow-popups allow-forms"
                    srcDoc={previewDoc}
                  />
                </div>
                <div className="hist-foot">
                  <div className="hist-meta">
                    <span className="trunc">{detail.prompt}</span>
                    <span className="hist-sub">
                      {fmtFull(detail.createdAt)} · {fileCount} file{fileCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <button className="btn primary" onClick={restore} disabled={restoring}>
                    <Restore width={14} height={14} /> {restoring ? 'Restoring…' : 'Restore this'}
                  </button>
                </div>
              </>
            ) : (
              <div className="hist-empty">
                <Spark width={22} height={22} />
                <p>Pick a checkpoint on the left to see how the project looked.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
