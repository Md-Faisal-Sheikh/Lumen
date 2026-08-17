// GitHub: connect an account, point a project at a repository, and push the
// workspace as a real commit.
//
// Until now the only way out of Lumen was the ZIP export — a folder on your
// desktop with no history. This turns a generated app into something you keep:
// the files land in a repo at their real paths, in a commit with a parent, on a
// branch you can clone, deploy from Pages, or open a pull request against.
//
// Three decisions shape everything below.
//
// **A personal access token, not an OAuth app.** OAuth would mean registering an
// application, holding a client secret, and hosting a callback URL — three things
// a self-hosted Lumen would each have to be configured with. A token the user
// pastes in needs none of that and works on a laptop with no public hostname,
// which is the deployment this project is actually built for. It is stored
// encrypted (crypto.ts) and never sent back to the browser.
//
// **The commit is built through the Git Data API, not the contents API.** Writing
// files one at a time would produce one commit per file and leave the repo in a
// broken half-state if the third of five failed. Building a tree and moving the
// branch ref once means the whole workspace lands as a single atomic commit, the
// same way `git commit` does.
//
// **A push adds and updates; it deletes only what Lumen itself put there.** The
// commit is made with `base_tree` set to the branch's current tree, so a README,
// a LICENSE, or a CI workflow that Lumen never wrote is carried through
// untouched. That alone would leave a file deleted in Lumen living in the repo
// forever, so each push records the paths it wrote (`GitHubLink.pushedPaths`) and
// the next one explicitly removes the ones that are gone. Nothing outside that
// list is ever removed.

import { Router, type Request, type Response } from 'express'
import { prisma } from './db'
import { authMiddleware } from './auth'
import { open, seal } from './crypto'
import { normalizePath } from './edits'

export const githubRouter = Router()
githubRouter.use(authMiddleware)

const uid = (req: Request) => (req as any).userId as string

const API = 'https://api.github.com'

// ── Shapes ──────────────────────────────────────────────────────────

export interface RepoRef {
  owner: string
  repo: string
  branch: string
}

export interface PushFile {
  path: string
  content: string
}

// GitHub's own rules, applied before a value is interpolated into a URL. These
// are the only strings from the client that ever reach a path segment, so they
// are matched whole rather than escaped: a name that isn't a legal GitHub name is
// a bad request, not something to sanitize into a different one.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/
// Branches permit far more than this; refusing the exotic end of the set keeps a
// name from ever being read as a path or a query.
const BRANCH_RE = /^(?!\/|\.)[A-Za-z0-9._\/-]{1,120}$/

// Ceilings on a push. Lumen projects are a handful of small text files; anything
// past this is a client that has gone wrong, and it is better refused with a
// number than sent to GitHub to be refused less clearly.
const MAX_FILES = 60
const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 3 * 1024 * 1024

// ── Errors ──────────────────────────────────────────────────────────

/** A GitHub failure with a status worth passing to the client and a message
 *  worth reading. `status` is the status Lumen answers with, not GitHub's. */
class GhError extends Error {
  status: number
  /** GitHub's own `message`, kept so callers can tell apart two failures that
   *  share a status — "Git Repository is empty" and "repository is unavailable"
   *  are both 409 and only one of them is worth retrying. */
  raw: string
  constructor(message: string, status = 502, raw = '') {
    super(message)
    this.status = status
    this.raw = raw
  }
}

/** A 409 meaning "this repository has no commits yet", as opposed to the other
 *  409, which means GitHub is still busy creating the repository. */
const isEmptyRepo = (err: unknown): boolean =>
  err instanceof GhError && err.status === 409 && /empty/i.test(err.raw)

/**
 * Translate a GitHub failure into something with a fix in it.
 *
 * The raw bodies are unhelpful at exactly the moments that matter: a token
 * missing the `repo` scope and a repository that does not exist both answer 404,
 * because GitHub will not confirm the existence of something you cannot see.
 * Saying so is more use than relaying "Not Found".
 */
