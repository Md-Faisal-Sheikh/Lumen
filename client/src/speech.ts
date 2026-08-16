import { useCallback, useEffect, useRef, useState } from 'react'

// ── Voice mode ──────────────────────────────────────────────────────
// Speech in and speech out, both from the browser's built-in Web Speech API:
// no service, no key, no cost. Three properties of that API shape everything
// below, and none of them are what the option names suggest.
//
//  · Recognition is not continuous. Chrome ends a session after a few seconds
//    of quiet *even with* `continuous = true`, so pausing to think ends
//    dictation with no indication. Staying on means restarting it — which is
//    why the user's intent is tracked separately from whether the engine
//    happens to be running at this instant.
//
//  · Synthesis and recognition share a room. If Lumen reads a reply aloud
//    while the mic is live, the mic transcribes Lumen and the reply lands in
//    the composer. Speaking therefore suspends dictation and hands it back.
//
//  · A long utterance is cut off partway through in Chrome. Text is split into
//    sentence-sized pieces and queued, which keeps each one under the limit.

// ── Capability ──────────────────────────────────────────────────────

function getRecognition(): any | null {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  return SR ? new SR() : null
}

export const speechInputSupported = () =>
  !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

export const speechOutputSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window

/** The browser's own language. Better than assuming en-US, which mis-hears every other accent. */
export const speechLang = () => (typeof navigator !== 'undefined' && navigator.language) || 'en-US'

// ── Who has the microphone ──────────────────────────────────────────
// Dictation needs to know when Lumen is talking, and the two live in different
// components, so the state is published here rather than threaded through props.

const speakingListeners = new Set<(speaking: boolean) => void>()
let speaking = false

function setSpeaking(next: boolean) {
  if (next === speaking) return
  speaking = next
  for (const fn of speakingListeners) fn(next)
}

export function onSpeakingChange(fn: (speaking: boolean) => void) {
  speakingListeners.add(fn)
  return () => {
    speakingListeners.delete(fn)
  }
}

// ── Speech out ──────────────────────────────────────────────────────

// Chrome truncates any single utterance that runs much past ~15 seconds. At a
// normal rate this is comfortably under that, and short utterances also start
// speaking sooner.
const MAX_UTTERANCE = 180

function splitForSpeech(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const out: string[] = []
  // Sentence-ish pieces, each keeping its own terminator. Written without a
  // lookbehind, which older Safari does not parse.
  for (const raw of clean.match(/[^.!?…]+[.!?…]*\s*/g) ?? [clean]) {
    let rest = raw.trim()
    if (!rest) continue
    while (rest.length > MAX_UTTERANCE) {
      // Break at the last space inside the limit so words stay whole.
      let cut = rest.lastIndexOf(' ', MAX_UTTERANCE)
      if (cut <= 0) cut = MAX_UTTERANCE
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut).trimStart()
    }
    if (rest) out.push(rest)
  }
  return out
}

// Prefer a voice that actually speaks the requested language, and among those
// a local one — a network voice cuts out when the connection does.
function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  let voices: SpeechSynthesisVoice[] = []
  try {
    voices = window.speechSynthesis.getVoices()
  } catch {
    return undefined
  }
  // Voices load asynchronously; on the first call there may be none yet. Setting
  // `lang` on the utterance is enough for the browser to choose sensibly.
  if (voices.length === 0) return undefined

  const want = lang.toLowerCase().replace('_', '-')
  const base = want.split('-')[0]
  let best: SpeechSynthesisVoice | undefined
  let bestScore = -1
  for (const voice of voices) {
    const have = voice.lang.toLowerCase().replace('_', '-')
    let score = have === want ? 4 : have.split('-')[0] === base ? 2 : -1
    if (score < 0) continue
    if (voice.localService) score += 1
    if (voice.default) score += 1
    if (score > bestScore) {
      bestScore = score
      best = voice
    }
  }
  return best
}

