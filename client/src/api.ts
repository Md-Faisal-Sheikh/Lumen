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
  publication: (id: string) => req<{ publication: Publication | null }>(`/api/projects/${id}/publish`),
  publish: (id: string, html: string) =>
    req<{ publication: Publication }>(`/api/projects/${id}/publish`, { method: 'POST', body: JSON.stringify({ html }) }),
  unpublish: (id: string) => req<{ ok: true }>(`/api/projects/${id}/publish`, { method: 'DELETE' }),
  inlineEdit: (id: string, body: { file: string; start: number; end: number; instruction: string; currentCode: string }) =>
    req<{ summary: string | null; edit: LineEdit; detail: string }>(`/api/projects/${id}/inline-edit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
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
