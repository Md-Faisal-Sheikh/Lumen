import { Router } from 'express'
import { prisma } from './db'
import { authMiddleware } from './auth'
import type { Runtime } from './runtime'
import { bestMatch, buildIdf, prepare, SIMILARITY_THRESHOLD, type PreparedPrompt } from './similarity'

// The shared build cache. Anyone's first-time build of a given idea is generated
// once and then handed to everybody who asks for the same thing — which used to
// mean *character-for-character* the same thing, so "a neon snake game" and
// "snake game with neon colors" each paid for their own generation.
//
// Now a miss on the exact key falls through to a similarity pass over the cached
// prompts (see similarity.ts). A wrong match is far worse than a miss — it hands
// someone an app they didn't ask for — so the threshold is set from a labelled
// pair set and the reuse is always disclosed in the UI, never silent.

// Normalize a prompt into the shared cache key, so the same request in
// different casing/spacing hits the same entry.
export const promptKey = (prompt: string) => prompt.toLowerCase().replace(/\s+/g, ' ').trim()

// Only cache output that actually looks like a generated project — never a
// refusal or error prose, which would poison the cache for every user.
//
// The web form is a marker block or a bare HTML document. A Python build has no
// <!doctype> to fall back on, so the marker is the whole test there — which is
// also what stops a model's apology from being cached as a program.
export const looksLikeProject = (out: string, runtime: Runtime = 'web') =>
  runtime === 'python' ? /={3,}\s*FILE:/.test(out) : /={3,}\s*FILE:/.test(out) || /<!doctype html/i.test(out)

// How many entries the similarity pass considers. Prompts are short, so this is
// a few tens of kilobytes; the ceiling exists so the cost stays flat as the
// cache grows rather than for any correctness reason.
const CANDIDATE_LIMIT = 800

const GLOBAL = 'global'

export interface CacheHit {
  output: string
  summary: string | null
  /** The prompt that was actually cached — null when it matched exactly. */
  reusedFrom: string | null
  /** Similarity score, only present for a loose match. */
  similarity: number | null
}

// Counters must never be able to fail a build, so every write here is advisory.
async function record(outcome: 'exact' | 'similar' | 'miss') {
  const inc = {
    exactHits: outcome === 'exact' ? 1 : 0,
    similarHits: outcome === 'similar' ? 1 : 0,
    misses: outcome === 'miss' ? 1 : 0,
  }
  await prisma.cacheStat
    .upsert({
      where: { id: GLOBAL },
      create: { id: GLOBAL, lookups: 1, ...inc },
      update: {
        lookups: { increment: 1 },
        exactHits: { increment: inc.exactHits },
        similarHits: { increment: inc.similarHits },
        misses: { increment: inc.misses },
      },
    })
    .catch(() => {})
}

/**
 * Find a cached build for this prompt: exact key first, then similarity.
 * Records the outcome either way, so the hit rate reflects every consultation.
 */
export async function lookupBuild(prompt: string, runtime: Runtime = 'web'): Promise<CacheHit | null> {
  const exact = await prisma.buildCache.findUnique({
    where: { promptKey_runtime: { promptKey: promptKey(prompt), runtime } },
  })
  if (exact) {
    await prisma.buildCache.update({ where: { id: exact.id }, data: { hits: { increment: 1 } } })
    await record('exact')
    return { output: exact.output, summary: exact.summary, reusedFrom: null, similarity: null }
  }

  // Only the prompts come back here — the outputs are large and we need exactly
  // one of them. Scoped to this runtime: a paraphrase match across runtimes
  // would be the same mistake the exact key already refuses, arrived at by a
  // longer route.
  const candidates = await prisma.buildCache.findMany({
    where: { runtime },
    select: { id: true, prompt: true },
    orderBy: { updatedAt: 'desc' },
    take: CANDIDATE_LIMIT,
  })
  if (candidates.length === 0) {
    await record('miss')
    return null
  }

  const prepared: Array<{ entry: { id: string; prompt: string }; prepared: PreparedPrompt }> = candidates.map((c) => ({
    entry: c,
    prepared: prepare(c.prompt),
  }))
  // IDF over the cache itself: with a hundred cached games, "game" earns a low
  // weight from the evidence rather than from a hard-coded list.
  const idf = buildIdf(prepared.map((p) => p.prepared))
  const match = bestMatch(prepare(prompt), prepared, idf, SIMILARITY_THRESHOLD)

  if (!match) {
    await record('miss')
    return null
  }

  const row = await prisma.buildCache.findUnique({ where: { id: match.entry.id } })
  if (!row) {
    // Deleted between the two queries — treat it as a miss rather than guessing.
    await record('miss')
    return null
  }
  await prisma.buildCache.update({
    where: { id: row.id },
    data: { hits: { increment: 1 }, similarHits: { increment: 1 } },
  })
  await record('similar')
  return {
    output: row.output,
    summary: row.summary,
    reusedFrom: row.prompt,
    similarity: Math.round(match.score * 100) / 100,
  }
}

/** Remember a freshly generated build so the next person asking doesn't pay for it. */
export async function storeBuild(prompt: string, output: string, summary: string | null, runtime: Runtime = 'web') {
  if (!looksLikeProject(output, runtime)) return
  const key = promptKey(prompt)
  await prisma.buildCache.upsert({
    where: { promptKey_runtime: { promptKey: key, runtime } },
    create: { promptKey: key, runtime, prompt, output, summary },
    update: { output, summary },
  })
}

// ── Stats ───────────────────────────────────────────────────────────
export const cacheRouter = Router()
cacheRouter.use(authMiddleware)

cacheRouter.get('/stats', async (_req, res) => {
  const [stat, entries] = await Promise.all([
    prisma.cacheStat.findUnique({ where: { id: GLOBAL } }),
    prisma.buildCache.count(),
  ])
  const lookups = stat?.lookups ?? 0
  const exactHits = stat?.exactHits ?? 0
  const similarHits = stat?.similarHits ?? 0
  res.json({
    stats: {
      entries,
      lookups,
      exactHits,
      similarHits,
      misses: stat?.misses ?? 0,
      // Share of build requests answered without calling a model at all.
      hitRate: lookups === 0 ? 0 : Math.round(((exactHits + similarHits) / lookups) * 100),
      threshold: SIMILARITY_THRESHOLD,
    },
  })
})
