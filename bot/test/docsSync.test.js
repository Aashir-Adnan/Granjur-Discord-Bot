import test from 'node:test'
import assert from 'node:assert/strict'
import { syncOnce, fetchHeadSha, fetchTree, __resetGhTokenState } from '../src/services/docsSync.js'

function makeDb(existing = []) {
  const calls = { upserts: [], deletedNotIn: null, sync: null, error: null, attributed: [] }
  return {
    calls,
    docPage: {
      listIndexFull: async () => existing,
      upsert: async ({ data }) => calls.upserts.push(data),
      setProjectId: async (a) => calls.attributed.push(a),
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

// --- Refusing to act on an incomplete picture of the repository ---

test('a truncated tree fails the cycle: no delete pass and no head sha recorded', async () => {
  const db = makeDb([{ id: 'r1', path: 'docs/api/overview.md', blobSha: 'sha-a', source: 'repo' }])
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      // fetchTree throws on json.truncated; syncOnce must not paper over it.
      fetchTree: async () => {
        throw new Error('GitHub tree response was truncated — refusing to sync a partial tree')
      },
      fetchRaw: async () => '# T\n',
    },
  })
  assert.equal(res.failed, true)
  assert.equal(db.calls.deletedNotIn, null)
  assert.equal(db.calls.sync, null)
  assert.match(db.calls.error.message, /truncated/)
})

test('fetchTree throws rather than returning a truncated tree', async () => {
  const fetchImpl = async () => fakeResponse(200, { truncated: true, tree: [{ path: 'docs/a.md' }] })
  await assert.rejects(() => fetchTree(SOURCE, { fetchImpl }), /truncated/)
})

test('an empty document list never runs the delete pass', async () => {
  const db = makeDb([{ id: 'r1', path: 'docs/api/overview.md', blobSha: 'sha-a', source: 'repo' }])
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      // A branch with no docs/ at all, or a tree that came back wrong.
      fetchTree: async () => [{ path: 'README.md', type: 'blob', sha: 'z', size: 1 }],
      fetchRaw: async () => '# T\n',
    },
  })
  assert.equal(res.failed, true)
  assert.equal(db.calls.deletedNotIn, null)
  assert.equal(db.calls.sync, null)
  assert.match(db.calls.error.message, /no documentation files/)
})

test('one failing file does not abandon the rest, delete, or record the head sha', async () => {
  const db = makeDb()
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      fetchTree: async () => TREE,
      fetchRaw: async (path) => {
        if (path === 'docs/api/overview.md') throw new Error('raw 404 for docs/api/overview.md')
        return '# T\n'
      },
    },
  })
  // The other document still landed.
  assert.equal(res.upserted, 1)
  assert.equal(res.failedFiles, 1)
  assert.deepEqual(
    db.calls.upserts.map((u) => u.path),
    ['docs/projects/badar-hms/Opera_Config.md']
  )
  // The tree was complete but the mirror is not: nothing is deleted and the
  // next cycle must still retry.
  assert.equal(db.calls.deletedNotIn, null)
  assert.equal(db.calls.sync, null)
  assert.match(db.calls.error.message, /failed to download/)
})

test('a path held by a local page is left alone, not overwritten', async () => {
  const db = makeDb([
    { id: 'r1', path: 'docs/projects/badar-hms/Opera_Config.md', blobSha: null, source: 'local', projectId: 'p1' },
  ])
  const fetched = []
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      fetchTree: async () => TREE,
      fetchRaw: async (path) => {
        fetched.push(path)
        return '# Repo version\n'
      },
    },
  })
  // Never downloaded, never upserted, and still listed as present so the delete
  // pass leaves the repository sibling alone too.
  assert.deepEqual(fetched, ['docs/api/overview.md'])
  assert.deepEqual(
    db.calls.upserts.map((u) => u.path),
    ['docs/api/overview.md']
  )
  assert.equal(res.conflicts, 1)
})

// --- Attribution is independent of the blob diff ---

test('attribution is recomputed on the cycle that short-circuits', async () => {
  const db = makeDb([
    { id: 'r1', path: 'docs/projects/badar-hms/Opera_Config.md', blobSha: 'sha-b', source: 'repo', projectId: null },
    { id: 'r2', path: 'docs/hms-documentation/setup.md', blobSha: 'sha-x', source: 'repo', projectId: null },
  ])
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'old-sha',
      fetchTree: async () => TREE,
      fetchRaw: async () => '',
    },
  })
  assert.equal(res.skipped, true)
  assert.equal(res.reattributed, 2)
  assert.deepEqual(db.calls.attributed, [
    { guildConfigId: 'g1', id: 'r1', projectId: 'p1' },
    { guildConfigId: 'g1', id: 'r2', projectId: 'p1' },
  ])
})

