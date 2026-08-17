// Drives pushCommit against a stubbed GitHub, asserting the exact call sequence.
import { pushCommit } from './github'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) pass++
  else {
    fail++
    console.log(`  FAIL ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`)

type Route = { match: RegExp; method?: string; status: number; body?: any }
const calls: { method: string; path: string; body: any }[] = []

function stub(routes: Route[]) {
  calls.length = 0
  ;(globalThis as any).fetch = async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET'
    const path = url.replace('https://api.github.com', '')
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined })
    const r = routes.find((x) => x.match.test(path) && (!x.method || x.method === method))
    if (!r) throw new Error(`unstubbed ${method} ${path}`)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Map<string, string>() as any,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    }
  }
}
const seq = () => calls.map((c) => `${c.method} ${c.path.replace(/^\/repos\/me\/app/, '')}`)
const FILES = [{ path: 'index.html', content: '<h1>hi</h1>' }]
const REF = { owner: 'me', repo: 'app', branch: 'main' }

// ── 1 · A brand-new empty repository — the case that was broken ──────
// GitHub answers 409 "Git Repository is empty." to every Git-database read, so
// the push must initialize through the contents API and then replace that commit.
console.log('empty repository (first push)')
stub([
  { match: /\/git\/ref\/heads\/main$/, status: 409, body: { message: 'Git Repository is empty.' } },
  { match: /\/commits\?per_page=1$/, status: 409, body: { message: 'Git Repository is empty.' } },
  { match: /\/contents\/\.lumen-init$/, method: 'PUT', status: 201, body: { commit: { sha: 'PLACEHOLDER' } } },
  { match: /\/git\/trees$/, method: 'POST', status: 201, body: { sha: 'TREE' } },
  { match: /\/git\/commits$/, method: 'POST', status: 201, body: { sha: 'COMMIT', html_url: 'u' } },
  { match: /\/git\/refs\/heads\/main$/, method: 'PATCH', status: 200, body: {} },
])
let res = await pushCommit('t', REF, FILES, [], 'first')
eq('  call sequence', seq(), [
  'GET /git/ref/heads/main',
  'GET /commits?per_page=1',
  'PUT /contents/.lumen-init',
  'POST /git/trees',
  'POST /git/commits',
  'PATCH /git/refs/heads/main',
])
check('  tree has no base_tree', calls[3].body.base_tree === undefined, JSON.stringify(calls[3].body))
eq('  commit is a root commit', calls[4].body.parents, [])
check('  ref move is forced', calls[5].body.force === true)
eq('  placeholder not in the tree', calls[3].body.tree.map((t: any) => t.path), ['index.html'])
eq('  reports createdBranch', res.createdBranch, true)
eq('  commit sha', res.commitSha, 'COMMIT')

// ── 2 · An ordinary push onto an existing branch ─────────────────────
console.log('existing branch')
stub([
  { match: /\/git\/ref\/heads\/main$/, status: 200, body: { object: { sha: 'HEAD' } } },
  { match: /\/git\/commits\/HEAD$/, status: 200, body: { tree: { sha: 'BASETREE' } } },
  { match: /\/git\/trees\/BASETREE/, status: 200, body: { tree: [{ path: 'old.js', type: 'blob' }] } },
  { match: /\/git\/trees$/, method: 'POST', status: 201, body: { sha: 'NEWTREE' } },
  { match: /\/git\/commits$/, method: 'POST', status: 201, body: { sha: 'C2', html_url: 'u' } },
  { match: /\/git\/refs\/heads\/main$/, method: 'PATCH', status: 200, body: {} },
])
res = await pushCommit('t', REF, FILES, ['old.js'], 'update')
check('  builds on base_tree', calls[3].body.base_tree === 'BASETREE')
eq('  parents is the old head', calls[4].body.parents, ['HEAD'])
check('  ref move is NOT forced', calls[5].body.force === false)
eq('  deletes the path it wrote before', res.removed, ['old.js'])
check(
  '  deletion sent as sha:null',
  calls[3].body.tree.some((t: any) => t.path === 'old.js' && t.sha === null)
)
eq('  not createdBranch', res.createdBranch, false)

