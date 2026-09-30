// Fakes only — no real db (.claude/rules/tests-never-touch-production.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkRepo, unlinkRepo, linkRefusalText, accessLine, linkUpdatedText, SCOPE_IGNORED_TEXT } from './projectRepoLinks.js'

function fakeDb(initialRows = [], { setScope } = {}) {
  const rows = initialRows.map((r) => ({ ...r }))
  return {
    rows,
    projectRepos: {
      findMany: async ({ where }) => rows.filter((r) => r.project_id === where.project_id),
      add: async ({ data }) => {
        if (rows.some((r) => r.project_id === data.project_id && r.repository_id === data.repository_id)) return
        rows.push({ project_id: data.project_id, repository_id: data.repository_id, scope: null, createdAt: new Date() })
      },
      setScope: setScope
        ? setScope(rows)
        : async ({ project_id, repository_id, scope }) => {
            const row = rows.find((r) => r.project_id === project_id && r.repository_id === repository_id)
            if (row) row.scope = scope
          },
      remove: async ({ project_id, repository_id }) => {
        const i = rows.findIndex((r) => r.project_id === project_id && r.repository_id === repository_id)
        if (i >= 0) rows.splice(i, 1)
      },
    },
  }
}

// --- linkRepo ----------------------------------------------------------------

test('linkRepo: links a new repository with a scope', async () => {
  const db = fakeDb()
  const result = await linkRepo({ db, projectId: 'p1', repositoryId: 'r1', scope: 'backend' })
  assert.deepEqual(result, { ok: true, updated: false })
  assert.deepEqual(db.rows, [{ project_id: 'p1', repository_id: 'r1', scope: 'backend', createdAt: db.rows[0].createdAt }])
})

test('linkRepo: linking the same repo again with another scope updates it', async () => {
  const db = fakeDb([{ project_id: 'p1', repository_id: 'r1', scope: 'backend' }])
  const result = await linkRepo({ db, projectId: 'p1', repositoryId: 'r1', scope: 'frontend' })
  assert.deepEqual(result, { ok: true, updated: true })
  assert.equal(db.rows.length, 1, 'no second row was inserted')
  assert.equal(db.rows[0].scope, 'frontend')
})

test('linkRepo: refuses when another repository already holds the scope', async () => {
  const db = fakeDb([{ project_id: 'p1', repository_id: 'r1', scope: 'backend' }])
  const result = await linkRepo({ db, projectId: 'p1', repositoryId: 'r2', scope: 'backend' })
  assert.deepEqual(result, { ok: false, holderRepositoryId: 'r1' })
  assert.equal(db.rows.length, 1, 'nothing was written')
  assert.equal(db.rows[0].repository_id, 'r1', 'the holder is untouched')
})

test('linkRepo: "No scope" stores null and never conflicts with another null-scope link', async () => {
  const db = fakeDb([{ project_id: 'p1', repository_id: 'r1', scope: null }])
  const result = await linkRepo({ db, projectId: 'p1', repositoryId: 'r2', scope: null })
  assert.deepEqual(result, { ok: true, updated: false })
  assert.equal(db.rows.length, 2)
  assert.ok(db.rows.every((r) => r.scope === null))
})

test('linkRepo: a falsy scope value ("none"-turned-null by the caller) also stores null', async () => {
  const db = fakeDb()
  const result = await linkRepo({ db, projectId: 'p1', repositoryId: 'r1', scope: null })
  assert.deepEqual(result, { ok: true, updated: false })
  assert.equal(db.rows[0].scope, null)
})

test('linkRepo: a duplicate-key race from setScope is re-read and reported as a refusal', async () => {
  const db = fakeDb([{ project_id: 'p1', repository_id: 'r1', scope: 'backend' }], {
    setScope: (rows) => async () => {
      // Simulate another request winning the race: by the time our setScope
      // runs, r1 already holds 'backend' — the unique key on (project_id,
      // scope) throws instead of applying.
      const err = new Error('ER_DUP_ENTRY')
      err.errno = 1062
      throw err
    },
  })
  const result = await linkRepo({ db, projectId: 'p1', repositoryId: 'r2', scope: 'backend' })
  assert.deepEqual(result, { ok: false, holderRepositoryId: 'r1' })
})

