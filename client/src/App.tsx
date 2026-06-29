import { AuthProvider, useAuth } from './auth'
import { Aurora } from './Aurora'
import { Login } from './Login'
import { Editor } from './Editor'
import { Toast } from './toast'

function Splash() {
  return (
    <div className="splash">
      <div className="s-mark">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
        </svg>
      </div>
    </div>
  )
}

function Shell() {
  const { user, ready } = useAuth()
  return (
    <>
      <Aurora />
      {!ready ? <Splash /> : user ? <Editor /> : <Login />}
      <Toast />
    </>
  )
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
