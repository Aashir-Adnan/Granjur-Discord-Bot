import { test } from 'node:test'
import assert from 'node:assert/strict'
import { data, execute, autocomplete, resolveProject } from './client-request.js'

test('two builders: title and details required, the structured fields optional, then project and the three attachments', () => {
  assert.deepEqual(data.map((b) => b.name), ['report-issue', 'request-feature'])
  const issue = data[0].toJSON().options
  assert.deepEqual(issue.map((o) => o.name), [
    'title', 'details', 'platform', 'semester', 'os', 'app_version', 'severity', 'frequency', 'when', 'account', 'steps', 'expected',
    'project', 'screenshot', 'screenshot2', 'document',
  ])
  const feature = data[1].toJSON().options
  assert.deepEqual(feature.map((o) => o.name), [
    'title', 'details', 'platform', 'semester', 'priority', 'needed_by', 'problem', 'who', 'example',
    'project', 'screenshot', 'screenshot2', 'document',
  ])
  for (const opts of [issue, feature]) {
    assert.deepEqual(opts.filter((o) => o.required).map((o) => o.name), ['title', 'details'], 'only title and details are required')
    assert.equal(opts.find((o) => o.name === 'project').autocomplete, true)
    assert.deepEqual(opts.find((o) => o.name === 'platform').choices.map((c) => c.value), ['Web', 'Android', 'iOS', 'Windows', 'macOS', 'Linux', 'Other'])
    for (const name of ['screenshot', 'screenshot2', 'document']) {
      assert.equal(opts.find((o) => o.name === name).type, 11, `${name} is an attachment option`)
    }
    for (const o of opts) assert.ok(o.description.length <= 100, `${o.name} description fits Discord's 100 chars`)
  }
})

test('execute composes the structured fields into the details it hands to create, and collects the screenshots', async () => {
  let got = null
  const values = { title: 'T', details: 'D', platform: 'Web', semester: 'Spring 2027', os: 'Windows 11', steps: 'click it' }
  const ix = {
    guild: { id: 'g1' }, user: { id: 'u-c' }, commandName: 'report-issue', replies: [],
    options: {
      getString: (n) => values[n] ?? null,
      getAttachment: (n) => (n === 'screenshot' ? { url: 'https://cdn/s.png', name: 's.png', size: 1 } : null),
    },
    editReply: async (p) => { ix.replies.push(p) },
  }
  await execute(ix, {
    db: { projectMember: { findByMember: async () => [] }, project: { findMany: async () => [] } },
    getConfig: async () => ({ id: 'cfg1' }),
    create: async (args) => { got = args; return { task: { title: 'T' }, channel: { id: 'c' } } },
  })
  assert.equal(got.details, '**Platform:** Web · **Semester:** Spring 2027 · **OS:** Windows 11\n**Steps:** click it\n\nD')
  assert.deepEqual(got.attachments.map((a) => a.name), ['s.png'])
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