async function ghError(r: Response_, context: string): Promise<GhError> {
  let detail = ''
  try {
    const body: any = await r.json()
    detail = body?.message || ''
    // Validation failures carry the useful part in `errors`, not `message`.
    if (Array.isArray(body?.errors) && body.errors.length) {
      const first = body.errors[0]
      const extra = first?.message || `${first?.field ?? ''} ${first?.code ?? ''}`.trim()
      if (extra) detail = detail ? `${detail} — ${extra}` : extra
    }
  } catch {
    /* a body that isn't JSON tells us nothing extra */
  }

  switch (r.status) {
    case 401:
      return new GhError('GitHub rejected your token. It may have been revoked or expired — reconnect your account.', 401, detail)
    case 403:
      // 403 is both "rate limited" and "your token isn't allowed to do that",
      // and the remaining-quota header is what separates them.
      if (r.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(r.headers.get('x-ratelimit-reset') ?? 0) * 1000
        const mins = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60000)) : null
        return new GhError(
          `GitHub's rate limit is used up${mins ? ` — it resets in about ${mins} minute${mins === 1 ? '' : 's'}` : ''}.`,
          429,
          detail
        )
      }
      return new GhError(
        `GitHub refused that (${context}). Your token likely lacks write access to this repository — a classic token needs the "repo" scope, a fine-grained one needs Contents: Read and write.`,
        403,
        detail
      )
    case 404:
      return new GhError(
        `GitHub couldn't find that repository (${context}). Either it doesn't exist, or your token can't see it — a private repo needs the "repo" scope.`,
        404,
        detail
      )
    case 409:
      // Two different situations share this status. An empty repository is
      // handled by the caller (it initializes it and carries on), so reaching
      // here with "empty" means it happened somewhere unexpected — say so with
      // the step, rather than telling the user to retry something that cannot work.
      return new GhError(
        /empty/i.test(detail)
          ? `GitHub refused to write into an empty repository (${context}). Add any file to it on GitHub — a README will do — then push again.`
          : `GitHub says that repository is not ready yet (${context}). It may still be being created; try again in a moment.`,
        409,
        detail
      )
    case 422:
      return new GhError(detail ? `GitHub rejected that: ${detail}` : `GitHub rejected that request (${context}).`, 422, detail)
    default:
      return new GhError(`GitHub error ${r.status}${detail ? `: ${detail}` : ''} (${context})`, 502, detail)
  }
}

// `Response` is shadowed by Express's own type in this file.
type Response_ = Awaited<ReturnType<typeof fetch>>

// ── The client ──────────────────────────────────────────────────────

/** One authenticated GitHub call. Throws GhError on anything but a 2xx. */
async function gh<T = any>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; context: string }
): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Lumen',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  if (!r.ok) throw await ghError(r, init.context)
  // 204s (and a DELETE) have no body to parse.
  if (r.status === 204) return undefined as T
  return (await r.json()) as T
}

/**
 * Read the branch's head, or null when there isn't one.
 *
 * Two different failures both mean "nothing to build on", and missing the second
 * is what made a first push to a fresh repository fail outright:
 *   · **404** — the repository has commits, but not on this branch.
 *   · **409 "Git Repository is empty."** — the repository has no commits at all.
 *     Every Git-database endpoint answers this way while a repo is empty, so the
 *     read that is *meant* to discover emptiness cannot treat it as an error.
 */
async function readHead(token: string, base: string, branch: string): Promise<string | null> {
  try {
    const data = await gh<{ object: { sha: string } }>(
      token,
      `${base}/git/ref/heads/${encodeURIComponent(branch)}`,
      { context: 'reading the branch' }
    )
    return data?.object?.sha ?? null
  } catch (err) {
    if (err instanceof GhError && (err.status === 404 || isEmptyRepo(err))) return null
    throw err
  }
}

// ── Account plumbing ────────────────────────────────────────────────

/** The caller's decrypted token, or a GhError telling them to (re)connect. */
async function tokenFor(userId: string): Promise<string> {
  const account = await prisma.gitHubAccount.findUnique({ where: { userId } })
  if (!account) throw new GhError('Connect your GitHub account first.', 400)
  const token = open(account.tokenCipher)
  if (!token) {
    // Only reachable if JWT_SECRET changed under us or the row was edited: the
    // stored bytes are no longer openable, so the connection is dead weight.
    throw new GhError('Your stored GitHub token could not be read. Reconnect your account.', 400)
  }
  return token
}

