import { Router, type Request } from 'express'
import { randomBytes } from 'node:crypto'
import { prisma } from './db'
import { env } from './env'

// Public sharing: a published project is served at /p/<slug> to anyone holding
// the link — no Lumen account, no sign-in, nothing to install.
//
// ── Security ────────────────────────────────────────────────────────
// What gets served here is HTML and JavaScript that a *user* wrote, hosted on
// *our* origin. Handed out naively that is stored XSS: a published page could
// read the localStorage of any signed-in Lumen user who opened the link and walk
// off with their token. So the published app never executes on this origin:
//
//   GET /p/:slug       a small page we author, which frames the app in a
//                      sandboxed iframe. No allow-same-origin, so the frame gets
//                      an opaque origin with no access to storage or cookies.
//   GET /p/:slug/app   the raw project, sent with a CSP `sandbox` directive so
//                      it stays opaque even when opened directly rather than
//                      through the wrapper.
//
// The two layers are independent — either one alone would contain the page.
// The sandbox flags deliberately match the in-app preview iframe, so a published
// app behaves exactly as it did while being built.
const SANDBOX = 'allow-scripts allow-modals allow-popups allow-forms'

// Only the sandbox directive: a restrictive default-src would also block the
// Google Fonts and cdnjs resources that generated apps are allowed to use, so a
// published app would render differently from its preview.
const SANDBOX_CSP = `sandbox ${SANDBOX}`

export const publicRouter = Router()

// ── Slugs ───────────────────────────────────────────────────────────
// Lower-case, no look-alike characters, so a slug survives being read aloud or
// copied out of a chat message.
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

function randomSuffix(length = 7): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length]
  return out
}

// "Neon Snake" -> "neon-snake-k4m2xqp". The random suffix is what makes the link
// unguessable: publishing is unlisted-by-link, so the slug must not be derivable
// from the project name alone.
export function makeSlug(projectName: string): string {
  const base = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `${base || 'app'}-${randomSuffix()}`
}

// The absolute link handed to the user. PUBLIC_URL is authoritative in
// production (behind a proxy the request host can be the internal one); in dev
// the request itself is the best answer.
export function publicUrl(req: Request, slug: string): string {
  const base = env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`
  return `${base.replace(/\/+$/, '')}/p/${slug}`
}

// ── Page rendering ──────────────────────────────────────────────────
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c])

const SHELL_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: #07060d; }
  body { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .app { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
  .badge {
    position: fixed; right: 14px; bottom: 14px; z-index: 10;
    display: inline-flex; align-items: center; gap: 7px;
    padding: 7px 13px; border-radius: 999px; text-decoration: none;
    font-size: 12px; font-weight: 550; color: #eceaf6;
    background: rgba(16, 13, 30, 0.82); border: 1px solid rgba(176, 156, 255, 0.22);
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.8);
    transition: 0.18s; opacity: 0.75;
  }
  .badge:hover { opacity: 1; border-color: rgba(176, 156, 255, 0.42); transform: translateY(-1px); }
  .badge b { background: linear-gradient(120deg, #8b5cf6, #e84cc4 52%, #38e0d8); -webkit-background-clip: text; background-clip: text; color: transparent; font-weight: 700; }
  .miss { height: 100%; display: grid; place-items: center; text-align: center; padding: 24px; color: #9a95b8; }
  .miss h1 { font-size: 20px; font-weight: 600; color: #eceaf6; margin: 0 0 8px; }
  .miss p { margin: 0; font-size: 14px; line-height: 1.6; }
  .mark { width: 54px; height: 54px; margin: 0 auto 18px; border-radius: 15px; display: grid; place-items: center;
          background: linear-gradient(120deg, #8b5cf6, #e84cc4 52%, #38e0d8); color: #0a0712; font-size: 26px; }
`

function shell(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
${head}
<style>${SHELL_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`
}

// The wrapper around a published app. Everything here is authored by us — the
// user's HTML only ever appears inside the sandboxed frame.
function publishedPage(title: string, slug: string, url: string): string {
  const safeTitle = escapeHtml(title)
  const head = `<meta name="description" content="${safeTitle} — built with Lumen." />
<meta property="og:type" content="website" />
<meta property="og:title" content="${safeTitle}" />
<meta property="og:description" content="Built with Lumen." />
<meta property="og:url" content="${escapeHtml(url)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="robots" content="noindex" />`
  const body = `<iframe class="app" title="${safeTitle}" src="/p/${encodeURIComponent(slug)}/app" sandbox="${SANDBOX}"></iframe>
<a class="badge" href="${escapeHtml(env.CLIENT_ORIGIN)}" target="_blank" rel="noopener noreferrer">built with <b>✦ Lumen</b></a>`
  return shell(title, head, body)
}

function missingPage(): string {
  return shell(
    'Link not found',
    '<meta name="robots" content="noindex" />',
    `<div class="miss">
  <div>
    <div class="mark">✦</div>
    <h1>This link isn't live</h1>
    <p>The project was never published, or its owner has taken it down.</p>
  </div>
</div>`
  )
}

// ── Routes ──────────────────────────────────────────────────────────
// Deliberately no auth: that is the entire point of the feature.

publicRouter.get('/:slug', async (req, res) => {
  const slug = req.params.slug
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Cache-Control', 'no-store')
  res.type('html')

  if (!SLUG_RE.test(slug)) return res.status(404).send(missingPage())
  const pub = await prisma.publication.findUnique({ where: { slug }, select: { id: true, title: true, slug: true } })
  if (!pub) return res.status(404).send(missingPage())

  // A view counter should never be able to fail the page it is counting.
  prisma.publication.update({ where: { id: pub.id }, data: { views: { increment: 1 } } }).catch(() => {})

  res.send(publishedPage(pub.title, pub.slug, publicUrl(req, pub.slug)))
})

publicRouter.get('/:slug/app', async (req, res) => {
  const slug = req.params.slug
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Cache-Control', 'no-store')
  res.type('html')

  if (!SLUG_RE.test(slug)) return res.status(404).send(missingPage())
  const pub = await prisma.publication.findUnique({ where: { slug }, select: { html: true } })
  if (!pub) return res.status(404).send(missingPage())

  // The load-bearing header: an opaque origin for user-authored JavaScript, even
  // if this URL is opened directly instead of through the wrapper above.
  res.set('Content-Security-Policy', SANDBOX_CSP)
  res.send(pub.html)
})
