import { Server } from '@hocuspocus/server'
import { Database } from '@hocuspocus/extension-database'
import { prisma } from './db'
import { verifyToken } from './auth'

// Hocuspocus is the real-time engine. It authenticates each connection against
// the user's JWT and project membership, and persists the shared Yjs document
// (collaborative code + chat) to the database between sessions.
export const hocuspocus = Server.configure({
  async onAuthenticate({ token, documentName }) {
    const userId = verifyToken(token)
    if (!userId) throw new Error('Unauthorized')

    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: documentName, userId } },
    })
    if (!member) throw new Error('Forbidden')

    // Returned context is available to other hooks.
    return { userId }
  },

  extensions: [
    new Database({
      // Load the persisted Yjs state for a project room (or null for a fresh doc).
      fetch: async ({ documentName }) => {
        const row = await prisma.doc.findUnique({ where: { projectId: documentName } })
        return row?.data ? new Uint8Array(row.data) : null
      },
      // Persist the encoded Yjs state (debounced automatically by the extension).
      store: async ({ documentName, state }) => {
        const data = Buffer.from(state)
        await prisma.doc.upsert({
          where: { projectId: documentName },
          create: { projectId: documentName, data },
          update: { data },
        })
      },
    }),
  ],
})