const shapeAccount = (a: { login: string; avatarUrl: string | null; scopes: string; createdAt: Date }) => ({
  login: a.login,
  avatarUrl: a.avatarUrl,
  // Reported so the UI can warn *before* a push fails on a read-only token.
  scopes: a.scopes ? a.scopes.split(',').map((s) => s.trim()).filter(Boolean) : [],
  connectedAt: a.createdAt,
})

// ── Committing ──────────────────────────────────────────────────────

interface TreeEntry {
  path: string
  mode: '100644'
  type: 'blob'
  content?: string
  sha?: null
}

export interface PushResult {
  commitSha: string
  commitUrl: string
  branch: string
  /** Paths written by this push — recorded so the next one can delete what goes away. */
  written: string[]
  removed: string[]
  /** True when the workspace already matched the branch and no commit was made. */
  unchanged: boolean
  /** Set when this push created the branch (a repo that had no commits). */
  createdBranch: boolean
}

/** A file GitHub can accept into an empty repository to bring it into existence.
 *  Never reaches any commit the branch ends up pointing at — see below. */
const INIT_PATH = '.lumen-init'

/**
 * Does this repository have no commits at all?
 *
 * Asked only when the target branch has no head, which is where two very
 * different situations meet: a brand-new repository that needs initializing, and
 * an existing repository where the user simply named a branch that doesn't exist
 * yet. The first needs the contents-API bootstrap; the second must not get one,
 * because it would add a stray commit to a repository that is working fine.
 *
 * `GET /commits` is the probe because it answers 409 "Git Repository is empty."
 * for exactly this state and 200 otherwise.
 */
async function isRepoEmpty(token: string, base: string): Promise<boolean> {
  try {
    await gh(token, `${base}/commits?per_page=1`, { context: 'checking whether the repository has any commits' })
    return false
  } catch (err) {
    if (isEmptyRepo(err)) return true
    // A 404 here means the repo has no commits *and* GitHub reports it that way,
    // which some paths do; treating it as empty is the useful reading.
    if (err instanceof GhError && err.status === 404) return true
    throw err
  }
}

/**
 * Make an empty repository usable, and return the commit that did it.
 *
 * GitHub's Git-database endpoints — blobs, trees, commits, refs — all refuse a
 * repository with no commits, so the tree-based push below cannot bootstrap one.
 * The documented way in is the *contents* API, which creates a file, the initial
 * commit, and the branch in a single call:
 *
 *   https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database
 *   "The REST API will return a 409 Conflict if the Git repository is empty…
 *    you can use PUT /repos/{owner}/{repo}/contents/{path} … to create content
 *    and initialize the repository so you can use the API to manage the Git database."
 *
 * What it writes is a placeholder, not a project file, because the caller then
 * replaces this commit outright with a root commit holding the real workspace.
 * The user is left with a branch whose entire history is their own first commit —
 * no placeholder, no "Initial commit" noise above their work.
 */
async function initializeEmptyRepo(token: string, base: string, branch: string): Promise<string> {
  const created = await gh<{ commit: { sha: string } }>(token, `${base}/contents/${INIT_PATH}`, {
    method: 'PUT',
    context: 'initializing the empty repository',
    body: {
      message: 'Initialize repository',
      content: Buffer.from('Created by Lumen.\n', 'utf8').toString('base64'),
      branch,
    },
  })
  return created.commit.sha
}

/**
 * Push `files` to `ref` as one commit.
 *
 * The sequence is the one `git` itself performs: read the branch, build a tree on
 * top of its tree, write a commit pointing at that tree with the old head as its
 * parent, then move the branch. Nothing is visible in the repository until that
 * last step, so a failure anywhere leaves the branch exactly where it was.
 *
 * Exported for testing. A multi-step protocol against someone else's API is
 * exactly the code that needs driving against a stub — the empty-repository path
 * below shipped broken once because this was reachable only through a route, a
 * database row, and a real token.
 */
