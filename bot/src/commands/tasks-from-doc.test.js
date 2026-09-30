// Every test passes fakes for db, getConfig, the feature gates, download and
// extract. The root .env points at production; see
// .claude/rules/tests-never-touch-production.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageFlags } from 'discord.js'
import { data, execute, autocomplete } from './tasks-from-doc.js'
import { DocTextError } from '../services/docText.js'
import { isModalFirstCommand } from './index.js'

const CFG = { id: 'cfg1' }
const FILE = { name: 'Sprint plan.pdf', url: 'https://cdn/x', size: 10 }

function fakeInteraction({ values = {}, file = FILE, channelId = 'chan1', guild = { id: 'guild1' } } = {}) {
  const ix = {
    guild, channelId, replies: [], edits: [], deferred: 0,
    options: { getString: (n) => values[n] ?? null, getAttachment: (n) => (n === 'file' ? file : null) },
    reply: async (p) => { ix.replies.push(p) },
    deferReply: async () => { ix.deferred += 1 },
    editReply: async (p) => { ix.edits.push(p) },
  }
  return ix
}

function fakeDb({ projects = [] } = {}) {
  const calls = { meeting: [], job: [], jobUpdate: [] }
  return {
    calls,
    project: { findFirst: async ({ where }) => projects.find((p) => p.id === where.id) ?? null, findMany: async () => projects },
    meeting: { create: async (a) => { calls.meeting.push(a); return { id: 'm1' } } },
    meetingPipelineJob: {
      create: async (a) => { calls.job.push(a); return { id: 'j1' } },
      update: async (id, patch) => { calls.jobUpdate.push([id, patch]); return {} },
    },
  }
}

const deps = (db, over = {}) => ({
  db,
  getConfig: async () => CFG,
  enabled: () => true,
  configured: () => true,
  download: async () => Buffer.from('x'),
  extract: async () => ({ text: 'the document text', chars: 17 }),
  ...over,
})

test('definition: file required, project autocomplete, title max 100, no default permissions, not deferred by index.js', () => {
  const json = data.toJSON()
  assert.equal(json.name, 'tasks-from-doc')
  assert.equal(json.default_member_permissions ?? null, null)
  const [file, project, title] = json.options
  assert.deepEqual([file.name, file.type, file.required], ['file', 11, true])
  assert.deepEqual([project.name, project.autocomplete, !!project.required], ['project', true, false])
  assert.deepEqual([title.name, title.max_length, !!title.required], ['title', 100, false])
  assert.equal(isModalFirstCommand('tasks-from-doc'), true)
})

test('refuses ephemerally, before deferring, when the pipeline is off', async () => {
  const ix = fakeInteraction()
  const db = fakeDb()
  await execute(ix, deps(db, { enabled: () => false }))
  assert.deepEqual(ix.replies, [{ content: 'Tasks from documents are not available on this server yet.', flags: MessageFlags.Ephemeral }])
  assert.equal(ix.deferred, 0)
  assert.equal(db.calls.meeting.length, 0)
})

test('refuses the same way when CSAAS is not configured', async () => {
  const ix = fakeInteraction()
  await execute(ix, deps(fakeDb(), { configured: () => false }))
  assert.equal(ix.replies[0].content, 'Tasks from documents are not available on this server yet.')
  assert.equal(ix.deferred, 0)
})

test('an unknown project, or one from another server, is refused ephemerally before deferring', async () => {
  for (const values of [{ project: 'nope' }, { project: 'p-other' }]) {
    const ix = fakeInteraction({ values })
    const db = fakeDb({ projects: [{ id: 'p-other', name: 'Other', guildConfigId: 'cfg-x' }] })
    await execute(ix, deps(db))
    assert.deepEqual(ix.replies, [{ content: 'No project matches that name.', flags: MessageFlags.Ephemeral }])
    assert.equal(ix.deferred, 0)
    assert.equal(db.calls.meeting.length, 0)
  }
})

test('a DocTextError is shown verbatim and nothing is created', async () => {
  const ix = fakeInteraction()
  const db = fakeDb()
  const seen = []
  await execute(ix, deps(db, {
    download: async (a) => { seen.push(a); return Buffer.from('x') },
    extract: async () => { throw new DocTextError('**Sprint plan.pdf** has no text.') },
  }))
  assert.deepEqual(seen, [FILE])
  assert.equal(ix.deferred, 1)
  assert.deepEqual(ix.edits, [{ content: '**Sprint plan.pdf** has no text.' }])
  assert.equal(db.calls.meeting.length, 0)
  assert.equal(db.calls.job.length, 0)
})

test('a download DocTextError is shown verbatim too', async () => {
  const ix = fakeInteraction()
  await execute(ix, deps(fakeDb(), { download: async () => { throw new DocTextError('**Sprint plan.pdf** is larger than 10 MB.') } }))
  assert.equal(ix.edits[0].content, '**Sprint plan.pdf** is larger than 10 MB.')
})

test('accepted: defers publicly, creates the meeting and the job, replies publicly; title defaults to the file name without its extension', async () => {
  const ix = fakeInteraction()
  const db = fakeDb()
  await execute(ix, deps(db))
  assert.equal(ix.deferred, 1)
  assert.deepEqual(ix.replies, [], 'the accepted reply is the deferred one, never an ephemeral reply')
  assert.deepEqual(db.calls.meeting, [{ data: { guildConfigId: 'cfg1', channelId: 'chan1', transcript: 'the document text' } }])
  assert.deepEqual(db.calls.job, [{ data: {
    guildConfigId: 'cfg1', meetingId: 'm1',
    dataJson: { source: 'document', reviewChannelId: 'chan1', documentName: 'Sprint plan.pdf', title: 'Sprint plan' },
  } }], 'exactly one create call, carrying the dataJson')
  assert.deepEqual(db.calls.jobUpdate, [], 'no follow-up update')
  assert.deepEqual(ix.edits, [{ content: 'Reading **Sprint plan.pdf** — the proposed tasks will be posted here for review.' }])
})

test('accepted with a project and a title: the project id goes on the meeting and the title on the job', async () => {
  const ix = fakeInteraction({ values: { project: 'p1', title: '  Kickoff  ' } })
  const db = fakeDb({ projects: [{ id: 'p1', name: 'Apollo', guildConfigId: 'cfg1' }] })
  await execute(ix, deps(db))
  assert.equal(db.calls.meeting[0].data.projectId, 'p1')
  assert.equal(db.calls.job[0].data.dataJson.title, 'Kickoff')
})

test('autocomplete offers the guild projects without the detach choice', async () => {
  let responded = null
  const ix = {
    guild: { id: 'guild1' },
    options: { getFocused: () => ({ name: 'project', value: 'ap' }) },
    respond: async (c) => { responded = c },
  }
  const db = fakeDb({ projects: [{ id: 'p1', name: 'Apollo' }, { id: 'p2', name: 'Zeus' }] })
  await autocomplete(ix, { db, getConfig: async () => CFG })
  assert.deepEqual(responded, [{ name: 'Apollo', value: 'p1' }])
})
