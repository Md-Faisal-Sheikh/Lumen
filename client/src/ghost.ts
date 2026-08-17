// Inline completion for CodeMirror: the grey text that appears ahead of the
// caret and becomes real when you press Tab.
//
// The whole feature is a decoration. Nothing is ever written into the document
// until the moment it is accepted — which matters more here than in a normal
// editor, because this document is a CRDT shared with everyone else in the room.
// A suggestion that lived in the doc would stream into their editors as if
// somebody had typed it, land in the preview, and be picked up by the next
// version snapshot. So the suggestion is view-only state, and accepting it is an
// ordinary insertion the collaborative layer syncs like any keystroke.
//
// Two rules keep it from being annoying, which for an unasked-for feature is the
// entire design problem:
//
//   · **Only the person typing triggers a request.** Code arriving from a build,
//     or from a collaborator, changes the document constantly; chasing those
//     would fire a model call every 90ms during a build and suggest into text
//     nobody is looking at.
//   · **A failure is silence.** There is nothing a user can do about a completion
//     that didn't arrive, so nothing is reported — no toast, no inline error.
//     Suggestions simply stop appearing until the next one works.

import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'

/** Mirrors the server's PREFIX_BUDGET / SUFFIX_BUDGET (server/src/completion.ts).
 *  Sending more would only be sliced off at the other end. */
const PREFIX_WINDOW = 2400
const SUFFIX_WINDOW = 800

/** How long the caret has to sit still before a suggestion is asked for. Short
 *  enough to feel immediate at the end of a thought, long enough that typing a
 *  word doesn't fire a request per letter. */
const DEFAULT_DELAY = 320

export interface CompletionRequest {
  file: string
  prefix: string
  suffix: string
  signal: AbortSignal
}

export interface GhostConfig {
  /** Read fresh at every trigger, so toggling suggestions off takes effect
   *  immediately instead of at the next editor remount. */
  enabled: () => boolean
  /** The path being edited — the server uses it to know the language. */
  file: () => string
  /** Ask for a completion. Resolve null (or reject) for "no suggestion". */
  fetch: (req: CompletionRequest) => Promise<string | null>
  delay?: number
}

interface Ghost {
  text: string
  /** Where it was computed. A suggestion is only valid at that exact offset. */
  pos: number
}

const setGhost = StateEffect.define<Ghost | null>()

// The suggestion itself, and the reasons it stops being one.
const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, tr) {
    // An explicit set wins over everything below — including the docChanged of
    // the very transaction that accepts a suggestion and clears it.
    for (const e of tr.effects) if (e.is(setGhost)) return e.value
    // Any edit at all — yours, a collaborator's, or a build writing the file —
    // means this text was computed against a document that no longer exists.
    if (tr.docChanged) return null
    // Moving the caret elsewhere abandons it: ghost text rendered away from the
    // cursor reads as part of the file.
    if (value && tr.selection && tr.selection.main.head !== value.pos) return null
    return value
  },
  provide: (f) =>
    EditorView.decorations.from(f, (ghost): DecorationSet =>
      ghost
        ? Decoration.set([
            Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(ghost.pos),
          ])
        : Decoration.none
    ),
})

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  // Without this the widget is torn down and rebuilt on every unrelated
  // redraw, which makes the suggestion visibly flicker as you move around.
  eq(other: GhostWidget) {
    return other.text === this.text
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-ghost'
    span.textContent = this.text
    // It is a proposal, not content. Announcing it as part of the document
    // would have a screen reader read code the user has not written.
    span.setAttribute('aria-hidden', 'true')
    return span
  }
  // Let clicks through to the editor: clicking "on" the suggestion should put
  // the caret where the pixels are, not select a widget.
  ignoreEvent() {
    return false
  }
}

/** Accept. Bound to Tab, and returns false when there is nothing to accept so
 *  that Tab keeps doing whatever it normally does in this editor. */
