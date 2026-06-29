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

export const api = {
  register: (body: { email: string; password: string; name: string }) =>
    req<{ token: string; user: PublicUser }>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: { email: string; password: string }) =>
    req<{ token: string; user: PublicUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  me: () => req<{ user: PublicUser }>('/api/auth/me'),
  projects: () => req<{ projects: ProjectSummary[] }>('/api/projects'),
  createProject: (name: string) => req<{ project: ProjectSummary }>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  project: (id: string) => req<{ project: any }>(`/api/projects/${id}`),
  rename: (id: string, name: string) => req(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  invite: (id: string, email: string) => req(`/api/projects/${id}/invite`, { method: 'POST', body: JSON.stringify({ email }) }),
  versions: (id: string) => req<{ versions: { id: string; prompt: string; createdAt: string }[] }>(`/api/projects/${id}/versions`),
}
