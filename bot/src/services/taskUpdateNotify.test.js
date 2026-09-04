import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assigneeDiff,
  changeSummary,
  ownsChannel,
  notifyTaskUpdate,
  TERMINAL_STATUSES,
} from './taskUpdateNotify.js'

test('assigneeDiff reports who gained and who lost the task', () => {
  assert.deepEqual(assigneeDiff(['1', '2'], ['2', '3']), { added: ['3'], removed: ['1'] })
  assert.deepEqual(assigneeDiff([], ['1']), { added: ['1'], removed: [] })
  assert.deepEqual(assigneeDiff('["1"]', []), { added: [], removed: ['1'] })
  assert.deepEqual(assigneeDiff(['1'], ['1']), { added: [], removed: [] })
})

test('changeSummary lists only fields that actually changed', () => {
  const before = { status: 'open', passedQaTests: 0, implementationStatus: 'not_started' }
  const lines = changeSummary(before, {
    status: 'in_progress',
    passedQaTests: 0, // unchanged — must not appear
    implementationStatus: 'in_progress',
  })
  assert.deepEqual(lines, [
    '**status**: `open` → `in_progress`',
    '**implementation**: `not_started` → `in_progress`',
  ])
})

test('changeSummary never inlines a title or description diff, and skips assignees', () => {
  const lines = changeSummary(
    { title: 'Old', description: 'a', status: 'open' },
    { title: 'New', description: 'b', assigneeIds: ['9'] },
  )
  assert.deepEqual(lines, ['**title** updated', '**description** updated'])
})

test('ownsChannel tells a task channel from the meeting channel it was announced in', () => {
  assert.equal(ownsChannel('b62ffdcece31488c893f56be0', 'feature-f56be0'), true)
  assert.equal(ownsChannel('b62ffdcece31488c893f56be0', 'bug-f56be0'), true)
  assert.equal(ownsChannel('b62ffdcece31488c893f56be0', 'pipeline-test'), false)
  assert.equal(ownsChannel('b62ffdcece31488c893f56be0', 'feature-aaaaaa'), false)
  assert.equal(ownsChannel('', 'feature-f56be0'), false)
})

// --- notifyTaskUpdate -------------------------------------------------------

function harness({ channel = null, taskId = 'aaaaaabbbbbbcccccc123456' } = {}) {
  const dms = []
  const created = []
  const client = {
    channels: { fetch: async () => channel },
    users: { fetch: async (id) => ({ send: async (m) => dms.push([id, m]) }) },
  }
  const guild = {
    id: 'g1',
    channels: {
      cache: { find: () => null },
      create: async (o) => {
        created.push(o)
        return {
          id: 'newchan',
          name: o.name,
          guild: { id: 'g1' },
          send: async () => ({ id: 'm' }),
          permissionOverwrites: { edit: async () => {}, delete: async () => {} },
        }
      },
    },
  }
  return { client, guild, dms, created, taskId }
}

test('a newly assigned member is DMed and given a channel that did not exist', async () => {
  const h = harness()
  const task = { id: h.taskId, title: 'Audit encryption', status: 'open', assigneeIds: [], discordChannelId: null }
  const out = await notifyTaskUpdate({
    client: h.client,
    guild: h.guild,
    task,
    before: task,
    updates: { assigneeIds: ['11'] },
    actorId: '99',
  })
  assert.equal(out.created, true)
  assert.equal(out.channelId, 'newchan')
  // Channel is named for the task and holds the assignee plus the actor.
  assert.equal(h.created[1].name, 'feature-123456')
  assert.deepEqual(h.created[1].permissionOverwrites.slice(1).map((o) => o.id), ['11', '99'])
  assert.deepEqual(out.dmed, ['11'])
  assert.equal(h.dms.length, 1)
  assert.match(h.dms[0][1], /Audit encryption/)
})

test('a field edit posts in the task channel and DMs nobody', async () => {
  const posts = []
  const grants = []
  const channel = {
    id: 'own',
    name: 'feature-123456',
    guild: { id: 'g1' },
    send: async (m) => posts.push(m),
    permissionOverwrites: { edit: async (id) => grants.push(id), delete: async () => {} },
  }
  const h = harness({ channel })
  const task = { id: h.taskId, title: 'T', status: 'open', assigneeIds: ['11'], discordChannelId: 'own' }
  const out = await notifyTaskUpdate({
    client: h.client,
    guild: h.guild,
    task,
    before: task,
    updates: { passedQaTests: 3 },
    actorId: '99',
  })
  assert.deepEqual(out.dmed, [])
  assert.equal(h.dms.length, 0)
  assert.equal(grants.length, 0)
  assert.equal(posts.length, 1)
  assert.match(posts[0], /<@99> updated this task:/)
  assert.match(posts[0], /QA tests passed/)
})

test('closing a task DMs its holders once, and reassignment revokes access', async () => {
  const revoked = []
  const channel = {
    id: 'own',
    name: 'feature-123456',
    guild: { id: 'g1' },
    send: async () => {},
    permissionOverwrites: { edit: async () => {}, delete: async (id) => revoked.push(id) },
  }
  const h = harness({ channel })
  const task = { id: h.taskId, title: 'T', status: 'in_progress', assigneeIds: ['11'], discordChannelId: 'own' }
  const out = await notifyTaskUpdate({
    client: h.client,
    guild: h.guild,
    task,
    before: task,
    updates: { status: 'closed', assigneeIds: ['22'] },
    actorId: '99',
  })
  assert.deepEqual(revoked, ['11'])
  // '22' is DMed as a new assignee; it must not also get the closure DM.
  assert.deepEqual(out.dmed, ['22'])
  assert.equal(h.dms.filter(([, m]) => /was marked/.test(m)).length, 0)
  assert.ok(TERMINAL_STATUSES.has('closed'))
})

test('an already-closed task closing again does not re-DM', async () => {
  const channel = {
    id: 'own',
    name: 'feature-123456',
    guild: { id: 'g1' },
    send: async () => {},
    permissionOverwrites: { edit: async () => {}, delete: async () => {} },
  }
  const h = harness({ channel })
  const task = { id: h.taskId, title: 'T', status: 'closed', assigneeIds: ['11'], discordChannelId: 'own' }
  const out = await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { status: 'done' }, actorId: '99',
  })
  assert.deepEqual(out.dmed, [])
})

test('the meeting review channel is never treated as the task channel', async () => {
  const posts = []
  const grants = []
  const reviewChannel = {
    id: 'review',
    name: 'pipeline-test',
    guild: { id: 'g1' },
    send: async (m) => posts.push(m),
    permissionOverwrites: { edit: async (id) => grants.push(id), delete: async () => {} },
  }
  const h = harness({ channel: reviewChannel })
  const task = { id: h.taskId, title: 'T', status: 'open', assigneeIds: [], discordChannelId: 'review' }
  const out = await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { assigneeIds: ['11'] }, actorId: '99',
  })
  // A fresh channel is made instead; the shared review channel is untouched.
  assert.equal(out.created, true)
  assert.equal(out.channelId, 'newchan')
  assert.equal(posts.length, 0)
  assert.equal(grants.length, 0)
})

test('an unassigned task with no channel notifies nobody and creates nothing', async () => {
  const h = harness()
  const task = { id: h.taskId, title: 'T', status: 'open', assigneeIds: [], discordChannelId: null }
  const out = await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { status: 'in_progress' }, actorId: '99',
  })
  assert.equal(out.created, false)
  assert.equal(out.channelId, null)
  assert.deepEqual(out.dmed, [])
  assert.equal(h.created.length, 0)
})