export async function pushCommit(
  token: string,
  ref: RepoRef,
  files: PushFile[],
  previouslyPushed: string[],
  message: string
): Promise<PushResult> {
  const { owner, repo, branch } = ref
  const base = `/repos/${owner}/${repo}`
  const enc = encodeURIComponent(branch)

  // 1 · Where the branch is now. Absent means either a repository with no
  //     commits, or a branch that doesn't exist yet — both are pushable with no
  //     parent commit.
  let headSha = await readHead(token, base, branch)

  // A repository with no commits accepts nothing from the Git-database API, so
  // it is initialized through the contents API first. `discard` is that
  // placeholder commit: the workspace goes in as a *root* commit below and the
  // branch is moved onto it, leaving this one unreferenced.
  let discard: string | null = null
  if (headSha === null) {
    const empty = await isRepoEmpty(token, base)
    if (empty) {
      discard = await initializeEmptyRepo(token, base, branch)
      headSha = null // deliberately: the real commit is parented on nothing
    }
  }

  // 2 · The tree that commit points at, which the new tree is layered onto. This
  //     is what preserves files Lumen never wrote.
  let baseTreeSha: string | null = null
  let existingPaths = new Set<string>()
  if (headSha) {
    const commit = await gh<{ tree: { sha: string } }>(token, `${base}/git/commits/${headSha}`, {
      context: 'reading the last commit',
    })
    baseTreeSha = commit.tree.sha
    // The full path list, so a deletion is only ever requested for something
    // that is actually there — GitHub rejects a tree that deletes a path it
    // cannot find, which would fail the whole push over a file already gone.
    const tree = await gh<{ tree: Array<{ path: string; type: string }>; truncated?: boolean }>(
      token,
      `${base}/git/trees/${baseTreeSha}?recursive=1`,
      { context: 'reading the repository tree' }
    )
    existingPaths = new Set(tree.tree.filter((t) => t.type === 'blob').map((t) => t.path))
  }

  // 3 · Additions and updates, then the removals: paths this project put in the
  //     repo on an earlier push, no longer in the workspace, still present on the
  //     branch. A `sha: null` entry is how the Git Data API spells "delete".
  const written = files.map((f) => f.path)
  const writtenSet = new Set(written)
  const removed = previouslyPushed.filter((p) => !writtenSet.has(p) && existingPaths.has(p))

  const entries: TreeEntry[] = [
    ...files.map((f): TreeEntry => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    ...removed.map((p): TreeEntry => ({ path: p, mode: '100644', type: 'blob', sha: null })),
  ]

  const newTree = await gh<{ sha: string }>(token, `${base}/git/trees`, {
    method: 'POST',
    context: 'writing the file tree',
    body: { ...(baseTreeSha ? { base_tree: baseTreeSha } : {}), tree: entries },
  })

  // 4 · An identical tree means the branch already holds exactly this workspace.
  //     Committing anyway would add an empty commit to someone's history every
  //     time they pressed the button, so say "already up to date" instead.
  if (baseTreeSha && newTree.sha === baseTreeSha) {
    return {
      commitSha: headSha!,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${headSha}`,
      branch,
      written,
      removed: [],
      unchanged: true,
      createdBranch: false,
    }
  }

  const commit = await gh<{ sha: string; html_url?: string }>(token, `${base}/git/commits`, {
    method: 'POST',
    context: 'writing the commit',
    body: { message, tree: newTree.sha, parents: headSha ? [headSha] : [] },
  })

  // 5 · Move the branch — the step that makes any of this visible. Three cases,
  //     because there are three ways the branch can currently stand.
  if (headSha) {
    // Ordinary push. The parent is the head read in step 1, so this is a
    // fast-forward unless someone pushed in between; `force` stays off so that
    // race is reported rather than resolved by discarding their commit.
    try {
      await gh(token, `${base}/git/refs/heads/${enc}`, {
        method: 'PATCH',
        context: 'moving the branch',
        body: { sha: commit.sha, force: false },
      })
    } catch (err) {
      if (err instanceof GhError && err.status === 422) {
        throw new GhError(
          `${branch} moved on GitHub while this push was being prepared, so it was not applied. Push again to build on the new commit.`,
          409
        )
      }
      throw err
    }
  } else if (discard) {
    // The repository was empty a moment ago and the contents API created the
    // branch to initialize it. Our commit is a root commit, so it is not a
    // descendant of that placeholder and the move has to be forced.
    //
    // This is the one place Lumen forces a ref, and it is safe in a way a real
    // force push is not: the commit being discarded was written by this same
    // request, seconds ago, and contains one placeholder file that no user has
    // ever seen. Nobody's work can be behind it.
    await gh(token, `${base}/git/refs/heads/${enc}`, {
      method: 'PATCH',
      context: 'replacing the initial commit',
      body: { sha: commit.sha, force: true },
    })
  } else {
    // The repository has commits, but not on this branch — create it.
    await gh(token, `${base}/git/refs`, {
      method: 'POST',
      context: 'creating the branch',
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    })
  }

  return {
    commitSha: commit.sha,
    commitUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
    branch,
    written,
    removed,
    unchanged: false,
    // True whenever this push is the branch's first commit, whether it created
    // the branch outright or replaced the placeholder that initialized the repo.
    createdBranch: !headSha,
  }
}

// ── Routes: the account ─────────────────────────────────────────────

/** Whether this user has GitHub connected, and as whom. Never the token. */
githubRouter.get('/account', async (req, res) => {
  const account = await prisma.gitHubAccount.findUnique({ where: { userId: uid(req) } })
  res.json({ account: account ? shapeAccount(account) : null })
})

/**
 * Connect, by validating a pasted token against GitHub and sealing it.
 *
 * The token is checked before it is stored — a typo should be an error message
 * here, not a mysterious failure on the first push. `GET /user` also tells us who
 * the token belongs to, so the UI can show the account rather than making the
 * user trust that the right one went in.
 */
githubRouter.post('/connect', async (req, res) => {
  const token = (req.body?.token ?? '').toString().trim()
  if (!token) return res.status(400).json({ error: 'Paste a GitHub personal access token.' })
  // Cheap shape check with a real hint: pasting a URL or a password here is a
  // much more likely mistake than a token GitHub would reject.
  if (token.length < 20 || /\s/.test(token)) {
    return res.status(400).json({ error: "That doesn't look like a token. It should be one long string, like ghp_… or github_pat_…" })
  }

  try {
    const r = await fetch(`${API}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Lumen',
      },
    })
    if (!r.ok) throw await ghError(r, 'checking the token')
    const me: any = await r.json()
    // Classic tokens report their scopes in a header; fine-grained ones report
    // nothing, so an empty value means "unknown", not "none".
    const scopes = r.headers.get('x-oauth-scopes') ?? ''

    const data = {
      login: String(me?.login ?? 'unknown'),
      avatarUrl: me?.avatar_url ? String(me.avatar_url) : null,
      scopes,
      tokenCipher: seal(token),
    }
    const account = await prisma.gitHubAccount.upsert({
      where: { userId: uid(req) },
      create: { userId: uid(req), ...data },
      update: data,
    })
    res.json({ account: shapeAccount(account) })
  } catch (err: any) {
    const status = err instanceof GhError ? err.status : 502
    res.status(status).json({ error: err?.message || 'Could not reach GitHub.' })
  }
})