// ── 3 · A file we never pushed is never deleted ──────────────────────
console.log('files Lumen did not write')
stub([
  { match: /\/git\/ref\/heads\/main$/, status: 200, body: { object: { sha: 'HEAD' } } },
  { match: /\/git\/commits\/HEAD$/, status: 200, body: { tree: { sha: 'BASETREE' } } },
  { match: /\/git\/trees\/BASETREE/, status: 200, body: { tree: [{ path: 'README.md', type: 'blob' }] } },
  { match: /\/git\/trees$/, method: 'POST', status: 201, body: { sha: 'NEWTREE' } },
  { match: /\/git\/commits$/, method: 'POST', status: 201, body: { sha: 'C3', html_url: 'u' } },
  { match: /\/git\/refs\/heads\/main$/, method: 'PATCH', status: 200, body: {} },
])
res = await pushCommit('t', REF, FILES, [], 'update')
eq('  README untouched', res.removed, [])
check('  README not in tree', !calls[3].body.tree.some((t: any) => t.path === 'README.md'))

// ── 4 · Nothing changed → no commit at all ──────────────────────────
console.log('workspace already matches the branch')
stub([
  { match: /\/git\/ref\/heads\/main$/, status: 200, body: { object: { sha: 'HEAD' } } },
  { match: /\/git\/commits\/HEAD$/, status: 200, body: { tree: { sha: 'SAME' } } },
  { match: /\/git\/trees\/SAME/, status: 200, body: { tree: [] } },
  { match: /\/git\/trees$/, method: 'POST', status: 201, body: { sha: 'SAME' } },
])
res = await pushCommit('t', REF, FILES, [], 'noop')
eq('  reports unchanged', res.unchanged, true)
check('  no commit written', !calls.some((c) => c.method === 'POST' && c.path.endsWith('/git/commits')))
check('  no ref moved', !calls.some((c) => c.method === 'PATCH'))

// ── 5 · Repo has commits, but not this branch → create it, no bootstrap ──
console.log('branch does not exist yet')
stub([
  { match: /\/git\/ref\/heads\/main$/, status: 404, body: { message: 'Not Found' } },
  { match: /\/commits\?per_page=1$/, status: 200, body: [{ sha: 'X' }] },
  { match: /\/git\/trees$/, method: 'POST', status: 201, body: { sha: 'T' } },
  { match: /\/git\/commits$/, method: 'POST', status: 201, body: { sha: 'C', html_url: 'u' } },
  { match: /\/git\/refs$/, method: 'POST', status: 201, body: {} },
])
res = await pushCommit('t', REF, FILES, [], 'new branch')
check('  did NOT initialize', !calls.some((c) => c.path.includes('.lumen-init')))
eq('  creates the ref', calls[4].method + ' ' + calls[4].path, 'POST /repos/me/app/git/refs')
eq('  ref name', calls[4].body.ref, 'refs/heads/main')

// ── 6 · Someone else pushed mid-flight → reported, never forced ──────
console.log('branch moved during the push')
stub([
  { match: /\/git\/ref\/heads\/main$/, status: 200, body: { object: { sha: 'HEAD' } } },
  { match: /\/git\/commits\/HEAD$/, status: 200, body: { tree: { sha: 'BASETREE' } } },
  { match: /\/git\/trees\/BASETREE/, status: 200, body: { tree: [] } },
  { match: /\/git\/trees$/, method: 'POST', status: 201, body: { sha: 'NEWTREE' } },
  { match: /\/git\/commits$/, method: 'POST', status: 201, body: { sha: 'C', html_url: 'u' } },
  { match: /\/git\/refs\/heads\/main$/, method: 'PATCH', status: 422, body: { message: 'Update is not a fast forward' } },
])
try {
  await pushCommit('t', REF, FILES, [], 'race')
  check('  raises on a non-fast-forward', false, 'no error thrown')
} catch (e: any) {
  check('  raises on a non-fast-forward', /moved on GitHub/.test(e.message), e.message)
  check('  never retried with force', !calls.some((c) => c.body?.force === true))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
