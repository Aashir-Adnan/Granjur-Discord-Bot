// Every test passes a fake db. Nothing here may reach the real db export: the
// root .env points at production (.claude/rules/tests-never-touch-production.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectsFor, reattributeGuildDocs } from './docsSync.js'

const LIVE = { id: 'p1', name: 'Framework', docsSlug: 'framework', docsPaths: '[]', deletedAt: null }
const DELETED = { id: 'p2', name: 'Apollo', docsSlug: 'apollo', docsPaths: '["apollo-guides"]', deletedAt: new Date('2026-10-01T09:00:00Z') }

/** A project table that hides a deleted project unless the read opts in, as the real one does. */
function fakeDb(pages = []) {
  const reads = []
  const moved = []
  return {
    reads,
    moved,
    project: {
      findMany: async ({ where }) => {
        reads.push(where)
        return [LIVE, DELETED].filter((p) => where.includeDeleted === true || !p.deletedAt)
      },
    },
    docPage: {
      listIndexFull: async () => pages,
      setProjectId: async (args) => { moved.push(args) },
    },
  }
}

test('the docs sync reads every project of the guild, deleted ones included', async () => {
  const db = fakeDb()
  const projects = await projectsFor('g1', db)
  assert.deepEqual(db.reads, [{ guildConfigId: 'g1', includeDeleted: true }])
  assert.deepEqual(projects.map((p) => p.id), ['p1', 'p2'])
  assert.deepEqual(projects[1].docsPaths, ['apollo-guides'])
})

test("re-attribution keeps a deleted project's pages attributed to it (Review Focus 4)", async () => {
  const pages = [
    { id: 'd1', path: 'docs/projects/apollo/intro.md', source: 'repo', projectId: 'p2' },
    { id: 'd2', path: 'docs/apollo-guides/setup.md', source: 'repo', projectId: 'p2' },
    { id: 'd3', path: 'docs/projects/framework/a.md', source: 'repo', projectId: 'p1' },
  ]
  const db = fakeDb(pages)
  const changed = await reattributeGuildDocs('g1', { db })
  assert.equal(changed, 0)
  assert.deepEqual(db.moved, [], 'no page was unhooked from the deleted project')
})

test('a page that belongs to a deleted project is still attributed to it when it first arrives', async () => {
  const db = fakeDb([{ id: 'd1', path: 'docs/projects/apollo/new.md', source: 'repo', projectId: null }])
  const changed = await reattributeGuildDocs('g1', { db })
  assert.equal(changed, 1)
  assert.deepEqual(db.moved, [{ guildConfigId: 'g1', id: 'd1', projectId: 'p2' }])
})