// Bumped by every stopSpeaking() and speak(). Utterance callbacks fire after
// their queue has been abandoned — cancel() delivers an 'interrupted' error
// asynchronously — so each one checks that it still belongs to the current run
// before touching shared state.
let generation = 0
let queue: string[] = []

export function stopSpeaking() {
  generation++
  queue = []
  try {
    if (speechOutputSupported()) window.speechSynthesis.cancel()
  } catch {
    /* ignore */
  }
  setSpeaking(false)
}

/** Read a reply aloud. Replaces anything currently being spoken. */
export function speak(text: string, lang = speechLang()) {
  if (!speechOutputSupported()) return
  const parts = splitForSpeech(text)
  stopSpeaking()
  if (parts.length === 0) return

  const gen = ++generation
  queue = parts
  setSpeaking(true)
  speakNext(gen, lang)
}

function speakNext(gen: number, lang: string) {
  if (gen !== generation) return
  const part = queue.shift()
  if (part === undefined) {
    setSpeaking(false)
    return
  }
  try {
    const utterance = new SpeechSynthesisUtterance(part)
    utterance.lang = lang
    const voice = pickVoice(lang)
    if (voice) utterance.voice = voice
    utterance.rate = 1.02
    utterance.onend = () => speakNext(gen, lang)
    utterance.onerror = () => {
      if (gen !== generation) return // superseded — the new run owns the state
      queue = []
      setSpeaking(false)
    }
    window.speechSynthesis.speak(utterance)
  } catch {
    if (gen === generation) {
      queue = []
      setSpeaking(false)
    }
  }
}

// ── Speech in ───────────────────────────────────────────────────────

// Restarting is normal — Chrome ends a session every few seconds of quiet — so
// a failing engine has to be told apart from an idle one by how *fast* it comes
// back. More than this many restarts inside the window means it is looping.
const RESTART_WINDOW_MS = 10_000
const MAX_RESTARTS = 12
// Nothing heard at all for this long: let the microphone go rather than leaving
// it live and the browser's recording indicator lit.
const SILENCE_LIMIT_MS = 25_000
// How long to wait when start() throws because the last session is still
// winding down.
const RETRY_DELAY_MS = 250

// Every one of these is worth acting on, and none of them are recoverable by
// trying again — which is what the old catch-all message hid.
function messageFor(code: string, lang: string): string | null {
  switch (code) {
    case 'no-speech':
    case 'aborted':
      return null // routine; the restart logic in onend handles both
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked. Allow it for this site in your browser settings, then try again.'
    case 'audio-capture':
      return 'No microphone was found. Check that one is connected and selected as your input device.'
    case 'network':
      return 'Voice input needs a connection — this browser transcribes speech in the cloud.'
    case 'language-not-supported':
      return `This browser can't transcribe ${lang}. Change your browser's language and try again.`
    default:
      return 'Voice input stopped unexpectedly.'
  }
}

export interface DictationEngine {
  /** Open the microphone and keep it open until told otherwise. */
  start(): void
  /** Stop, letting words already in flight arrive as a final phrase. */
  stop(): void
  /** Stop and discard anything pending. */
  cancel(): void
  /** Stand down without giving up the user's intent (Lumen is speaking). */
  suspend(): void
  /** Take the microphone back after a suspend. */
  resume(): void
  /** Tear down for good. */
  destroy(): void
  /** Whether the user wants to be dictating — not whether the engine is up. */
  isActive(): boolean
}

export interface DictationPorts {
  /** Build a fresh recognition object, or null when unsupported. */
  create: () => any | null
  now?: () => number
  schedule?: (fn: () => void, ms: number) => unknown
  unschedule?: (handle: unknown) => void
}

export interface DictationCallbacks {
  /** A finished phrase. Append it to whatever is in the composer right now. */
  onFinal: (phrase: string) => void
  /** The words currently being heard — not committed, and still liable to change. */
  onInterim: (text: string) => void
  onError: (message: string) => void
  onChange: (state: { listening: boolean; suspended: boolean }) => void
}

