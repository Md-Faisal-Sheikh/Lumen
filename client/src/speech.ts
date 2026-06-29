import { useRef, useState } from 'react'

// Voice mode is powered entirely by the browser's built-in Web Speech API —
// no external service, no API key, no cost. Speech-to-text for input, and
// optional text-to-speech for Lumen's replies.

function getRecognition(): any | null {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  return SR ? new SR() : null
}

export const speechInputSupported = () =>
  !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

export const speechOutputSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window

// Speak a short string aloud (used for assistant summaries when voice output is on).
export function speak(text: string) {
  try {
    if (!speechOutputSupported() || !text) return
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.02
    u.pitch = 1.0
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(u)
  } catch {
    /* ignore */
  }
}

export function stopSpeaking() {
  try {
    if (speechOutputSupported()) window.speechSynthesis.cancel()
  } catch {
    /* ignore */
  }
}

interface DictationOptions {
  onText: (text: string) => void
  onError?: (message: string) => void
}

// A small hook that streams recognized speech into the composer text.
export function useDictation({ onText, onError }: DictationOptions) {
  const recRef = useRef<any>(null)
  const baseRef = useRef('')
  const [listening, setListening] = useState(false)
  const supported = speechInputSupported()

  const start = (currentText: string) => {
    if (listening) return
    const rec = getRecognition()
    if (!rec) {
      onError?.("Voice input isn't supported in this browser. Try Chrome, Edge, or Safari.")
      return
    }
    recRef.current = rec
    baseRef.current = currentText.trim() ? currentText.trim() + ' ' : ''
    rec.lang = 'en-US'
    rec.continuous = true
    rec.interimResults = true

    rec.onresult = (event: any) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) final += transcript
        else interim += transcript
      }
      if (final) baseRef.current += final
      onText((baseRef.current + interim).replace(/\s+/g, ' ').trim())
    }
    rec.onerror = (event: any) => {
      if (event?.error && event.error !== 'no-speech' && event.error !== 'aborted') {
        onError?.('Voice input stopped unexpectedly.')
      }
      setListening(false)
    }
    rec.onend = () => setListening(false)

    try {
      rec.start()
      setListening(true)
    } catch {
      /* already started */
    }
  }

  const stop = () => {
    try {
      recRef.current?.stop()
    } catch {
      /* ignore */
    }
    setListening(false)
  }

  const toggle = (currentText: string) => (listening ? stop() : start(currentText))

  return { listening, supported, start, stop, toggle }
}
