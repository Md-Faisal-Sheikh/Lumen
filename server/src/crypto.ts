// Encryption at rest for the one secret Lumen is ever handed: a user's GitHub
// personal access token.
//
// A token with `repo` scope can push to every repository that user can reach, so
// it is not something to keep in a column next to their email. It is sealed with
// AES-256-GCM before it is written and only ever opened to make one request as
// them — it is never returned to the browser, never logged, and never included
// in any API response.
//
// The key is derived from JWT_SECRET with scrypt rather than being a separate
// variable, so there is nothing extra to configure: a deployment that already
// has a strong JWT_SECRET already has a strong encryption key. That does couple
// the two — rotating JWT_SECRET makes stored tokens unreadable, which is why
// open() reports a tampered/undecryptable value as a plain "reconnect" rather
// than a crash. Node's built-in crypto only: no dependency to add.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { env } from './env'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12 // 96-bit nonce, the size GCM is specified for
const TAG_BYTES = 16

// Derived once at startup. The salt is fixed and public: it separates this key
// from any other use of JWT_SECRET, which is all a salt does here — there is one
// key, so a per-record salt would buy nothing and cost a column.
let cachedKey: Buffer | null = null
function key(): Buffer {
  if (!cachedKey) cachedKey = scryptSync(env.JWT_SECRET, 'lumen.github.token.v1', 32)
  return cachedKey
}

/** Seal a secret for storage. Returns base64 `iv:tag:ciphertext`. */
export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key(), iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':')
}

/**
 * Open a sealed secret. Returns null for anything that isn't intact and
 * authentic — a truncated column, a value written under a different
 * JWT_SECRET, or a row someone edited by hand. The caller's job is then to ask
 * the user to reconnect, not to guess at a plaintext.
 */
export function open(sealed: string): string | null {
  const parts = sealed.split(':')
  if (parts.length !== 3) return null
  try {
    const iv = Buffer.from(parts[0], 'base64')
    const tag = Buffer.from(parts[1], 'base64')
    const body = Buffer.from(parts[2], 'base64')
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null
    const decipher = createDecipheriv(ALGO, key(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // GCM raises on a failed tag check, which is exactly the case we want to
    // treat as "not ours" rather than propagate.
    return null
  }
}

/**
 * Constant-time comparison, for the rare case two secrets are compared directly.
 * Buffers of different lengths are unequal without consulting their contents —
 * timingSafeEqual throws on a length mismatch rather than returning false.
 */
export function sameSecret(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