/**
 * The dictation state machine, with no React in it.
 *
 * All of the difficulty in voice input is here rather than in the component:
 * the engine stops on its own constantly and has to be restarted without the
 * user seeing it, while a genuine failure — a blocked microphone, an engine
 * that will not start at all — has to be told apart from that and surfaced.
 * The difference between the two is only visible in *timing*, which is why the
 * clock and the scheduler are injected: it makes the whole thing exercisable
 * without a browser, a microphone, or a twenty-five second wait.
 */
export function createDictation(ports: DictationPorts, cb: DictationCallbacks, getLang: () => string): DictationEngine {
  const now = ports.now ?? (() => Date.now())
  const schedule = ports.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const unschedule = ports.unschedule ?? ((handle: unknown) => clearTimeout(handle as any))

  let want = false // the user's intent
  let suspended = false // stood down while Lumen speaks
  let rec: any = null // the engine, which comes and goes underneath `want`
  let lastHeard = 0
  let restarts: number[] = []
  let retry: unknown
  let destroyed = false

  const emit = () => cb.onChange({ listening: want, suspended })

  const clearRetry = () => {
    if (retry === undefined) return
    unschedule(retry)
    retry = undefined
  }

  /** Drop the engine without letting its teardown events trigger a restart. */
  const detach = () => {
    clearRetry()
    const dying = rec
    rec = null
    if (!dying) return
    dying.onresult = null
    dying.onerror = null
    dying.onend = null
    try {
      dying.abort()
    } catch {
      /* already gone */
    }
  }

  const halt = (message?: string) => {
    want = false
    suspended = false
    detach()
    cb.onInterim('')
    emit()
    if (message) cb.onError(message)
  }

  /** Spend one restart from the budget. False when it has run out. */
  const affordRestart = (): boolean => {
    const t = now()
    restarts = restarts.filter((at) => t - at < RESTART_WINDOW_MS)
    if (restarts.length >= MAX_RESTARTS) return false
    restarts.push(t)
    return true
  }

  const launch = () => {
    if (destroyed || rec) return
    const engine = ports.create()
    if (!engine) {
      halt("Voice input isn't supported in this browser. Try Chrome, Edge, or Safari.")
      return
    }
    rec = engine
    engine.lang = getLang()
    engine.continuous = true
    engine.interimResults = true
    engine.maxAlternatives = 1

    engine.onresult = (event: any) => {
      let pending = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const transcript = result?.[0]?.transcript ?? ''
        if (result?.isFinal) {
          // Committed as its own phrase so the caller can append it to whatever
          // is in the box at this instant — including anything typed since the
          // microphone opened.
          const phrase = transcript.trim()
          if (phrase) cb.onFinal(phrase)
        } else {
          pending += transcript
        }
      }
      lastHeard = now()
      cb.onInterim(pending.trim())
    }

    engine.onerror = (event: any) => {
      const message = messageFor(String(event?.error ?? ''), getLang())
      if (!message) return // routine; onend decides whether to carry on
      halt(message)
    }

    engine.onend = () => {
      if (rec !== engine) return // already replaced by detach()
      rec = null
      if (destroyed) return
      if (!want) {
        cb.onInterim('')
        return
      }
      if (suspended) return // Lumen is talking; resume() will bring it back

      // The ordinary case. Chrome ends the session after a few seconds of quiet
      // even with continuous = true, so this fires throughout normal use and a
      // restart is what "continuous" was supposed to mean.
      if (now() - lastHeard > SILENCE_LIMIT_MS) {
        halt("Stopped listening — I didn't hear anything.")
        return
      }
      if (!affordRestart()) {
        halt('Voice input keeps dropping out. Check your microphone and try again.')
        return
      }
      launch()
    }

    try {
      engine.start()
    } catch {
      // Starting again too soon after a stop throws while the previous session
      // winds down. Wait a beat — and spend a restart, so an engine that can
      // never start still gives up instead of retrying forever.
      rec = null
      if (!affordRestart()) {
        halt('Voice input keeps dropping out. Check your microphone and try again.')
        return
      }
      retry = schedule(() => {
        retry = undefined
        if (want && !suspended && !destroyed) launch()
      }, RETRY_DELAY_MS)
    }
  }

  return {
    start() {
      if (want || destroyed) return
      want = true
      suspended = false
      lastHeard = now()
      restarts = []
      cb.onInterim('')
      emit()
      launch()
    },
    stop() {
      if (!want) return
      want = false
      suspended = false
      emit()
      const engine = rec
      if (!engine) {
        cb.onInterim('')
        return
      }
      try {
        engine.stop() // unlike abort(), this delivers the last phrase as a final
      } catch {
        detach()
        cb.onInterim('')
      }
    },
    cancel() {
      want = false
      suspended = false
      detach()
      cb.onInterim('')
      emit()
    },
    suspend() {
      if (!want || suspended) return
      suspended = true
      detach()
      cb.onInterim('')
      emit()
    },
    resume() {
      if (!want || !suspended || destroyed) return
      suspended = false
      lastHeard = now() // the silence was ours, so it shouldn't count against them
      emit()
      launch()
    },
    destroy() {
      destroyed = true
      want = false
      suspended = false
      detach()
    },
    isActive: () => want,
  }
}