/** Disconnect. The sealed token is deleted outright — there is no reason to keep
 *  it, and a revoked connection that still holds a credential is a liability. */
githubRouter.delete('/account', async (req, res) => {
  await prisma.gitHubAccount.deleteMany({ where: { userId: uid(req) } })
  res.json({ ok: true })
})

/** Repositories this token can push to, for the picker. Sorted by recent
 *  activity, which is nearly always where the one you want is. */
githubRouter.get('/repos', async (req, res) => {
  try {
    const token = await tokenFor(uid(req))
    const repos = await gh<any[]>(token, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator', {
      context: 'listing your repositories',
    })
    res.json({
      repos: repos
        .filter((r) => !r.archived && r.permissions?.push !== false)
        .map((r) => ({
          owner: r.owner?.login,
          repo: r.name,
          fullName: r.full_name,
          private: !!r.private,
          defaultBranch: r.default_branch || 'main',
          empty: r.size === 0,
          updatedAt: r.pushed_at || r.updated_at,
        })),
    })
  } catch (err: any) {
    res.status(err instanceof GhError ? err.status : 502).json({ error: err?.message || 'Could not list repositories.' })
  }
})

/**
 * Create a repository to push into.
 *
 * Deliberately created empty — no auto-init, no generated README. The first push
 * is then the project's own first commit rather than a merge on top of a file
 * GitHub wrote, and the repo's history starts with the app in it.
 */
