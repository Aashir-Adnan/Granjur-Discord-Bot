import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTaskUpdate } from './taskStatusChange.js'

function fakeDb({ deps = [], tasks = [], cfg = { id: 'g1', guildId: 'guild1' } } = {}) {
  const calls = []
  return {
    calls,
    task: {
      update: async (a) => { calls.push(['update', a]); return null },
      findByIds: async ({ where }) => tasks.filter((t) => where.ids.includes(t.id)),
    },
    taskDependency: { findByTask: async ({ where }) => deps.filter((d) => d.taskId === where.taskId) },
    guildConfig: { findById: async () => cfg },
  }
}
const client = { guilds: { cache: new Map([['guild1', { id: 'guild1', name: 'G' }]]) } }

test('writes the update, computes the blocker warning, and passes actorLabel to notify', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'Git Sync', status: 'open' }
  const db = fakeDb({ deps: [{ taskId: 'A', blockedByTaskId: 'B' }], tasks: [{ id: 'B', title: 'Router fix', status: 'open' }] })
  const seen = []
  const notify = async (a) => { seen.push(a); return { channelId: 'c', created: false, dmed: [] } }
  const out = await applyTaskUpdate({ db, client, task, updates: { status: 'in_progress' }, actor: { label: 'Aashir (via the site)' }, notify })
  assert.deepEqual(db.calls[0], ['update', { where: { id: 'A' }, data: { status: 'in_progress' } }])
  assert.match(out.warning, /Still blocked by: \*\*Router fix\*\*/)
  assert.equal(seen[0].actorLabel, 'Aashir (via the site)')
  assert.equal(seen[0].actorId, null)
  assert.equal(seen[0].guild.id, 'guild1')
  assert.equal(seen[0].warning, out.warning)
})

test('no warning when the status stays open, and a notify failure does not throw', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'in_progress' }
  const db = fakeDb()
  const out = await applyTaskUpdate({ db, client, task, updates: { status: 'open' }, actor: { discordId: '55' }, notify: async () => { throw new Error('boom') } })
  assert.equal(out.warning, '')
  assert.deepEqual(out.notified, { channelId: null, created: false, dmed: [] })
})

test('a failing warning lookup leaves the write in place and warning empty', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'open' }
  const db = fakeDb(); db.taskDependency.findByTask = async () => { throw new Error('db down') }
  const errors = []; const orig = console.error; console.error = (...a) => errors.push(a)
  try {
    const out = await applyTaskUpdate({ db, client, task, updates: { status: 'done' }, notify: async () => ({ channelId: null, created: false, dmed: [] }) })
    assert.equal(out.warning, '')
    assert.equal(db.calls.length, 1)
  } finally { console.error = orig }
})
