import type { LineEdit } from './files'

// Base URLs. Both default to a local server; override with VITE_API_URL / VITE_WS_URL.
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'
export const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:4000'

const TOKEN_KEY = 'lumen_token'
export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t: string | null) => {
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}

async function req<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(API_URL + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  })
  if (!res.ok) {
    let message = 'Something went wrong.'
    try {
      message = (await res.json()).error || message
    } catch {
      /* keep default */
    }
    throw new Error(message)
  }
  return res.json()
}

export interface PublicUser {
  id: string
  email: string
  name: string
  color: string
}
export interface ProjectSummary {
  id: string
  name: string
  ownerId: string
  role?: string
  updatedAt?: string
}
export interface Publication {
  slug: string
  /** Absolute link to hand out — works without a Lumen account. */
  url: string
  views: number
  publishedAt: string
  updatedAt: string
}
export interface CacheStats {
  entries: number
  lookups: number
  exactHits: number
  similarHits: number
  misses: number
  /** Percent of build requests answered without calling a model. */
  hitRate: number
  threshold: number
}
export interface GitHubAccount {
  login: string
  avatarUrl: string | null
  /** What GitHub reported for the token. Empty for fine-grained tokens, which
   *  don't publish their permissions — so an empty list means "unknown", not "none". */
  scopes: string[]
  connectedAt: string
}
export interface GitHubLink {
  owner: string
  repo: string
  branch: string
  fullName: string
  url: string
  lastCommitSha: string | null
  lastCommitUrl: string | null
  lastPushedAt: string | null
  lastPushedBy: string | null
}
export interface GitHubRepo {
  owner: string
  repo: string
  fullName: string
  private: boolean
  defaultBranch: string
  empty: boolean
  updatedAt: string
}
export interface PushResult {
  commitSha: string
  commitUrl: string
  branch: string
  branchUrl: string
  fullName: string
  written: string[]
  removed: string[]
  /** The branch already held exactly this workspace; no commit was made. */
  unchanged: boolean
  createdBranch: boolean
}
export interface ChatSessionSummary {
  id: string
  title: string
  kind?: 'auto' | 'manual' | string
  projectId: string
  projectName: string
  createdAt: string
  updatedAt?: string
  messageCount: number
}
export interface ChatSessionDetail extends Omit<ChatSessionSummary, 'messageCount'> {
  messages: any[]
}

export const api = {
  register: (body: { email: string; password: string; name: string }) =>
    req<{ token: string; user: PublicUser }>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: { email: string; password: string }) =>
    req<{ token: string; user: PublicUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  me: () => req<{ user: PublicUser }>('/api/auth/me'),
  updateMe: (body: { name?: string; color?: string }) =>
    req<{ user: PublicUser }>('/api/auth/me', { method: 'PATCH', body: JSON.stringify(body) }),
  projects: () => req<{ projects: ProjectSummary[] }>('/api/projects'),
  createProject: (name: string) => req<{ project: ProjectSummary }>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  project: (id: string) => req<{ project: any }>(`/api/projects/${id}`),
  rename: (id: string, name: string) => req(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  invite: (id: string, email: string) => req(`/api/projects/${id}/invite`, { method: 'POST', body: JSON.stringify({ email }) }),
  versions: (id: string) => req<{ versions: { id: string; prompt: string; createdAt: string }[] }>(`/api/projects/${id}/versions`),
  edit: (id: string, prompt: string, currentCode: string) =>
    req<{ summary: string | null; edits: LineEdit[]; skipped: string[]; detail: string }>(`/api/projects/${id}/edit`, {
      method: 'POST',
      body: JSON.stringify({ prompt, currentCode }),
    }),
  cacheStats: () => req<{ stats: CacheStats }>('/api/cache/stats'),
  publication: (id: string) => req<{ publication: Publication | null }>(`/api/projects/${id}/publish`),
  publish: (id: string, html: string) =>
    req<{ publication: Publication }>(`/api/projects/${id}/publish`, { method: 'POST', body: JSON.stringify({ html }) }),
  unpublish: (id: string) => req<{ ok: true }>(`/api/projects/${id}/publish`, { method: 'DELETE' }),
  inlineEdit: (id: string, body: { file: string; start: number; end: number; instruction: string; currentCode: string }) =>
    req<{ summary: string | null; edit: LineEdit; detail: string }>(`/api/projects/${id}/inline-edit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // ── Inline completion ──
  // Takes an AbortSignal rather than returning a cancel handle: the caller is a
  // CodeMirror plugin that already has one per request, and a superseded
  // suggestion must actually stop the fetch — the server aborts its own upstream
  // call when this connection closes.
  complete: (
    id: string,
    body: { file: string; prefix: string; suffix: string },
    signal?: AbortSignal
  ) =>
    req<{ completion: string | null }>(`/api/projects/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  // ── GitHub ──
  githubAccount: () => req<{ account: GitHubAccount | null }>('/api/github/account'),
  githubConnect: (token: string) =>
    req<{ account: GitHubAccount }>('/api/github/connect', { method: 'POST', body: JSON.stringify({ token }) }),
  githubDisconnect: () => req<{ ok: true }>('/api/github/account', { method: 'DELETE' }),
  githubRepos: () => req<{ repos: GitHubRepo[] }>('/api/github/repos'),
  githubCreateRepo: (body: { name: string; private: boolean; description?: string }) =>
    req<{ repo: GitHubRepo }>('/api/github/repos', { method: 'POST', body: JSON.stringify(body) }),
  githubLink: (projectId: string) => req<{ link: GitHubLink | null }>(`/api/github/link/${projectId}`),
  githubSetLink: (projectId: string, body: { owner: string; repo: string; branch: string }) =>
    req<{ link: GitHubLink }>(`/api/github/link/${projectId}`, { method: 'PUT', body: JSON.stringify(body) }),
  githubUnlink: (projectId: string) => req<{ ok: true }>(`/api/github/link/${projectId}`, { method: 'DELETE' }),
  githubPush: (projectId: string, body: { files: { path: string; content: string }[]; message?: string }) =>
    req<{ push: PushResult }>(`/api/github/push/${projectId}`, { method: 'POST', body: JSON.stringify(body) }),

  chats: (projectId?: string) =>
    req<{ sessions: ChatSessionSummary[] }>(`/api/chats${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  saveChat: (projectId: string, messages: any[], title?: string) =>
    req<{ session: { id: string; title: string; createdAt: string } }>('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ projectId, messages, title }),
    }),
  autosaveChat: (projectId: string, messages: any[], init?: { keepalive?: boolean }) =>
    req<{ session: { id: string; title: string; updatedAt: string } }>('/api/chats/autosave', {
      method: 'PUT',
      body: JSON.stringify({ projectId, messages }),
      ...(init?.keepalive ? { keepalive: true } : {}),
    }),
  chat: (id: string) => req<{ session: ChatSessionDetail }>(`/api/chats/${id}`),
  deleteChat: (id: string) => req<{ ok: true }>(`/api/chats/${id}`, { method: 'DELETE' }),
}