test('re-attribution writes only the rows whose project actually changed', async () => {
  const db = makeDb([
    { id: 'r1', path: 'docs/projects/badar-hms/Opera_Config.md', blobSha: 'sha-b', source: 'repo', projectId: 'p1' },
    { id: 'r2', path: 'docs/api/overview.md', blobSha: 'sha-a', source: 'repo', projectId: null },
    // A Discord-authored page keeps the projectId /edit-docs gave it.
    { id: 'r3', path: 'docs/notes/mine.md', blobSha: null, source: 'local', projectId: 'p1' },
  ])
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'old-sha',
      fetchTree: async () => TREE,
      fetchRaw: async () => '',
    },
  })
  assert.equal(res.reattributed, 0)
  assert.deepEqual(db.calls.attributed, [])
})

test('force ignores the head-sha short-circuit', async () => {
  const db = makeDb()
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    force: true,
    deps: {
      db,
      fetchHeadSha: async () => 'old-sha',
      fetchTree: async () => TREE,
      fetchRaw: async () => '# T\n',
    },
  })
  assert.equal(res.skipped, false)
  assert.equal(db.calls.upserts.length, 2)
  assert.deepEqual(db.calls.sync, { guildConfigId: 'g1', commitSha: 'old-sha' })
})

// --- GITHUB_TOKEN best-effort fallback (bot/src/services/docsSync.js: ghFetch) ---

function fakeResponse(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

test('a 401 triggers exactly one retry, and the retry carries no Authorization header', async () => {
  process.env.GITHUB_TOKEN = 'bad-token'
  __resetGhTokenState()
  try {
    const calls = []
    const fetchImpl = async (_url, opts) => {
      calls.push(opts.headers)
      if (calls.length === 1) return fakeResponse(401, { message: 'Bad credentials' })
      return fakeResponse(200, { sha: 'abc123' })
    }
    const sha = await fetchHeadSha(SOURCE, { fetchImpl })
    assert.equal(sha, 'abc123')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].Authorization, 'Bearer bad-token')
    assert.equal('Authorization' in calls[1], false)
  } finally {
    delete process.env.GITHUB_TOKEN
    __resetGhTokenState()
  }
})

test('the token-rejected warning is logged once per process, not once per call', async () => {
  process.env.GITHUB_TOKEN = 'bad-token'
  __resetGhTokenState()
  const originalWarn = console.warn
  let warnCount = 0
  console.warn = (...args) => {
    if (String(args[0]).includes('GITHUB_TOKEN rejected')) warnCount++
  }
  try {
    const fetchImpl = async (_url, opts) => {
      if (opts.headers.Authorization) return fakeResponse(401, {})
      return fakeResponse(200, { sha: 'x', tree: [] })
    }
    // Three separate calls, as the real sync makes many (173 raw fetches sit
    // behind two of these API calls per pass) — only the first should warn.
    await fetchHeadSha(SOURCE, { fetchImpl })
    await fetchTree(SOURCE, { fetchImpl })
    await fetchHeadSha(SOURCE, { fetchImpl })
  } finally {
    console.warn = originalWarn
    delete process.env.GITHUB_TOKEN
    __resetGhTokenState()
  }
  assert.equal(warnCount, 1)
})

test('a 403 does not reject the token — a later call still sends Authorization', async () => {
  process.env.GITHUB_TOKEN = 'good-token'
  __resetGhTokenState()
  try {
    const calls = []
    const fetchImpl = async (_url, opts) => {
      calls.push(opts.headers.Authorization)
      if (calls.length === 1) return fakeResponse(403, { message: 'secondary rate limit' })
      return fakeResponse(200, { sha: 'ok' })
    }
    // First call: a 403 fails the request normally (syncOnce catches this in
    // production); it must not be treated as a bad token.
    await assert.rejects(() => fetchHeadSha(SOURCE, { fetchImpl }))
    // Second call: Authorization must still be attached.
    const sha = await fetchHeadSha(SOURCE, { fetchImpl })
    assert.equal(sha, 'ok')
    assert.equal(calls.length, 2)
    assert.equal(calls[0], 'Bearer good-token')
    assert.equal(calls[1], 'Bearer good-token')
  } finally {
    delete process.env.GITHUB_TOKEN
    __resetGhTokenState()
  }
})

test('no GITHUB_TOKEN set means no Authorization header at all, not an empty one', async () => {
  delete process.env.GITHUB_TOKEN
  __resetGhTokenState()
  let seenHeaders = null
  const fetchImpl = async (_url, opts) => {
    seenHeaders = opts.headers
    return fakeResponse(200, { sha: 'x' })
  }
  await fetchHeadSha(SOURCE, { fetchImpl })
  assert.equal('Authorization' in seenHeaders, false)
})