githubRouter.post('/repos', async (req, res) => {
  const name = (req.body?.name ?? '').toString().trim()
  if (!REPO_RE.test(name)) {
    return res.status(400).json({ error: 'Use letters, numbers, dots, hyphens or underscores for the repository name.' })
  }
  const isPrivate = req.body?.private !== false // private unless explicitly public
  try {
    const token = await tokenFor(uid(req))
    const repo = await gh<any>(token, '/user/repos', {
      method: 'POST',
      context: 'creating the repository',
      body: {
        name,
        private: isPrivate,
        description: (req.body?.description ?? 'Built with Lumen').toString().slice(0, 350),
        auto_init: false,
      },
    })
    res.json({
      repo: {
        owner: repo.owner?.login,
        repo: repo.name,
        fullName: repo.full_name,
        private: !!repo.private,
        defaultBranch: repo.default_branch || 'main',
        empty: true,
        updatedAt: repo.updated_at,
      },
    })
  } catch (err: any) {
    res.status(err instanceof GhError ? err.status : 502).json({ error: err?.message || 'Could not create the repository.' })
  }
})

// ── Routes: the project's repository ────────────────────────────────

async function membership(projectId: string, userId: string) {
  return prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } })
}

const shapeLink = (l: {
  owner: string
  repo: string
  branch: string
  lastCommitSha: string | null
  lastPushedAt: Date | null
  lastPushedBy: string | null
}) => ({
  owner: l.owner,
  repo: l.repo,
  branch: l.branch,
  fullName: `${l.owner}/${l.repo}`,
  url: `https://github.com/${l.owner}/${l.repo}/tree/${l.branch}`,
  lastCommitSha: l.lastCommitSha,
  lastCommitUrl: l.lastCommitSha ? `https://github.com/${l.owner}/${l.repo}/commit/${l.lastCommitSha}` : null,
  lastPushedAt: l.lastPushedAt,
  lastPushedBy: l.lastPushedBy,
})

/** Which repository this project pushes to. Any member can see it. */
githubRouter.get('/link/:projectId', async (req, res) => {
  if (!(await membership(req.params.projectId, uid(req))))
    return res.status(403).json({ error: "You don't have access to this project." })
  const link = await prisma.gitHubLink.findUnique({ where: { projectId: req.params.projectId } })
  res.json({ link: link ? shapeLink(link) : null })
})

/**
 * Point the project at a repository. Owner only — it is a project-wide setting
 * that decides where everyone's pushes land, which is the same reason inviting
 * and publishing are owner-only.
 *
 * Re-linking to a different repository clears `pushedPaths`: that list describes
 * what Lumen wrote *in the old repo*, and carrying it across would let the first
 * push into the new one delete paths it never created there.
 */
githubRouter.put('/link/:projectId', async (req, res) => {
  const projectId = req.params.projectId
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  if (project.ownerId !== uid(req))
    return res.status(403).json({ error: 'Only the project owner can choose its repository.' })

  const owner = (req.body?.owner ?? '').toString().trim()
  const repo = (req.body?.repo ?? '').toString().trim()
  const branch = ((req.body?.branch ?? '').toString().trim() || 'main') as string
  if (!LOGIN_RE.test(owner)) return res.status(400).json({ error: 'That repository owner is not a valid GitHub name.' })
  if (!REPO_RE.test(repo)) return res.status(400).json({ error: 'That repository name is not valid.' })
  if (!BRANCH_RE.test(branch)) return res.status(400).json({ error: 'That branch name is not valid.' })

  const existing = await prisma.gitHubLink.findUnique({ where: { projectId } })
  const movedRepo = existing && (existing.owner !== owner || existing.repo !== repo)
  const data = {
    owner,
    repo,
    branch,
    ...(movedRepo ? { pushedPaths: '[]', lastCommitSha: null, lastPushedAt: null, lastPushedBy: null } : {}),
  }
  const link = await prisma.gitHubLink.upsert({
    where: { projectId },
    create: { projectId, owner, repo, branch },
    update: data,
  })
  res.json({ link: shapeLink(link) })
})

