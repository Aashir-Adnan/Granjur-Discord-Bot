import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTaskRepo, repoReasonText, loadProjectLinks } from './taskRepo.js'

const R1 = { id: 'r1', name: 'Framework_Node', url: 'https://github.com/ubs-dev-org/Framework_Node' }
const R2 = { id: 'r2', name: 'Framework_React', url: 'https://github.com/ubs-dev-org/Framework_React' }
const repos = [R1, R2]
const link = (repository_id, scope = null, project_id = 'p1') => ({ project_id, repository_id, scope })

test('rule 1: the link with the task scope', () => {
  const out = resolveTaskRepo({ projectId: 'p1', scope: 'frontend' }, { links: [link('r1', 'backend'), link('r2', 'frontend')], repos })
  assert.deepEqual(out, { repository: R2, reason: 'scope' })
})

test('rule 2: the only link, when it has no scope', () => {
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: 'qa' }, { links: [link('r1')], repos }), { repository: R1, reason: 'only-repo' })
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: null }, { links: [link('r1')], repos }), { repository: R1, reason: 'only-repo' })
})

test('a single link tagged with another scope is not used', () => {
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: 'frontend' }, { links: [link('r1', 'backend')], repos }), { repository: null, reason: 'no-repo-for-scope' })
})

test('two links, neither with the scope: none (never "the first")', () => {
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: 'design' }, { links: [link('r1'), link('r2')], repos }), { repository: null, reason: 'no-repo-for-scope' })
})

test('no project, or no scope with only tagged links', () => {
  assert.deepEqual(resolveTaskRepo({ projectId: null, scope: 'backend' }, { links: [], repos }), { repository: null, reason: 'no-project' })
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: null }, { links: [link('r1', 'backend'), link('r2', 'frontend')], repos }), { repository: null, reason: 'no-scope' })
})

// Badar HMS, 2026-09-30: one repository holds backend AND frontend, a second
// holds the mobile app. A link carries one scope, so the shared repository is
// left untagged and takes every scope no tagged repository claims.
test('rule 2: the one untagged link takes every scope no tagged link claims', () => {
  const links = [link('r1'), link('r2', 'mobile')]
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: 'mobile' }, { links, repos }), { repository: R2, reason: 'scope' })
  for (const scope of ['backend', 'frontend', 'qa', 'design', null]) {
    assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope }, { links, repos }), { repository: R1, reason: 'only-repo' }, String(scope))
  }
})

test('two untagged links beside a tagged one: still none', () => {
  const R3 = { id: 'r3', name: 'Third', url: 'https://github.com/o/third' }
  const out = resolveTaskRepo({ projectId: 'p1', scope: 'backend' }, { links: [link('r1'), link('r3'), link('r2', 'mobile')], repos: [...repos, R3] })
  assert.deepEqual(out, { repository: null, reason: 'no-repo-for-scope' })
})

test("links of other projects and links to deleted repositories are ignored", () => {
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: 'backend' }, { links: [link('r1', 'backend', 'p2'), link('gone', 'backend')], repos }), { repository: null, reason: 'no-repo-for-scope' })
})

test('reason text', () => {
  assert.equal(repoReasonText('no-project'), 'the task has no project')
  assert.equal(repoReasonText('no-scope'), 'the task has no scope')
  assert.equal(repoReasonText('no-repo-for-scope'), 'the project has no repository for this scope')
})

test('loadProjectLinks reads one project through the db seam and never throws', async () => {
  const seen = []
  const db = { projectRepos: { findMany: async (q) => { seen.push(q); return [link('r1', 'backend')] } } }
  assert.deepEqual(await loadProjectLinks(db, 'p1'), [link('r1', 'backend')])
  assert.deepEqual(seen, [{ where: { project_id: 'p1' } }])
  assert.deepEqual(await loadProjectLinks(db, null), [])
  const warn = console.warn
  console.warn = () => {}
  try { assert.deepEqual(await loadProjectLinks({}, 'p1'), []) } finally { console.warn = warn }
})
