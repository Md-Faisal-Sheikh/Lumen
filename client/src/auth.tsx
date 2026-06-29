import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, getToken, setToken, type PublicUser } from './api'

interface AuthState {
  user: PublicUser | null
  ready: boolean
  login: (email: string, password: string) => Promise<void>
  register: (name: string, email: string, password: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null)
  const [ready, setReady] = useState(false)

  // Restore a session from a stored token on first load.
  useEffect(() => {
    let active = true
    ;(async () => {
      if (!getToken()) {
        setReady(true)
        return
      }
      try {
        const { user } = await api.me()
        if (active) setUser(user)
      } catch {
        setToken(null)
      } finally {
        if (active) setReady(true)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const login = async (email: string, password: string) => {
    const { token, user } = await api.login({ email, password })
    setToken(token)
    setUser(user)
  }

  const register = async (name: string, email: string, password: string) => {
    const { token, user } = await api.register({ name, email, password })
    setToken(token)
    setUser(user)
  }

  const logout = () => {
    setToken(null)
    setUser(null)
  }

  return <AuthContext.Provider value={{ user, ready, login, register, logout }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