function acceptGhost(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false)
  if (!ghost) return false
  // The caret moved between render and keypress: drop it rather than insert
  // text at a position it was never computed for.
  if (view.state.selection.main.head !== ghost.pos) {
    view.dispatch({ effects: setGhost.of(null) })
    return false
  }
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    effects: setGhost.of(null),
    // Marked distinctly so the trigger below can tell an accepted suggestion
    // apart from typing, and not immediately ask for another one.
    userEvent: 'input.complete',
  })
  return true
}

/** Dismiss. Returns false when no suggestion is showing, so Escape still closes
 *  whatever else it would have. */
function dismissGhost(view: EditorView): boolean {
  if (!view.state.field(ghostField, false)) return false
  view.dispatch({ effects: setGhost.of(null) })
  return true
}

export function inlineCompletion(config: GhostConfig): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null
      inflight: AbortController | null = null
      /** Monotonic request id. A response whose id is stale is discarded — the
       *  abort signal covers the network, this covers the resolved-but-late. */
      seq = 0

      constructor(readonly view: EditorView) {}

      update(u: ViewUpdate) {
        if (u.docChanged) {
          // 'input.complete' is our own accept; treating it as typing would ask
          // for a fresh suggestion on every Tab.
          const typed = u.transactions.some(
            (t) => (t.isUserEvent('input') || t.isUserEvent('delete')) && !t.isUserEvent('input.complete')
          )
          if (typed) this.schedule()
          else this.cancel() // a build or a collaborator — not ours to complete
          return
        }
        // The caret moved without an edit: anything pending was for the old spot.
        if (u.selectionSet) this.cancel()
      }

      schedule() {
        this.cancel()
        if (!config.enabled()) return
        this.timer = setTimeout(() => {
          this.timer = null
          void this.request()
        }, config.delay ?? DEFAULT_DELAY)
      }

      /** Stop the pending timer and abandon any request in flight. */
      cancel() {
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
        if (this.inflight) {
          this.inflight.abort()
          this.inflight = null
        }
      }

      /** Ask now, skipping the debounce — the manual trigger below. */
      requestNow() {
        this.cancel()
        void this.request()
      }

      async request() {
        const view = this.view
        if (!config.enabled()) return
        // No focus means the editor isn't where the user is — the Ctrl+K prompt
        // is open, or they are in the chat.
        if (!view.hasFocus) return
        const sel = view.state.selection.main
        // With a range selected the user is about to replace it, not extend it.
        if (!sel.empty) return

        const pos = sel.head
        const doc = view.state.doc
        const prefix = doc.sliceString(Math.max(0, pos - PREFIX_WINDOW), pos)
        const suffix = doc.sliceString(pos, Math.min(doc.length, pos + SUFFIX_WINDOW))
        if (!prefix.trim()) return

        const ac = new AbortController()
        this.inflight = ac
        const seq = ++this.seq

        try {
          const text = await config.fetch({ file: config.file(), prefix, suffix, signal: ac.signal })
          // Superseded while we waited, or the caret has moved on: this answer
          // describes a document that is no longer on screen.
          if (seq !== this.seq || ac.signal.aborted) return
          if (!text) return
          if (view.state.selection.main.head !== pos) return
          if (!view.hasFocus) return
          view.dispatch({ effects: setGhost.of({ text, pos }) })
        } catch {
          // Deliberately silent — see the note at the top of this file.
        } finally {
          if (this.inflight === ac) this.inflight = null
        }
      }

      destroy() {
        this.cancel()
      }
    }
  )

  const triggerNow = (view: EditorView): boolean => {
    const instance = view.plugin(plugin)
    if (!instance) return false
    instance.requestNow()
    return true
  }

  return [
    ghostField,
    plugin,
    // Highest precedence so Tab accepts instead of indenting — but only while a
    // suggestion is showing, since both handlers return false otherwise.
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: acceptGhost },
        { key: 'Escape', run: dismissGhost },
        // Ask on demand, for when you want a suggestion at a caret that has been
        // sitting still (the debounce only fires after typing).
        { key: 'Alt-\\', preventDefault: true, run: triggerNow },
      ])
    ),
  ]
}
