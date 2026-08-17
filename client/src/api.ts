import type { LineEdit } from './files'
import type { Runtime } from './runtime'

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
  /** Which engine runs this project's code. Absent on older responses = 'web'. */
  runtime?: Runtime
  /** Offered as a starting point anyone signed in may fork. */
  isTemplate?: boolean
  description?: string | null
  forkCount?: number
  /** The name of the project this one was forked from, if any. */
  forkedFromName?: string | null
  updatedAt?: string
}
export interface Publication {
  slug: string
  /** Absolute link to hand out — works without a Lumen account. */
  url: string
  views: number
  /** Whether this page appears in the public gallery. Separate from publishing. */
  listed: boolean
  publishedAt: string
  updatedAt: string
}
export interface Version {
  id: string
  /** What produced this checkpoint — the prompt, the edit, or a restore. */
  prompt: string
  createdAt: string
}
export interface VersionDetail extends Version {
  /** The full marker-format workspace as it stood. */
  html: string
}
export interface TemplateCard {
  id: string
  name: string
  description: string | null
  runtime: Runtime
  forkCount: number
  updatedAt: string
  authorName: string
  authorColor: string
}
export interface GalleryCard {
  slug: string
  title: string
  url: string
  views: number
  runtime: Runtime
  updatedAt: string
  authorName: string
  authorColor: string
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
  createProject: (name: string, runtime: Runtime = 'web') =>
    req<{ project: ProjectSummary }>('/api/projects', { method: 'POST', body: JSON.stringify({ name, runtime }) }),
  project: (id: string) => req<{ project: any }>(`/api/projects/${id}`),
  rename: (id: string, name: string) => req(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  // Template settings live on the same PATCH; separated here because they are
  // owner-only and the call sites are different screens.
  setTemplate: (id: string, body: { isTemplate?: boolean; description?: string | null }) =>
    req<{ ok: true; project: ProjectSummary }>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  fork: (id: string, name?: string) =>
    req<{ project: ProjectSummary }>(`/api/projects/${id}/fork`, { method: 'POST', body: JSON.stringify({ name }) }),
  invite: (id: string, email: string) => req(`/api/projects/${id}/invite`, { method: 'POST', body: JSON.stringify({ email }) }),

  // ── History ──
  versions: (id: string) => req<{ versions: Version[] }>(`/api/projects/${id}/versions`),
  version: (id: string, versionId: string) =>
    req<{ version: VersionDetail }>(`/api/projects/${id}/versions/${versionId}`),
  // The current workspace travels with the request so the server can snapshot
  // it before handing back the old one — which is what makes Restore undoable.
  restoreVersion: (id: string, versionId: string, body: { currentCode: string; label: string }) =>
    req<{ version: VersionDetail }>(`/api/projects/${id}/versions/${versionId}/restore`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── Discovery (unauthenticated on the server; the token is sent and ignored) ──
  templates: () => req<{ templates: TemplateCard[] }>('/api/discover/templates'),
  gallery: () => req<{ pages: GalleryCard[] }>('/api/discover/gallery'),
  edit: (id: string, prompt: string, currentCode: string) =>
    req<{ summary: string | null; edits: LineEdit[]; skipped: string[]; detail: string }>(`/api/projects/${id}/edit`, {
      method: 'POST',
      body: JSON.stringify({ prompt, currentCode }),
    }),
  cacheStats: () => req<{ stats: CacheStats }>('/api/cache/stats'),
  publication: (id: string) => req<{ publication: Publication | null }>(`/api/projects/${id}/publish`),
  // `listed` is omitted rather than defaulted on an update, so refreshing a
  // published page never silently changes whether it appears in the gallery.
  publish: (id: string, html: string, listed?: boolean) =>
    req<{ publication: Publication }>(`/api/projects/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify(listed === undefined ? { html } : { html, listed }),
    }),
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