/** Unlink. Nothing on GitHub is touched — the repo and its commits stay. */
githubRouter.delete('/link/:projectId', async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } })
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  if (project.ownerId !== uid(req))
    return res.status(403).json({ error: 'Only the project owner can change its repository.' })
  await prisma.gitHubLink.deleteMany({ where: { projectId: req.params.projectId } })
  res.json({ ok: true })
})

/**
 * Commit and push the workspace.
 *
 * Any member may push, with **their own** connected account — the repository is
 * the project's, but the credential and therefore the commit's authorship are the
 * person's. A collaborator who cannot write to the owner's repo gets GitHub's
 * refusal translated into what to fix, rather than being silently unable to use
 * a button that is right there.
 *
 * The files arrive from the client because the workspace lives in the Yjs
 * document, not the database — the browser holds the authoritative copy. Their
 * paths are re-validated here against the same rules the client applies, since
 * these become paths in somebody's repository.
 */
githubRouter.post('/push/:projectId', async (req: Request, res: Response) => {
  const projectId = req.params.projectId
  if (!(await membership(projectId, uid(req))))
    return res.status(403).json({ error: "You don't have access to this project." })

  const link = await prisma.gitHubLink.findUnique({ where: { projectId } })
  if (!link) return res.status(400).json({ error: 'Choose a repository for this project first.' })

  const raw = Array.isArray(req.body?.files) ? req.body.files : null
  if (!raw || raw.length === 0) return res.status(400).json({ error: 'There is nothing to push yet — build something first.' })
  if (raw.length > MAX_FILES) return res.status(400).json({ error: `That's ${raw.length} files — Lumen pushes at most ${MAX_FILES}.` })

  const files: PushFile[] = []
  const seen = new Set<string>()
  let total = 0
  for (const entry of raw) {
    const path = normalizePath((entry?.path ?? '').toString())
    if (!path) return res.status(400).json({ error: `"${entry?.path}" is not a valid file path.` })
    // A duplicate path would make the tree ambiguous and the commit arbitrary.
    if (seen.has(path)) return res.status(400).json({ error: `${path} appears twice in the workspace.` })
    seen.add(path)
    const content = (entry?.content ?? '').toString()
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_FILE_BYTES) return res.status(400).json({ error: `${path} is too large to push (over 512 KB).` })
    total += bytes
    if (total > MAX_TOTAL_BYTES) return res.status(400).json({ error: 'That workspace is too large to push (over 3 MB).' })
    files.push({ path, content })
  }

  const user = await prisma.user.findUnique({ where: { id: uid(req) } })
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  const message =
    (req.body?.message ?? '').toString().trim().slice(0, 500) || `Update ${project?.name ?? 'project'} from Lumen`

  let previouslyPushed: string[] = []
  try {
    const parsed = JSON.parse(link.pushedPaths)
    if (Array.isArray(parsed)) previouslyPushed = parsed.filter((p): p is string => typeof p === 'string')
  } catch {
    // A corrupt list only costs us the ability to delete this round; a push that
    // adds and updates is still correct, so it is not worth failing over.
  }

  try {
    const token = await tokenFor(uid(req))
    const result = await pushCommit(
      token,
      { owner: link.owner, repo: link.repo, branch: link.branch },
      files,
      previouslyPushed,
      message
    )

    // Record what went in, so the next push knows what to remove. Skipped when
    // nothing was committed: the stored list already describes the branch.
    if (!result.unchanged) {
      await prisma.gitHubLink.update({
        where: { projectId },
        data: {
          pushedPaths: JSON.stringify(result.written),
          lastCommitSha: result.commitSha,
          lastPushedAt: new Date(),
          lastPushedBy: user?.name ?? null,
        },
      })
    }

    res.json({
      push: {
        ...result,
        fullName: `${link.owner}/${link.repo}`,
        branchUrl: `https://github.com/${link.owner}/${link.repo}/tree/${result.branch}`,
      },
    })
  } catch (err: any) {
    res.status(err instanceof GhError ? err.status : 502).json({ error: err?.message || 'The push did not complete.' })
  }
})
