import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Note: StrictMode is intentionally omitted. It double-invokes effects in dev,
// which would open two WebSocket sessions per project for the real-time engine.
createRoot(document.getElementById('root')!).render(<App />)