test('linkRepo: a race right after inserting a NEW row removes that row before refusing (no stray untagged link)', async () => {
  const db = fakeDb([], {
    setScope: (rows) => async () => {
      // Another request took 'backend' for r1 between our pre-check and setScope.
      rows.push({ project_id: 'p1', repository_id: 'r1', scope: 'backend' })
      const err = new Error('ER_DUP_ENTRY')
      err.code = 'ER_DUP_ENTRY'
      throw err
    },
  })
  const result = await linkRepo({ db, projectId: 'p1', repositoryId: 'r2', scope: 'backend' })
  assert.deepEqual(result, { ok: false, holderRepositoryId: 'r1' })
  assert.deepEqual(db.rows.map((r) => [r.repository_id, r.scope]), [['r1', 'backend']], 'the untagged r2 row this call added is gone')
})

test('linkRepo: a race on an EXISTING link leaves that link in place', async () => {
  const db = fakeDb([{ project_id: 'p1', repository_id: 'r2', scope: 'frontend' }], {
    setScope: (rows) => async () => {
      rows.push({ project_id: 'p1', repository_id: 'r1', scope: 'backend' })
      const err = new Error('ER_DUP_ENTRY')
      err.errno = 1062
      throw err
    },
  })
  const result = await linkRepo({ db, projectId: 'p1', repositoryId: 'r2', scope: 'backend' })
  assert.deepEqual(result, { ok: false, holderRepositoryId: 'r1' })
  assert.ok(db.rows.some((r) => r.repository_id === 'r2' && r.scope === 'frontend'), 'the pre-existing link survives')
})

test('linkRepo: a non-duplicate-key error from setScope is not swallowed', async () => {
  const db = fakeDb([], {
    setScope: () => async () => {
      throw new Error('connection lost')
    },
  })
  await assert.rejects(
    () => linkRepo({ db, projectId: 'p1', repositoryId: 'r1', scope: 'backend' }),
    /connection lost/
  )
})

// --- unlinkRepo ----------------------------------------------------------------

test('unlinkRepo: removes only the given project/repository pair', async () => {
  const db = fakeDb([
    { project_id: 'p1', repository_id: 'r1', scope: 'backend' },
    { project_id: 'p1', repository_id: 'r2', scope: 'frontend' },
    { project_id: 'p2', repository_id: 'r1', scope: null },
  ])
  await unlinkRepo({ db, projectId: 'p1', repositoryId: 'r1' })
  assert.deepEqual(
    db.rows.map((r) => [r.project_id, r.repository_id]),
    [
      ['p1', 'r2'],
      ['p2', 'r1'],
    ]
  )
})

// --- linkRefusalText -----------------------------------------------------------

test('linkRefusalText: verbatim', () => {
  assert.equal(
    linkRefusalText('Framework', 'frontend-repo', 'backend'),
    'Framework already has frontend-repo as its Backend repository — unlink it or pick another scope.'
  )
})

// --- accessLine ------------------------------------------------------------

test('accessLine: ok', () => {
  assert.equal(accessLine({ ok: true }), '✅ GitHub access OK')
})

test('accessLine: no-access uses the message from checkRepoAccess verbatim', () => {
  assert.equal(
    accessLine({ ok: false, code: 'no-access', message: 'No GitHub access to o/r' }),
    "⚠️ No GitHub access to o/r — issues won't open until a token can reach it"
  )
})

test('accessLine: bad-url falls back to the url text in place of owner/repo', () => {
  assert.equal(
    accessLine({ ok: false, code: 'bad-url', message: 'Not a GitHub repository URL', url: 'not-a-url' }),
    "⚠️ No GitHub access to not-a-url — issues won't open until a token can reach it"
  )
})

test('accessLine: error', () => {
  assert.equal(
    accessLine({ ok: false, code: 'error', message: 'timeout' }),
    "GitHub access couldn't be checked right now."
  )
})

test('accessLine: issues disabled shows its own message', () => {
  assert.equal(
    accessLine({ ok: false, code: 'no-access', message: 'Issues are disabled on o/r', issuesDisabled: true }),
    "⚠️ Issues are disabled on o/r — issues won't open until they are turned on in the repository's settings"
  )
})

// --- M5 / M6 texts -------------------------------------------------------------

test('linkUpdatedText: names the repository, the project and the new scope', () => {
  assert.equal(linkUpdatedText('bot', 'Framework', 'backend'), 'Updated **bot** in **Framework** to Backend.')
  assert.equal(linkUpdatedText('bot', 'Framework', null), 'Updated **bot** in **Framework** to no scope.')
})

test('SCOPE_IGNORED_TEXT: verbatim', () => {
  assert.equal(SCOPE_IGNORED_TEXT, 'Scope ignored — give a project to link with a scope.')
})
