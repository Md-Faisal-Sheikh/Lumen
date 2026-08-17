import * as Y from 'yjs'
import { prisma } from './db'
import { hocuspocus } from './collab'
import { serializeWorkspace } from './edits'
import { entryFile, type Runtime } from './runtime'

// ── Forking a project ───────────────────────────────────────────────
//
// A fork copies the shared document, not the database row that happens to hold
// it. Those are different things: Hocuspocus keeps a room's Yjs document in
// memory and persists it on a debounce, so the `Doc` row for a project someone
// is actively editing is always a little behind the truth. Reading the row
// directly would hand the forker a workspace missing the last few seconds of
// work — intermittently, and only under exactly the conditions (a busy project
// worth forking) where anyone would notice.
//
// So the read goes through the server itself. `openDirectConnection` loads the
// room if it is cold and joins it if it is warm, and either way what comes back
// is the same document every collaborator is looking at.

/** Snapshot the live Yjs state for a project, or null if it has never been written. */
export async function readLiveDoc(projectId: string): Promise<Uint8Array | null> {
  const connection = await hocuspocus.openDirectConnection(projectId)
  try {
    let state: Uint8Array | null = null
    await connection.transact((doc) => {
      // An untouched project has an empty doc. Encoding it produces a valid but
      // meaningless update, so the emptiness is detected here rather than being
      // discovered later as a fork with no files in it.
      const code = doc.getText('code')
      const files = doc.getMap('files')
      if (code.length === 0 && files.size === 0) return
      state = Y.encodeStateAsUpdate(doc)
    })
    return state
  } finally {
    await connection.disconnect()
  }
}

/**
 * The document a fork starts life with: the source's files, and nothing else.
 *
 * The chat array and the meta map live in the same Yjs document as the code, so
 * a naive copy would hand the forker somebody else's conversation — every prompt
 * they typed, every sketch thumbnail they attached. It would also carry across a
 * `building` flag left set by a build that was still streaming when the fork was
 * taken, which would leave the new room's UI stuck behind a "Building" overlay
 * that nothing will ever clear.
 */
export function freshForkState(sourceState: Uint8Array): Uint8Array {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, sourceState)
  const chat = doc.getArray('chat')
  chat.delete(0, chat.length)
  doc.getMap('meta').clear()
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return state
}

/** Read a Yjs document's workspace as a flat path → contents map. */
export function workspaceFromState(state: Uint8Array, runtime: Runtime): Record<string, string> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const out: Record<string, string> = {}
  const entry = entryFile(runtime)
  const code = doc.getText('code').toString()
  if (code.trim()) out[entry] = code
  doc.getMap<Y.Text>('files').forEach((text, path) => {
    // The entry file lives in `code`, but a build that emitted it as an ordinary
    // file would also have put it here. `code` is authoritative either way.
    if (path !== entry) out[path] = text.toString()
  })
  doc.destroy()
  return out
}

/**
 * Copy a project's document into a brand-new project.
 *
 * The write goes straight to the `Doc` row rather than through Hocuspocus,
 * which is safe here for a reason that does not generalise: the target project
 * was created microseconds ago and nobody — no editor, no other request — can
 * have its room open yet. There is no live document to conflict with, so there
 * is nothing for the CRDT to merge.
 */
export async function copyDocInto(targetProjectId: string, state: Uint8Array): Promise<void> {
  await prisma.doc.create({ data: { projectId: targetProjectId, data: Buffer.from(state) } })
}

/**
 * The fork's opening history entry, so its timeline starts where it was forked
 * from rather than empty. Without this, the first thing a forker could restore
 * to would be whatever they built next — the state they actually started from
 * would be the one point in the project's life they could never get back.
 */
export async function seedForkVersion(
  targetProjectId: string,
  state: Uint8Array,
  runtime: Runtime,
  sourceName: string
): Promise<void> {
  const files = workspaceFromState(state, runtime)
  if (Object.keys(files).length === 0) return
  await prisma.version.create({
    data: {
      projectId: targetProjectId,
      prompt: `Forked from “${sourceName}”`,
      html: serializeWorkspace(files),
    },
  })
}
