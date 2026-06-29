import { useState } from 'react'
import { useAuth } from './auth'
import { Spark } from './icons'

export function Login() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'login') await login(email.trim(), password)
      else await register(name.trim(), email.trim(), password)
    } catch (err: any) {
      setError(err?.message || 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <div className="mark">
            <Spark width={20} height={20} />
          </div>
          <div className="wordmark">
            Lum<b>en</b>
          </div>
        </div>

        <h2>{mode === 'login' ? 'Welcome back' : 'Create your space'}</h2>
        <p className="sub">
          {mode === 'login'
            ? 'Sign in to open your projects and build together in real time.'
            : 'One account to describe, build, and collaborate on live apps.'}
        </p>

        {mode === 'register' && (
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" required />
          </div>
        )}
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@studio.com" autoComplete="email" required />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? 'At least 6 characters' : '••••••••'}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
        </div>

        <div className="auth-error">{error}</div>

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <div className="auth-toggle">
          {mode === 'login' ? (
            <>New to Lumen? <button type="button" onClick={() => { setMode('register'); setError('') }}>Create an account</button></>
          ) : (
            <>Already have an account? <button type="button" onClick={() => { setMode('login'); setError('') }}>Sign in</button></>
          )}
        </div>
      </form>
    </div>
  )
}
