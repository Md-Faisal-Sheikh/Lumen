import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type GitHubAccount, type GitHubLink, type GitHubRepo, type PushResult } from '../api'
import { toast } from '../toast'
import { Close, CommitIcon, Copy, GitHub, Plus, Spark, Trash } from '../icons'

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** "my first project" → "my-first-project", a legal repo name to pre-fill with. */
const repoNameFrom = (projectName: string) =>
  projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'lumen-app'

/** A classic token advertises its scopes; a fine-grained one reports none at all.
 *  So an empty list is "can't tell", and only a populated list that lacks `repo`
 *  is worth warning about — guessing otherwise would nag every fine-grained token. */
const missingRepoScope = (scopes: string[]) => scopes.length > 0 && !scopes.includes('repo')

// Connect a GitHub account, point this project at a repository, and push the
// workspace as a commit. Three states, in order: no account → no repository →
// ready to push.
export function GitHubDialog({
  projectId,
  projectName,
  isOwner,
  files,
  hasApp,
  onClose,
}: {
  projectId: string
  projectName: string
  isOwner: boolean
  /** The workspace as it stands: every file at its real path. */
  files: () => { path: string; content: string }[]
  hasApp: boolean
  onClose: () => void
}) {
  const [account, setAccount] = useState<GitHubAccount | null>(null)
  const [link, setLink] = useState<GitHubLink | null>(null)
  const [loading, setLoading] = useState(true)

  const [token, setToken] = useState('')
  const [connecting, setConnecting] = useState(false)

  const [repos, setRepos] = useState<GitHubRepo[] | null>(null)
  const [reposLoading, setReposLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [newRepoName, setNewRepoName] = useState(() => repoNameFrom(projectName))
  const [newRepoPrivate, setNewRepoPrivate] = useState(true)
  const [creating, setCreating] = useState(false)

  const [message, setMessage] = useState('')
  const [pushing, setPushing] = useState(false)
  const [result, setResult] = useState<PushResult | null>(null)
  const [unlinking, setUnlinking] = useState(false)

  const tokenRef = useRef<HTMLInputElement>(null)

  // Account and repo link are independent reads; fetch both, and let either fail
  // without blanking the other — a listing failure is not a connection failure.
  useEffect(() => {
    let alive = true
    Promise.allSettled([api.githubAccount(), api.githubLink(projectId)])
      .then(([a, l]) => {
        if (!alive) return
        if (a.status === 'fulfilled') setAccount(a.value.account)
        if (l.status === 'fulfilled') setLink(l.value.link)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [projectId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!loading && !account) tokenRef.current?.focus()
  }, [loading, account])

  const connect = async () => {
    const value = token.trim()
    if (!value || connecting) return
    setConnecting(true)
    try {
      const { account } = await api.githubConnect(value)
      setAccount(account)
      // Clear it from React state the moment it is accepted — there is no reason
      // for the token to stay in a live input after it has been stored.
      setToken('')
      toast(`Connected as ${account.login}`)
    } catch (e: any) {
      toast(e?.message || 'Could not connect to GitHub.')
    } finally {
      setConnecting(false)
    }
  }

  const disconnect = async () => {
    if (!window.confirm('Disconnect GitHub? Your stored token is deleted. Repositories and commits are untouched.')) return
    try {
      await api.githubDisconnect()
      setAccount(null)
      setRepos(null)
      setResult(null)
      toast('GitHub disconnected')
    } catch (e: any) {
      toast(e?.message || 'Could not disconnect.')
    }
  }

  const loadRepos = async () => {
    if (reposLoading) return
    setReposLoading(true)
    try {
      const { repos } = await api.githubRepos()
      setRepos(repos)
    } catch (e: any) {
      toast(e?.message || 'Could not list your repositories.')
      setRepos([])
    } finally {
      setReposLoading(false)
    }
  }

  // The picker is only useful once there is an account and no repo chosen yet.
  useEffect(() => {
    if (account && !link && repos === null && !loading) void loadRepos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, link, loading])

  const choose = async (repo: GitHubRepo) => {
    try {
      const { link } = await api.githubSetLink(projectId, {
        owner: repo.owner,
        repo: repo.repo,
        branch: repo.defaultBranch || 'main',
      })
      setLink(link)
      setResult(null)
    } catch (e: any) {
      toast(e?.message || 'Could not link that repository.')
    }
  }

  const createRepo = async () => {
    const name = newRepoName.trim()
    if (!name || creating) return
    setCreating(true)
    try {
      const { repo } = await api.githubCreateRepo({
        name,
        private: newRepoPrivate,
        description: `${projectName} — built with Lumen`,
      })
      toast(`Created ${repo.fullName}`)
      await choose(repo)
    } catch (e: any) {
      toast(e?.message || 'Could not create the repository.')
    } finally {
      setCreating(false)
    }
  }

  const unlink = async () => {
    if (unlinking) return
    if (!window.confirm('Stop pushing this project to that repository? Nothing on GitHub is deleted.')) return
    setUnlinking(true)
    try {
      await api.githubUnlink(projectId)
      setLink(null)
      setResult(null)
      void loadRepos()
    } catch (e: any) {
      toast(e?.message || 'Could not unlink the repository.')
    } finally {
      setUnlinking(false)
    }
  }

  const push = async () => {
    if (pushing || !link) return
    const entries = files()
    if (entries.length === 0) {
      toast('Nothing to push yet — build something first.')
      return
    }
    setPushing(true)
    setResult(null)
    try {
      const { push } = await api.githubPush(projectId, { files: entries, message: message.trim() || undefined })
      setResult(push)
      setMessage('')
      if (push.unchanged) toast('Already up to date')
      else toast(`Pushed ${push.written.length} file${push.written.length === 1 ? '' : 's'} to ${push.fullName}`)
      // Reflect the new commit in the header without a second round trip.
      setLink((prev) =>
        prev
          ? {
              ...prev,
              branch: push.branch,
              lastCommitSha: push.commitSha,
              lastCommitUrl: push.commitUrl,
              lastPushedAt: new Date().toISOString(),
            }
          : prev
      )
    } catch (e: any) {
      toast(e?.message || 'The push did not complete.')
    } finally {
      setPushing(false)
    }
  }

  const visibleRepos = useMemo(() => {
    if (!repos) return []
    const q = filter.trim().toLowerCase()
    const matched = q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos
    return matched.slice(0, 60)
  }, [repos, filter])

  const fileCount = useMemo(() => (hasApp ? files().length : 0), [hasApp, files])

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet gh" role="dialog" aria-modal="true" aria-label={`Push ${projectName} to GitHub`}>
        <div className="sheet-head">
          <GitHub width={15} height={15} />
          <span className="h-title trunc">Push “{projectName}” to GitHub</span>
          <span className="spacer" />
          {account && (
            <span className="gh-who" title={`Connected as ${account.login}`}>
              {account.avatarUrl && <img src={account.avatarUrl} alt="" width={18} height={18} />}
              {account.login}
            </span>
          )}
          <button className="ract" onClick={onClose} title="Close" aria-label="Close">
            <Close width={15} height={15} />
          </button>
        </div>

        <div className="sheet-body">
          {loading ? (
            <div className="sh-note" style={{ padding: '18px 0' }}>
              Checking your GitHub connection…
            </div>
          ) : !account ? (
            /* ── 1 · Connect an account ─────────────────────── */
            <section className="sh-block">
              <h3>
                <GitHub width={14} height={14} /> Connect your GitHub account
              </h3>
              <p>
                Lumen pushes with a personal access token, so there's no app to register and nothing to configure on the
                server. The token is encrypted before it's stored and is never sent back to your browser.
              </p>
              <ol className="gh-steps">
                <li>
                  Open{' '}
                  <a
                    href="https://github.com/settings/tokens/new?scopes=repo&description=Lumen"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    GitHub → new token (classic)
                  </a>{' '}
                  — the <code>repo</code> scope is pre-ticked.
                </li>
                <li>
                  Or use a{' '}
                  <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">
                    fine-grained token
                  </a>{' '}
                  with <strong>Contents: Read and write</strong> on the repositories you want.
                </li>
                <li>Generate it, copy it, and paste it below.</li>
              </ol>
              <div className="sh-row">
                <input
                  ref={tokenRef}
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && connect()}
                  placeholder="ghp_… or github_pat_…"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={connecting}
                />
                <button className="btn primary" onClick={connect} disabled={connecting || !token.trim()}>
                  {connecting ? 'Checking…' : 'Connect'}
                </button>
              </div>
              <div className="sh-note">
                Lumen checks the token with GitHub before saving it, so a bad paste is an error here rather than a failed
                push later.
              </div>
            </section>
          ) : !link ? (
            /* ── 2 · Choose a repository ─────────────────────── */
            <>
              {missingRepoScope(account.scopes) && (
                <div className="gh-warn">
                  This token reports the scopes <code>{account.scopes.join(', ')}</code> — without <code>repo</code> it
                  can read but not push. You can carry on and see, or connect a token with write access.
                </div>
              )}
              <section className="sh-block">
                <h3>Choose a repository</h3>
                <p>
                  {isOwner
                    ? 'The repository belongs to the project, so everyone in the room pushes to the same one — each with their own account.'
                    : 'Only the project owner can choose the repository. Once they have, you can push to it with your own account.'}
                </p>

                {!isOwner ? (
                  <div className="sh-note">Ask the owner to pick a repository for this project.</div>
                ) : (
                  <>
                    <div className="sh-row">
                      <input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filter your repositories…"
                        spellCheck={false}
                      />
                      <button className="btn ghost" onClick={loadRepos} disabled={reposLoading}>
                        {reposLoading ? 'Loading…' : 'Refresh'}
                      </button>
                    </div>

                    <div className="gh-list">
                      {reposLoading && repos === null ? (
                        <div className="sh-note">Loading your repositories…</div>
                      ) : visibleRepos.length === 0 ? (
                        <div className="sh-note">
                          {repos && repos.length === 0
                            ? 'No repositories you can push to. Create one below.'
                            : 'Nothing matches that filter.'}
                        </div>
                      ) : (
                        visibleRepos.map((r) => (
                          <button key={r.fullName} className="gh-repo" onClick={() => choose(r)}>
                            <GitHub width={14} height={14} />
                            <span className="gh-repo-name trunc">{r.fullName}</span>
                            {r.private && <em className="gh-tag">private</em>}
                            {r.empty && <em className="gh-tag">empty</em>}
                            <span className="gh-repo-branch">{r.defaultBranch}</span>
                          </button>
                        ))
                      )}
                    </div>
                  </>
                )}
              </section>

              {isOwner && (
                <section className="sh-block">
                  <h3>
                    <Plus width={14} height={14} /> Or create a new one
                  </h3>
                  <p>Created empty, with no README — so this project's first push is the repository's first commit.</p>
                  <div className="sh-row">
                    <input
                      value={newRepoName}
                      onChange={(e) => setNewRepoName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && createRepo()}
                      placeholder="my-neon-snake"
                      spellCheck={false}
                      disabled={creating}
                    />
                    <button className="btn ghost" onClick={createRepo} disabled={creating || !newRepoName.trim()}>
                      {creating ? 'Creating…' : 'Create'}
                    </button>
                  </div>
                  <label className="gh-check">
                    <input type="checkbox" checked={newRepoPrivate} onChange={(e) => setNewRepoPrivate(e.target.checked)} />
                    <span>Private repository</span>
                  </label>
                </section>
              )}
            </>
          ) : (
            /* ── 3 · Commit and push ─────────────────────────── */
            <>
              <section className="sh-block">
                <h3>
                  <CommitIcon width={14} height={14} /> Commit and push
                </h3>
                <p>
                  Every file lands at its real path in one commit on{' '}
                  <code>{link.branch}</code>. Files you've deleted here are removed there; anything Lumen didn't write —
                  a README, a licence, a workflow — is left alone.
                </p>

                <div className="gh-repo-row">
                  <GitHub width={14} height={14} />
                  <a className="gh-repo-name trunc" href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.fullName}
                  </a>
                  <span className="gh-repo-branch">{link.branch}</span>
                  {isOwner && (
                    <button className="ract" onClick={unlink} disabled={unlinking} title="Unlink this repository" aria-label="Unlink this repository">
                      <Trash width={14} height={14} />
                    </button>
                  )}
                </div>

                <div className="sh-row" style={{ marginTop: 12 }}>
                  <input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && push()}
                    placeholder={`Update ${projectName} from Lumen`}
                    maxLength={500}
                    disabled={pushing}
                  />
                  <button className="btn primary" onClick={push} disabled={pushing || !hasApp}>
                    {pushing ? 'Pushing…' : 'Push'}
                  </button>
                </div>

                {!hasApp && <div className="sh-note">Build something first — there's nothing to commit yet.</div>}
                {hasApp && (
                  <div className="sh-note">
                    {fileCount} file{fileCount === 1 ? '' : 's'} will be committed, exactly as they appear in the file
                    explorer.
                  </div>
                )}

                {link.lastPushedAt && !result && (
                  <div className="sh-meta">
                    <span>
                      last pushed {fmtWhen(link.lastPushedAt)}
                      {link.lastPushedBy ? ` by ${link.lastPushedBy}` : ''}
                    </span>
                    {link.lastCommitUrl && (
                      <a href={link.lastCommitUrl} target="_blank" rel="noopener noreferrer">
                        {link.lastCommitSha?.slice(0, 7)}
                      </a>
                    )}
                  </div>
                )}
              </section>

              {result && (
                <section className="sh-block">
                  <h3>
                    <Spark width={14} height={14} /> {result.unchanged ? 'Already up to date' : 'Pushed'}
                  </h3>
                  {result.unchanged ? (
                    <p>
                      The branch already held exactly these files, so no commit was made — an empty commit every time you
                      pressed the button would be noise in your history.
                    </p>
                  ) : (
                    <>
                      <p>
                        {result.createdBranch
                          ? `Created ${result.branch} with your first commit.`
                          : `Committed to ${result.branch}.`}{' '}
                        {result.written.length} file{result.written.length === 1 ? '' : 's'} written
                        {result.removed.length > 0
                          ? `, ${result.removed.length} removed (${result.removed.join(', ')})`
                          : ''}
                        .
                      </p>
                      <div className="sh-row">
                        <input className="sh-url" value={result.commitUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
                        <button
                          className="btn ghost"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(result.commitUrl)
                              toast('Commit link copied')
                            } catch {
                              toast('Copy failed — select the link and copy it manually.')
                            }
                          }}
                        >
                          <Copy width={14} height={14} /> Copy
                        </button>
                      </div>
                    </>
                  )}
                  <div className="sh-actions">
                    <a className="btn ghost" href={result.commitUrl} target="_blank" rel="noopener noreferrer">
                      View commit
                    </a>
                    <a className="btn ghost" href={result.branchUrl} target="_blank" rel="noopener noreferrer">
                      Open repository
                    </a>
                  </div>
                </section>
              )}
            </>
          )}

          {account && (
            <section className="sh-block">
              <button className="sh-link" onClick={disconnect}>
                <Trash width={13} height={13} /> Disconnect GitHub and delete the stored token
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