interface DictationOptions {
  /** A finished phrase. Append it to whatever is in the composer right now. */
  onFinal: (text: string) => void
  /** The words currently being heard — not committed, and may still change. */
  onInterim?: (text: string) => void
  onError?: (message: string) => void
  /** Defaults to the browser's language. */
  lang?: string
}

/**
 * React binding for the engine above.
 *
 * It deliberately does not own the composer's text: it reports finished phrases
 * and lets the caller append them, so typing and speaking can happen at once.
 * The previous version captured the box's contents when the microphone opened
 * and rewrote the whole field on every result, which erased anything typed in
 * between and flattened any line breaks already there.
 */
export function useDictation({ onFinal, onInterim, onError, lang }: DictationOptions) {
  const [listening, setListening] = useState(false)
  const [suspended, setSuspended] = useState(false)
  const [interim, setInterim] = useState('')
  const supported = speechInputSupported()

  // Held in refs so the engine is built once per mount and never rebuilt just
  // because the parent re-rendered with new closures.
  const finalRef = useRef(onFinal)
  const interimCbRef = useRef(onInterim)
  const errorRef = useRef(onError)
  const langRef = useRef(lang)
  finalRef.current = onFinal
  interimCbRef.current = onInterim
  errorRef.current = onError
  langRef.current = lang

  const engineRef = useRef<DictationEngine | null>(null)
  if (!engineRef.current) {
    engineRef.current = createDictation(
      { create: getRecognition },
      {
        onFinal: (phrase) => finalRef.current(phrase),
        onInterim: (text) => {
          setInterim(text)
          interimCbRef.current?.(text)
        },
        onError: (message) => errorRef.current?.(message),
        onChange: (state) => {
          setListening(state.listening)
          setSuspended(state.suspended)
        },
      },
      () => langRef.current || speechLang()
    )
  }
  const engine = engineRef.current

  // Hand the microphone over while Lumen is speaking, and take it back after.
  // Without this the reply is read aloud straight into an open microphone and
  // transcribed back into the composer.
  useEffect(() => onSpeakingChange((isSpeaking) => (isSpeaking ? engine.suspend() : engine.resume())), [engine])

  // Switching projects unmounts the composer. Without this the engine keeps
  // running and the browser's recording indicator stays lit, with nothing left
  // on screen to turn it off.
  useEffect(() => () => engine.destroy(), [engine])

  const start = useCallback(() => {
    if (!supported) {
      errorRef.current?.("Voice input isn't supported in this browser. Try Chrome, Edge, or Safari.")
      return
    }
    engine.start()
  }, [engine, supported])

  const stop = useCallback(() => engine.stop(), [engine])
  const cancel = useCallback(() => engine.cancel(), [engine])
  const toggle = useCallback(() => (engine.isActive() ? engine.stop() : start()), [engine, start])

  return { listening, suspended, interim, supported, start, stop, cancel, toggle }
}
