// A small in-memory rate limiter.
//
// It exists for the completion endpoint above all: ghost text fires on every
// pause in typing, so a single person with a key held down is a burst of model
// calls, and a free-tier provider answers that with 429s that then break
// everything else the project does. Limiting it here turns "the whole editor
// stopped working" into "no suggestion for a moment".
//
// Deliberately in-process and unsynchronized: no Redis, nothing to host, in
// keeping with the rest of Lumen. The consequence is honest rather than hidden —
// across N server processes the effective limit is N times `max`, which for a
// self-hosted single-process deployment is exactly `max`. Swap the store if that
// ever stops being true.

interface Window {
  /** Timestamps (ms) of the requests still inside the window, oldest first. */
  hits: number[]
}

export interface Limiter {
  /**
   * Record an attempt. Returns whether it is allowed, and if not, how long to
   * wait — so the caller can send a real Retry-After instead of a bare 429.
   */
  take(key: string): { ok: true } | { ok: false; retryAfterMs: number }
}

export function createLimiter({
  max,
  windowMs,
  now = () => Date.now(),
}: {
  max: number
  windowMs: number
  /** Injectable clock: the sweep and the window are the whole behaviour here. */
  now?: () => number
}): Limiter {
  const windows = new Map<string, Window>()
  let lastSweep = now()

  // Without this the map grows one entry per user forever. Sweeping on use (not
  // on a timer) keeps the module free of a handle that would hold the process
  // open and makes it a no-op on an idle server.
  const sweep = (t: number) => {
    if (t - lastSweep < windowMs) return
    lastSweep = t
    for (const [k, w] of windows) {
      if (w.hits.length === 0 || t - w.hits[w.hits.length - 1] > windowMs) windows.delete(k)
    }
  }

  return {
    take(key) {
      const t = now()
      sweep(t)
      const w = windows.get(key) ?? { hits: [] }
      // Drop everything that has aged out of the window.
      const cutoff = t - windowMs
      while (w.hits.length && w.hits[0] <= cutoff) w.hits.shift()

      if (w.hits.length >= max) {
        windows.set(key, w)
        // The oldest hit is what has to expire before there is room again.
        return { ok: false, retryAfterMs: Math.max(1, w.hits[0] + windowMs - t) }
      }
      w.hits.push(t)
      windows.set(key, w)
      return { ok: true }
    },
  }
}
