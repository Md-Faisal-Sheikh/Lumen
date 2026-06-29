import { useEffect, useState } from 'react'

type Listener = (msg: string) => void
let listeners: Listener[] = []

export function toast(message: string) {
  listeners.forEach((l) => l(message))
}

export function Toast() {
  const [message, setMessage] = useState('')
  const [show, setShow] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const listener: Listener = (msg) => {
      setMessage(msg)
      setShow(true)
      clearTimeout(timer)
      timer = setTimeout(() => setShow(false), 2400)
    }
    listeners.push(listener)
    return () => {
      listeners = listeners.filter((l) => l !== listener)
      clearTimeout(timer)
    }
  }, [])
  return (
    <div className={`toast ${show ? 'show' : ''}`} role="status" aria-live="polite">
      <span className="toast-dot" />
      {message}
    </div>
  )
}
