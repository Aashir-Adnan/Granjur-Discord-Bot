import { test } from 'node:test'
import assert from 'node:assert/strict'
import { data, execute, autocomplete, resolveProject } from './client-request.js'

test('two builders, the spec\'s names and options', () => {
  assert.deepEqual(data.map((b) => b.name), ['report-issue', 'request-feature'])
  for (const b of data) {
    const names = b.toJSON().options.map((o) => o.name)
    assert.deepEqual(names, ['title', 'details', 'project', 'document', 'document2', 'document3'])
    assert.equal(b.toJSON().options.find((o) => o.name === 'project').autocomplete, true)
  }
})

test('resolveProject: one client project is used silently; several need a pick; none is null; a foreign id is refused', () => {
  const rows = [{ projectId: 'a', role: 'client' }, { projectId: 'b', role: 'client' }]
  const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'z', name: 'Z' }]
  assert.deepEqual(resolveProject({ rows: rows.slice(0, 1), projects, picked: null }), { project: projects[0], error: null })
  assert.equal(resolveProject({ rows, projects, picked: null }).error, 'pick')
  assert.deepEqual(resolveProject({ rows: [], projects, picked: null }), { project: null, error: null })
  assert.equal(resolveProject({ rows, projects, picked: 'z' }).error, 'foreign')
  assert.deepEqual(resolveProject({ rows, projects, picked: 'b' }), { project: projects[1], error: null })
})

test('execute refuses a project the caller is not a client on, without creating anything', async () => {
  let created = false
  const ix = {
    guild: { id: 'g1' }, user: { id: 'u-c' }, commandName: 'report-issue', replies: [],
    options: { getString: (n) => ({ title: 'T', details: 'D', project: 'z' })[n] ?? null, getAttachment: () => null },
    editReply: async (p) => { ix.replies.push(p) },
  }
  await execute(ix, {
    db: {
      projectMember: { findByMember: async () => [{ projectId: 'a', role: 'client' }] },
      project: { findMany: async () => [{ id: 'a', name: 'A' }, { id: 'z', name: 'Z' }] },
    },
    getConfig: async () => ({ id: 'cfg1' }),
    create: async () => { created = true },
  })
  assert.equal(created, false)
  assert.match(ix.replies[0].content, /not a client on that project/i)
})
