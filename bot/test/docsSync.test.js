import test from 'node:test'
import assert from 'node:assert/strict'
import { syncOnce } from '../src/services/docsSync.js'

function makeDb(existing = []) {
  const calls = { upserts: [], deletedNotIn: null, sync: null, error: null }
  return {
    calls,
    docPage: {
      listIndexFull: async () => existing,
      upsert: async ({ data }) => calls.upserts.push(data),
      deleteRepoPathsNotIn: async ({ paths }) => {
        calls.deletedNotIn = paths
        return existing.filter((r) => r.source === 'repo' && !paths.includes(r.path)).length
      },
    },
    docSource: {
      recordSync: async (a) => (calls.sync = a),
      recordError: async (a) => (calls.error = a),
    },
  }
}

const SOURCE = {
  owner: 'Aashir-Adnan',
  repo: 'UBS-Doc',
  branch: 'main',
  siteUrl: 'https://ubs-doc.vercel.app',
  lastCommitSha: 'old-sha',
}

const TREE = [
  { path: 'docs/api/overview.md', type: 'blob', sha: 'sha-a', size: 10 },
  { path: 'docs/projects/badar-hms/Opera_Config.md', type: 'blob', sha: 'sha-b', size: 20 },
  { path: 'docs/superpowers/x/SKILL.md', type: 'blob', sha: 'sha-c', size: 5 },
  { path: 'docs/api/_category_.json', type: 'blob', sha: 'sha-d', size: 5 },
  { path: 'src/docs/sidebar.ts', type: 'blob', sha: 'sha-e', size: 5 },
]

const PROJECTS = [{ id: 'p1', docsSlug: 'badar-hms', docsPaths: ['hms-documentation'] }]

test('unchanged head sha short-circuits without fetching the tree', async () => {
  const db = makeDb()
  let treeFetched = false
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'old-sha',
      fetchTree: async () => {
        treeFetched = true
        return TREE
      },
      fetchRaw: async () => '',
    },
  })
  assert.equal(res.skipped, true)
  assert.equal(treeFetched, false)
  assert.equal(db.calls.upserts.length, 0)
})

test('a fresh sync upserts only routable docs', async () => {
  const db = makeDb()
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      fetchTree: async () => TREE,
      fetchRaw: async (path) => `# Title for ${path}\n\nbody\n`,
    },
  })
  assert.equal(res.skipped, false)
  assert.equal(db.calls.upserts.length, 2)
  const paths = db.calls.upserts.map((u) => u.path).sort()
  assert.deepEqual(paths, ['docs/api/overview.md', 'docs/projects/badar-hms/Opera_Config.md'])
  const opera = db.calls.upserts.find((u) => u.path.includes('Opera_Config'))
  assert.equal(opera.projectId, 'p1')
  assert.equal(opera.docId, 'projects/badar-hms/Opera_Config')
  assert.equal(opera.source, 'repo')
  assert.equal(opera.blobSha, 'sha-b')
  const overview = db.calls.upserts.find((u) => u.path === 'docs/api/overview.md')
  assert.equal(overview.projectId, null)
  assert.equal(overview.section, 'api')
})

test('an unchanged blob sha is not re-fetched', async () => {
  const db = makeDb([
    { path: 'docs/api/overview.md', blobSha: 'sha-a', source: 'repo' },
    { path: 'docs/projects/badar-hms/Opera_Config.md', blobSha: 'stale', source: 'repo' },
  ])
  const fetched = []
  await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      fetchTree: async () => TREE,
      fetchRaw: async (path) => {
        fetched.push(path)
        return '# T\n'
      },
    },
  })
  assert.deepEqual(fetched, ['docs/projects/badar-hms/Opera_Config.md'])
  assert.equal(db.calls.upserts.length, 1)
})

test('deletion is scoped to repo paths still present in the tree', async () => {
  const db = makeDb([{ path: 'docs/api/gone.md', blobSha: 'x', source: 'repo' }])
  await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      fetchTree: async () => TREE,
      fetchRaw: async () => '# T\n',
    },
  })
  assert.deepEqual(db.calls.deletedNotIn.sort(), [
    'docs/api/overview.md',
    'docs/projects/badar-hms/Opera_Config.md',
  ])
})

test('the head sha is recorded after a successful sync', async () => {
  const db = makeDb()
  await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      fetchTree: async () => TREE,
      fetchRaw: async () => '# T\n',
    },
  })
  assert.deepEqual(db.calls.sync, { guildConfigId: 'g1', commitSha: 'new-sha' })
  assert.equal(db.calls.error, null)
})

test('a fetch failure records the error and does not throw', async () => {
  const db = makeDb()
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => {
        throw new Error('403 rate limited')
      },
      fetchTree: async () => TREE,
      fetchRaw: async () => '',
    },
  })
  assert.equal(res.failed, true)
  assert.match(db.calls.error.message, /rate limited/)
  assert.equal(db.calls.sync, null)
})
