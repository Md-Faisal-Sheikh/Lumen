import { Router } from 'express'
import { prisma } from './db'
import { publicUrl } from './publish'
import { asRuntime } from './runtime'

// ── Discovery ───────────────────────────────────────────────────────
//
// Two lists, and they are deliberately different things:
//
//   templates — projects whose owners marked them as starting points. You fork
//               one and get an editable copy of your own.
//   gallery   — published pages whose owners chose to list them. You open one
//               and look at it. Forking is not offered, because a publication
//               is a snapshot of HTML rather than a workspace, and the project
//               behind it belongs to someone who published a *page*, not a
//               template.
//
// Neither route is authenticated, which is the point of a public gallery — but
// that makes what these queries *select* load-bearing. Everything returned here
// is already public by an explicit decision of the owner: a template's name and
// description, a publication's title and slug. No emails, no user ids, no
// project ids for anything that is not forkable, and never `Publication.html`,
// which would let this endpoint serve user-authored script from our origin —
// the exact thing publish.ts goes to such lengths to avoid.

export const discoverRouter = Router()

const PAGE = 60

// Projects offered as starting points. `updatedAt` ordering means an actively
// maintained template rises; forkCount is shown but deliberately does not sort,
// so a new template is not buried under whatever was popular first.
discoverRouter.get('/templates', async (_req, res) => {
  const templates = await prisma.project.findMany({
    where: { isTemplate: true },
    orderBy: { updatedAt: 'desc' },
    take: PAGE,
    select: {
      id: true,
      name: true,
      description: true,
      runtime: true,
      forkCount: true,
      updatedAt: true,
      owner: { select: { name: true, color: true } },
    },
  })
  res.json({
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      runtime: asRuntime(t.runtime),
      forkCount: t.forkCount,
      updatedAt: t.updatedAt,
      authorName: t.owner.name,
      authorColor: t.owner.color,
    })),
  })
})

// Published pages their owners chose to list. Note what is absent: `html` is
// never selected, and `projectId` never leaves the server — a gallery entry is
// a link to a page, not a handle on somebody's project.
discoverRouter.get('/gallery', async (req, res) => {
  const pages = await prisma.publication.findMany({
    where: { listed: true },
    orderBy: { updatedAt: 'desc' },
    take: PAGE,
    select: {
      slug: true,
      title: true,
      views: true,
      updatedAt: true,
      project: { select: { runtime: true, owner: { select: { name: true, color: true } } } },
    },
  })
  res.json({
    pages: pages.map((p) => ({
      slug: p.slug,
      title: p.title,
      url: publicUrl(req, p.slug),
      views: p.views,
      runtime: asRuntime(p.project.runtime),
      updatedAt: p.updatedAt,
      authorName: p.project.owner.name,
      authorColor: p.project.owner.color,
    })),
  })
})
