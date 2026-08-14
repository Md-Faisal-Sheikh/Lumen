import { prisma } from './db'

export type MemoryType =
  | 'architecture'
  | 'design'
  | 'preference'
  | 'requirement'
  | 'decision'
  | 'fact'
  | 'workflow'

export interface CreateMemoryInput {
  type?: MemoryType
  content: string
  importance?: number
  confidence?: number
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'have',
  'will',
  'your',
  'you',
  'are',
  'was',
  'were',
  'can',
  'should',
  'would',
  'could',
  'about',
  'what',
  'when',
  'where',
  'which',
  'then',
  'than',
  'also',
  'use',
  'using',
])

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
    ),
  )
}

function relevanceScore(
  query: string,
  memory: { content: string; type: string; importance: number; confidence: number },
): number {
  const queryTokens = tokenize(query)

  if (!queryTokens.length) return 0

  const contentTokens = new Set(tokenize(memory.content))
  const typeTokens = new Set(tokenize(memory.type))

  let matches = 0

  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      matches += 1
    } else if (typeTokens.has(token)) {
      matches += 0.5
    }
  }

  const matchRatio = matches / queryTokens.length

  // Important and high-confidence memories get a small ranking boost.
  const importanceBoost = Math.max(0, Math.min(memory.importance, 5)) * 0.04
  const confidenceBoost = Math.max(0, Math.min(memory.confidence, 1)) * 0.06

  return matchRatio + importanceBoost + confidenceBoost
}

export async function listProjectMemories(projectId: string) {
  return prisma.projectMemory.findMany({
    where: {
      projectId,
      status: 'active',
    },
    orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }],
  })
}

export async function createProjectMemory(
  projectId: string,
  input: CreateMemoryInput,
) {
  const content = input.content.trim()

  if (!content) {
    throw new Error('Memory content cannot be empty.')
  }

  return prisma.projectMemory.create({
    data: {
      projectId,
      type: input.type ?? 'fact',
      content: content.slice(0, 1000),
      importance: Math.max(1, Math.min(input.importance ?? 3, 5)),
      confidence: Math.max(0, Math.min(input.confidence ?? 1, 1)),
    },
  })
}

export async function updateProjectMemory(
  projectId: string,
  memoryId: string,
  input: Partial<CreateMemoryInput> & { status?: string },
) {
  const existing = await prisma.projectMemory.findFirst({
    where: {
      id: memoryId,
      projectId,
    },
  })

  if (!existing) return null

  const content =
    input.content === undefined
      ? undefined
      : input.content.trim().slice(0, 1000)

  if (content !== undefined && !content) {
    throw new Error('Memory content cannot be empty.')
  }

  return prisma.projectMemory.update({
    where: { id: memoryId },
    data: {
      ...(input.type !== undefined && { type: input.type }),
      ...(content !== undefined && { content }),
      ...(input.importance !== undefined && {
        importance: Math.max(1, Math.min(input.importance, 5)),
      }),
      ...(input.confidence !== undefined && {
        confidence: Math.max(0, Math.min(input.confidence, 1)),
      }),
      ...(input.status !== undefined && { status: input.status }),
    },
  })
}

export async function deleteProjectMemory(
  projectId: string,
  memoryId: string,
) {
  const existing = await prisma.projectMemory.findFirst({
    where: {
      id: memoryId,
      projectId,
    },
  })

  if (!existing) return false

  await prisma.projectMemory.delete({
    where: { id: memoryId },
  })

  return true
}

export async function retrieveRelevantMemories(
  projectId: string,
  query: string,
  limit = 8,
) {
  const memories = await listProjectMemories(projectId)

  return memories
    .map((memory) => ({
      memory,
      score: relevanceScore(query, memory),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ memory }) => memory)
}

export function formatMemoriesForAI(
  memories: Array<{
    type: string
    content: string
    importance: number
    confidence: number
  }>,
): string {
  if (!memories.length) return ''

  const lines = memories.map(
    (memory) =>
      `- [${memory.type}] ${memory.content} (importance: ${memory.importance}/5, confidence: ${Math.round(memory.confidence * 100)}%)`,
  )

  return [
    'PROJECT MEMORY:',
    'The following facts describe this project and should be respected when relevant.',
    ...lines,
    '',
  ].join('\n')
}