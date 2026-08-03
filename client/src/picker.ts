// Click-to-edit: the bridge that lets you point at something in the running app
// and talk about it, instead of describing it in words.
//
// The script below is injected into the *preview document only* — never into the
// project's real files, so it can't reach the editor, a version snapshot, or the
// exported ZIP. It stays completely inert until the parent arms it, at which
// point it outlines whatever the pointer is over and reports the clicked element
// back with a CSS selector and its markup.
//
// The preview iframe is sandboxed without allow-same-origin, so its origin is the
// opaque "null" and neither side can reach into the other's DOM. Everything here
// travels by postMessage, and the parent authenticates replies by window identity
// (see PreviewPane) because there is no meaningful origin to check.

export interface PickedElement {
  /** A CSS selector that resolves to the clicked element, e.g. "main > button.cta". */
  selector: string
  /** Short human label for the UI, e.g. "button.cta". */
  label: string
  /** The element's visible text, trimmed for display. */
  text: string
  /** Its outerHTML, truncated — enough for the model to recognise it. */
  html: string
}

export const PICK_MESSAGE = 'lumen:pick' // parent -> preview: arm / disarm
export const PICKED_MESSAGE = 'lumen:picked' // preview -> parent: element chosen
export const PICK_CANCELLED = 'lumen:pick-cancelled' // preview -> parent: Esc pressed inside the frame

// Kept small and dependency-free: it runs inside the user's generated app, so it
// must not assume anything about the page and must leave no trace when disarmed.
const PICKER_SCRIPT = `
(function () {
  if (window.__lumenPicker) return
  window.__lumenPicker = true

  var PICK = ${JSON.stringify(PICK_MESSAGE)}
  var PICKED = ${JSON.stringify(PICKED_MESSAGE)}
  var CANCELLED = ${JSON.stringify(PICK_CANCELLED)}

  var armed = false
  var box = null
  var tip = null
  var current = null

  function ui() {
    if (box) return
    box = document.createElement('div')
    box.setAttribute('data-lumen-ui', '')
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;' +
      'border:2px solid #38e0d8;border-radius:4px;background:rgba(56,224,216,.14);' +
      'box-shadow:0 0 0 1px rgba(0,0,0,.4),0 0 0 9999px rgba(7,6,13,.18)'
    tip = document.createElement('div')
    tip.setAttribute('data-lumen-ui', '')
    tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;' +
      'font:600 11px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#04121a;' +
      'background:#38e0d8;padding:1px 7px;border-radius:5px;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis'
    var root = document.documentElement
    root.appendChild(box)
    root.appendChild(tip)
  }

  // Only class names that are safe to drop straight into a selector.
  function classesOf(el) {
    var out = []
    for (var i = 0; i < el.classList.length && out.length < 2; i++) {
      if (/^[A-Za-z_-][\\w-]*$/.test(el.classList[i])) out.push(el.classList[i])
    }
    return out
  }

  function label(el) {
    var s = el.tagName.toLowerCase()
    if (el.id) return s + '#' + el.id
    var c = classesOf(el)
    return c.length ? s + '.' + c.join('.') : s
  }

  // Walk up to a selector that identifies the element. A unique id short-circuits
  // it; otherwise each step is tag + up to two classes, disambiguated by position.
  function selectorFor(el) {
    if (el.id) {
      try {
        if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + el.id
      } catch (e) {}
    }
    var parts = []
    var node = el
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6) {
      if (node.id) { parts.unshift('#' + node.id); break }
      var part = node.tagName.toLowerCase()
      var c = classesOf(node)
      if (c.length) part += '.' + c.join('.')
      var parent = node.parentElement
      if (parent) {
        var same = []
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) same.push(parent.children[i])
        }
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = parent
    }
    return parts.join(' > ')
  }

  function paint(el) {
    var r = el.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = r.left + 'px'
    box.style.top = r.top + 'px'
    box.style.width = r.width + 'px'
    box.style.height = r.height + 'px'
    tip.textContent = label(el)
    tip.style.display = 'block'
    tip.style.left = Math.max(2, r.left) + 'px'
    tip.style.top = (r.top < 22 ? r.bottom + 5 : r.top - 21) + 'px'
  }

  function hide() {
    if (box) { box.style.display = 'none'; tip.style.display = 'none' }
    current = null
  }

  function target(e) {
    var el = e.target
    if (!el || el.nodeType !== 1) return null
    if (el.hasAttribute && el.hasAttribute('data-lumen-ui')) return null
    if (el === document.documentElement) return null
    return el
  }

  function onMove(e) {
    var el = target(e)
    if (!el) return
    current = el
    paint(el)
  }

  function onLeave(e) { if (!e.relatedTarget) hide() }

  // Swallow the whole click sequence so picking never triggers the app's own
  // buttons, links or form submits.
  function swallow(e) { e.preventDefault(); e.stopPropagation() }

  function onClick(e) {
    swallow(e)
    var el = current || target(e)
    if (!el) return
    var html = el.outerHTML || ''
    if (html.length > 600) html = html.slice(0, 600) + '\\u2026'
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim()
    if (text.length > 90) text = text.slice(0, 90) + '\\u2026'
    disarm()
    parent.postMessage({ lumen: PICKED, selector: selectorFor(el), label: label(el), text: text, html: html }, '*')
  }

  function onKey(e) {
    if (e.key !== 'Escape') return
    swallow(e)
    disarm()
    parent.postMessage({ lumen: CANCELLED }, '*')
  }

  function reposition() { if (current) paint(current) }

  function arm() {
    if (armed) return
    armed = true
    ui()
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseout', onLeave, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('mousedown', swallow, true)
    document.addEventListener('mouseup', swallow, true)
    document.addEventListener('keydown', onKey, true)
    addEventListener('scroll', reposition, true)
    addEventListener('resize', reposition)
    document.documentElement.style.cursor = 'crosshair'
  }

  function disarm() {
    if (!armed) return
    armed = false
    hide()
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('mouseout', onLeave, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('mousedown', swallow, true)
    document.removeEventListener('mouseup', swallow, true)
    document.removeEventListener('keydown', onKey, true)
    removeEventListener('scroll', reposition, true)
    removeEventListener('resize', reposition)
    document.documentElement.style.cursor = ''
  }

  addEventListener('message', function (e) {
    var d = e.data
    if (!d || d.lumen !== PICK) return
    if (d.on) arm(); else disarm()
  })
})()
`

// Turn a picked element plus the user's words into a request the model can act on
// without guessing which node was meant. The selector and the markup together
// pin it down even when the page has a dozen similar buttons.
export function describeTarget(el: PickedElement, instruction: string): string {
  const lines = ['The user pointed at one element in the running app.', `CSS selector: ${el.selector}`]
  if (el.text) lines.push(`Its text: ${el.text}`)
  lines.push(`Its current markup:\n${el.html}`, '')
  lines.push(`Change that element — and any CSS it needs — to satisfy: ${instruction}`)
  lines.push('Leave the rest of the app exactly as it is.')
  return lines.join('\n')
}

// Add the picker to an assembled preview document. Runs on the string that
// becomes the iframe's srcDoc, so the workspace files stay untouched.
export function instrumentPreview(html: string): string {
  if (!html.trim()) return html
  const tag = `<script data-lumen-picker>${PICKER_SCRIPT}</script>`
  // A function replacement keeps "$&"-style sequences in the script literal.
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, () => `${tag}\n</body>`)
  return html + tag
}
