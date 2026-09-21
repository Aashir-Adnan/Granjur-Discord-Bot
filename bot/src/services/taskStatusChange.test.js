import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTaskUpdate } from './taskStatusChange.js'

function fakeDb({ deps = [], tasks = [], cfg = { id: 'g1', guildId: 'guild1' } } = {}) {
  const calls = []
  const activity = []
  return {
    calls,
    activity,
    task: {
      update: async (a) => { calls.push(['update', a]); return null },
      findByIds: async ({ where }) => tasks.filter((t) => where.ids.includes(t.id)),
      findChildren: async ({ where }) => tasks.filter((t) => t.parentTaskId === where.parentTaskId),
    },
    taskActivity: { add: async ({ data }) => { activity.push(data) } },
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

test('a channel created by notify is written back onto the row', async () => {
  // Without this the row still points at whatever it pointed at before, so the
  // next /update-task looks the task up, does not find the channel it just
  // made, and makes another — one duplicate becomes one per update, forever.
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'open', discordChannelId: null }
  const db = fakeDb()
  const notify = async () => ({ channelId: 'newchan', created: true, dmed: [] })
  await applyTaskUpdate({ db, client, task, updates: { assigneeIds: ['11'] }, notify })
  assert.deepEqual(db.calls, [
    ['update', { where: { id: 'A' }, data: { assigneeIds: ['11'] } }],
    ['update', { where: { id: 'A' }, data: { discordChannelId: 'newchan' } }],
  ])
})

test('a task that already had its channel is not written back to', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'open', discordChannelId: 'own' }
  const db = fakeDb()
  const notify = async () => ({ channelId: 'own', created: false, dmed: [] })
  await applyTaskUpdate({ db, client, task, updates: { passedQaTests: 2 }, notify })
  assert.equal(db.calls.length, 1)
})

test('a write-back that fails is logged, never thrown', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'open', discordChannelId: null }
  const db = fakeDb()
  let n = 0
  db.task.update = async () => { n += 1; if (n === 2) throw new Error('db down'); return null }
  const notify = async () => ({ channelId: 'newchan', created: true, dmed: [] })
  const errors = []; const orig = console.error; console.error = (...a) => errors.push(a)
  try {
    const out = await applyTaskUpdate({ db, client, task, updates: { assigneeIds: ['11'] }, notify })
    assert.equal(out.notified.channelId, 'newchan')
  } finally { console.error = orig }
  assert.equal(errors.length, 1)
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

test('records who made the change: a Discord actor by id, a site actor by matched member id and label', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'open' }
  const notify = async () => ({ channelId: null, created: false, dmed: [] })
  const db = fakeDb()
  await applyTaskUpdate({ db, client, task, updates: { status: 'done' }, actor: { discordId: 'u1' }, notify })
  await applyTaskUpdate({ db, client, task, updates: { status: 'done' }, actor: { label: 'Aashir (via the site)', activityId: 'u9' }, notify })
  assert.equal(db.activity[0].actorDiscordId, 'u1')
  assert.deepEqual(db.activity[0].changes, [{ field: 'status', from: 'open', to: 'done' }])
  assert.equal(db.activity[1].actorDiscordId, 'u9')
  assert.equal(db.activity[1].actorLabel, 'Aashir (via the site)')
})

test('an update that changes nothing writes no activity row', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'open' }
  const db = fakeDb()
  await applyTaskUpdate({ db, client, task, updates: { status: 'open' }, actor: { discordId: 'u1' }, notify: async () => ({ channelId: null, created: false, dmed: [] }) })
  assert.equal(db.activity.length, 0)
})

test('a failing activity write never fails the update', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'open' }
  const db = fakeDb()
  db.taskActivity.add = async () => { throw new Error('db down') }
  const orig = console.error; console.error = () => {}
  try {
    const out = await applyTaskUpdate({ db, client, task, updates: { status: 'done' }, actor: { discordId: 'u1' }, notify: async () => ({ channelId: null, created: false, dmed: [] }) })
    assert.equal(out.warning, '')
    assert.equal(db.calls[0][0], 'update')
  } finally { console.error = orig }
})
