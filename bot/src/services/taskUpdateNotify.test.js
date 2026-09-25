import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import {
  assigneeDiff,
  changeSummary,
  ownsChannel,
  notifyTaskUpdate,
  unblockNotices,
  TERMINAL_STATUSES,
} from './taskUpdateNotify.js'
import { ARCHIVE_DIVIDER_NAME, ARCHIVE_DIVIDER_TOPIC } from '../utils/ticketArchive.js'

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

test('changeSummary formats an estimate change as a duration, not raw minutes', () => {
  assert.deepEqual(changeSummary({ estimateMinutes: null }, { estimateMinutes: 480 }), ['**estimate**: `—` → `8h`'])
  assert.deepEqual(changeSummary({ estimateMinutes: 480 }, { estimateMinutes: 200 }), ['**estimate**: `8h` → `3h 20m`'])
  assert.deepEqual(changeSummary({ estimateMinutes: 480 }, { estimateMinutes: null }), ['**estimate**: `8h` → `—`'])
})

test('changeSummary can omit a field, so a client request channel never sees the estimate', () => {
  const lines = changeSummary({ status: 'open', estimateMinutes: null }, { status: 'pending', estimateMinutes: 90 }, { omit: ['estimateMinutes'] })
  assert.deepEqual(lines, ['**status**: `open` → `pending`'])
})

test('ownsChannel tells a task channel from the meeting channel it was announced in', () => {
  assert.equal(ownsChannel('b62ffdcece31488c893f56be0', 'feature-f56be0'), true)
  assert.equal(ownsChannel('b62ffdcece31488c893f56be0', 'bug-f56be0'), true)
  assert.equal(ownsChannel('b62ffdcece31488c893f56be0', 'pipeline-test'), false)
  assert.equal(ownsChannel('b62ffdcece31488c893f56be0', 'feature-aaaaaa'), false)
  assert.equal(ownsChannel('', 'feature-f56be0'), false)
})

test('ownsChannel also recognises a project-parented channel by its "Task <id>" topic', () => {
  const id = 'b62ffdcece31488c893f56be0'
  // Named after the title, not the id — the old suffix check alone would miss it.
  const owned = { type: ChannelType.GuildText, name: 'feature-git-sync', topic: `Feature: Git Sync — Task ${id}` }
  assert.equal(ownsChannel(id, owned), true)
  // A different task's topic, or no topic at all, is not a match.
  assert.equal(ownsChannel(id, { type: ChannelType.GuildText, name: 'feature-router', topic: `Feature: Router — Task other` }), false)
  assert.equal(ownsChannel(id, { type: ChannelType.GuildText, name: 'feature-git-sync' }), false)
  assert.equal(ownsChannel('', owned), false)
})

test('ownsChannel takes the row over the name: a renamed channel is still its task\'s', () => {
  const id = 'b62ffdcece31488c893f56be0'
  // What /project-setup produced before it learned to carry the topic: the
  // readable name, and the topic the channel was opened with. Neither the old
  // `-f56be0` suffix nor a `Task <id>` marker is there, so without the row's id
  // /update-task builds a duplicate beside it — and another on the next update.
  const renamed = { type: ChannelType.GuildText, id: 'chan-1', name: 'feature-add-booking-rules', topic: 'Feature: Add booking rules' }
  assert.equal(ownsChannel(id, renamed, 'chan-1'), true)
  // Renamed by hand, past all recognition, but still the channel the row names.
  assert.equal(ownsChannel(id, { type: ChannelType.GuildText, id: 'chan-1', name: 'booking', topic: 'Feature: Add booking rules' }, 'chan-1'), true)
  // Another task's channel, whatever the row says.
  assert.equal(ownsChannel(id, renamed, 'chan-2'), false)
  // No row id to go on: the old heuristics, unchanged.
  assert.equal(ownsChannel(id, renamed), false)
  assert.equal(ownsChannel(id, { type: ChannelType.GuildText, id: 'chan-1', name: 'feature-f56be0' }), true)
})

test('ownsChannel never adopts a channel the row points at that is not a ticket channel', () => {
  const id = 'b62ffdcece31488c893f56be0'
  // An unassigned meeting task carries the meeting's SHARED review channel in
  // `discordChannelId`. The row naming it does not make it this task's: giving
  // a new assignee access to everyone's review is a permission change nobody
  // asked for, and the task's edits do not belong in it either.
  const review = { type: ChannelType.GuildText, id: 'review', name: 'pipeline-test', topic: 'Meeting chat is stored in the database.' }
  assert.equal(ownsChannel(id, review, 'review'), false)
  assert.equal(ownsChannel(id, { type: ChannelType.GuildText, id: 'review', name: 'pipeline-test' }, 'review'), false)
})

test('ownsChannel does not claim a meeting channel that merely starts with bug-', () => {
  const id = 'b62ffdcece31488c893f56be0'
  // `/meeting-channel name:"Bug triage"` makes this. The name is anyone's; the
  // topic is the bot's signature, and it says "meeting".
  const triage = {
    type: ChannelType.GuildText,
    id: 'triage',
    name: 'bug-triage-1726650000-text',
    topic: 'Meeting chat is stored in the database with the sender and timestamp.',
  }
  assert.equal(ownsChannel(id, triage, 'triage'), false)
  // A voice channel has no topic and `/create-channel` takes any voice name.
  assert.equal(ownsChannel(id, { type: ChannelType.GuildVoice, id: 'v1', name: 'feature-x' }, 'v1'), false)
  assert.equal(ownsChannel(id, { type: ChannelType.GuildVoice, id: 'v1', name: 'feature-f56be0' }), false)
})

test('a bare name string matches only this task\'s exact legacy name', () => {
  const id = 'b62ffdcece31488c893f56be0'
  // No type, topic or id to consult, so the id-first path can never fire.
  assert.equal(ownsChannel(id, 'bug-triage-f56be0'), false)
  assert.equal(ownsChannel(id, 'feature-f56be0-old'), false)
  assert.equal(ownsChannel(id, 'feature-f56be0', 'anything'), true)
})

test('/update-task never grants an assignee a meeting channel named bug-…', async () => {
  const posts = []
  const grants = []
  const triage = {
    id: 'triage',
    type: ChannelType.GuildText,
    name: 'bug-triage-1726650000-text',
    topic: 'Meeting chat is stored in the database with the sender and timestamp.',
    guild: { id: 'g1' },
    send: async (m) => posts.push(m),
    permissionOverwrites: { edit: async (uid) => grants.push(uid), delete: async () => {} },
  }
  const h = harness({ channel: triage })
  const task = { id: h.taskId, title: 'Fix login', status: 'open', assigneeIds: [], discordChannelId: 'triage' }
  const out = await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { assigneeIds: ['11'] }, actorId: '99', db: noQueryDb,
  })
  assert.deepEqual(grants, [], 'no overwrite on the meeting channel')
  assert.equal(posts.length, 0, 'no task edit posted into it')
  assert.equal(out.created, true)
  assert.equal(out.channelId, 'newchan')
})

// --- notifyTaskUpdate -------------------------------------------------------

function harness({ channel = null, taskId = 'aaaaaabbbbbbcccccc123456' } = {}) {
  const dms = []
  const created = []
  const sends = []
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
          type: ChannelType.GuildText,
          guild: { id: 'g1' },
          send: async (payload) => {
            sends.push(payload)
            return { id: 'm' }
          },
          permissionOverwrites: { edit: async () => {}, delete: async () => {} },
        }
      },
    },
  }
  return { client, guild, dms, created, sends, taskId }
}

// notifyTaskUpdate defaults `db` to the real default export, which points at
// the production database (.claude/rules/tests-never-touch-production.md), so
// every call below passes one. Cases whose path must not reach the database at
// all pass this fake: it throws rather than returning an empty result, so a
// lookup that should never happen is loud in the output (notifyTaskUpdate
// catches and warns around the unblock-notice read) instead of quietly
// succeeding against the live server.
const noQueryDb = {
  taskDependency: { findByBlocker: async () => { throw new Error('test must not query') } },
  task: { findByIds: async () => { throw new Error('test must not query') } },
}

test('a status change DMs the requester in their own words, and the channel post omits the estimate', async () => {
  const posts = []
  const channel = {
    id: 'c1', type: ChannelType.GuildText, name: 'bug-login-fails',
    topic: 'Bug: Login fails — Task aaaaaabbbbbbcccccc123456',
    guild: { id: 'g1' },
    send: async (m) => posts.push(m),
    permissionOverwrites: { edit: async () => {}, delete: async () => {} },
  }
  const h = harness({ channel })
  const task = { id: h.taskId, title: 'Login fails', status: 'open', assigneeIds: [], discordChannelId: 'c1', requestedBy: 'u-c', estimateMinutes: null }
  const out = await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { status: 'pending', estimateMinutes: 90 }, actorId: '99', db: noQueryDb,
  })
  assert.equal(posts.length, 1)
  assert.match(posts[0], /status/)
  assert.ok(!posts[0].includes('estimate'), 'no estimate line in a client request channel')
  const requesterDm = h.dms.find(([id]) => id === 'u-c')
  assert.ok(requesterDm, 'requester DMed')
  assert.match(requesterDm[1], /Waiting on you/)
  assert.ok(out.dmed.includes('u-c'))
})

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
    db: noQueryDb,
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

test('a task carrying a projectId gets a channel inside that project, looked up through the db seam', async () => {
  const projectCategory = { id: 'projcat', name: '📂 FRAMEWORK', parentId: null, type: ChannelType.GuildCategory }
  const catMap = new Map([[projectCategory.id, projectCategory]])
  const created = []
  const dms = []
  const client = {
    channels: { fetch: async () => null },
    users: { fetch: async (id) => ({ send: async (m) => dms.push([id, m]) }) },
  }
  const guild = {
    id: 'g1',
    channels: {
      cache: {
        get: (id) => catMap.get(id) ?? null,
        find: () => null,
        values: () => catMap.values(),
      },
      create: async (o) => {
        created.push(o)
        return { id: 'newchan', type: ChannelType.GuildText, name: o.name, parentId: o.parent, guild: { id: 'g1' }, send: async () => ({ id: 'm' }) }
      },
    },
  }
  let lookedUpId = null
  const dbFake = {
    project: {
      findFirst: async ({ where }) => {
        lookedUpId = where.id
        return { id: 'p1', name: 'Framework', discordCategoryId: 'projcat' }
      },
    },
  }
  const task = {
    id: 'aaaaaabbbbbbcccccc123456',
    title: 'Add booking rules',
    type: 'feature',
    status: 'open',
    assigneeIds: [],
    discordChannelId: null,
    projectId: 'p1',
  }
  const out = await notifyTaskUpdate({
    client, guild, task, before: task,
    updates: { assigneeIds: ['11'] }, actorId: '99', db: dbFake,
  })
  assert.equal(lookedUpId, 'p1')
  assert.equal(out.created, true)
  // Named after the title, not the id, and parented inside the project.
  assert.equal(created[0].name, 'feature-add-booking-rules')
  assert.equal(created[0].parent, 'projcat')
})

test('the channel opened for a newly assigned task is placed by its NEW status, not the one on the row', async () => {
  // The row still says `open`; the same edit that opens the channel also
  // finishes the task, and it is the new status that decides which side of the
  // archive divider the channel belongs on.
  const projectCategory = { id: 'projcat', name: '📂 FRAMEWORK', parentId: null, type: ChannelType.GuildCategory, rawPosition: 0 }
  const divider = { id: 'div', name: ARCHIVE_DIVIDER_NAME, parentId: 'projcat', type: ChannelType.GuildText, topic: ARCHIVE_DIVIDER_TOPIC, rawPosition: 1 }
  const catMap = new Map([[projectCategory.id, projectCategory], [divider.id, divider]])
  const created = []
  const positions = []
  const dms = []
  const client = {
    channels: { fetch: async () => null },
    users: { fetch: async (id) => ({ send: async (m) => dms.push([id, m]) }) },
  }
  const guild = {
    id: 'g1',
    channels: {
      cache: {
        get: (id) => catMap.get(id) ?? null,
        find: () => null,
        values: () => catMap.values(),
      },
      setPositions: async (list) => { positions.push(list) },
      create: async (o) => {
        created.push(o)
        const made = { id: `newchan${created.length}`, type: ChannelType.GuildText, name: o.name, parentId: o.parent, topic: o.topic, rawPosition: catMap.size, guild: { id: 'g1' }, send: async () => ({ id: 'm' }) }
        catMap.set(made.id, made)
        return made
      },
    },
  }
  let lookedUpId = null
  const dbFake = {
    project: {
      findFirst: async ({ where }) => {
        lookedUpId = where.id
        return { id: 'p1', name: 'Framework', discordCategoryId: 'projcat', discordChannels: { archiveDivider: 'div' } }
      },
    },
  }
  const task = {
    id: 'aaaaaabbbbbbcccccc123456',
    title: 'Add booking rules',
    type: 'feature',
    status: 'open',
    assigneeIds: [],
    discordChannelId: null,
    projectId: 'p1',
  }
  const out = await notifyTaskUpdate({
    client, guild, task, before: task,
    updates: { assigneeIds: ['11'], status: 'done' }, actorId: '99', db: dbFake,
  })
  assert.equal(lookedUpId, 'p1')
  assert.equal(out.created, true)
  assert.equal(created[0].parent, 'projcat')
  // Finished on arrival: Discord already put it last, below the line, so no
  // reorder is spent on it at all.
  assert.deepEqual(positions, [])
})

test('a field edit posts in the task channel and DMs nobody', async () => {
  const posts = []
  const grants = []
  const channel = {
    id: 'own',
    name: 'feature-123456',
    type: ChannelType.GuildText,
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
    db: noQueryDb,
  })
  assert.deepEqual(out.dmed, [])
  assert.equal(h.dms.length, 0)
  assert.equal(grants.length, 0)
  assert.equal(posts.length, 1)
  assert.match(posts[0], /<@99> updated this task:/)
  assert.match(posts[0], /QA tests passed/)
})

test('a new assignee is granted the six text bits on the task channel, typed as a member', async () => {
  const grants = []
  const channel = {
    id: 'own',
    name: 'feature-123456',
    type: ChannelType.GuildText,
    guild: { id: 'g1' },
    send: async () => {},
    permissionOverwrites: { edit: async (id, allow, opts) => grants.push({ id, allow, opts }), delete: async () => {} },
  }
  const h = harness({ channel })
  const task = { id: h.taskId, title: 'T', status: 'open', assigneeIds: [], discordChannelId: 'own' }
  await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { assigneeIds: ['11'] }, actorId: '99', db: noQueryDb,
  })
  assert.deepEqual(grants, [{
    id: '11',
    allow: { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true, AddReactions: true },
    opts: { type: OverwriteType.Member },
  }])
})

test('closing a task DMs its holders once, and reassignment revokes access', async () => {
  const revoked = []
  const channel = {
    id: 'own',
    name: 'feature-123456',
    type: ChannelType.GuildText,
    guild: { id: 'g1' },
    send: async () => {},
    permissionOverwrites: { edit: async () => {}, delete: async (id) => revoked.push(id) },
  }
  const h = harness({ channel })
  const task = { id: h.taskId, title: 'T', status: 'in_progress', assigneeIds: ['11'], discordChannelId: 'own', guildConfigId: 'g1' }
  const out = await notifyTaskUpdate({
    client: h.client,
    guild: h.guild,
    task,
    before: task,
    updates: { status: 'closed', assigneeIds: ['22'] },
    actorId: '99',
    // This task becomes terminal, which would otherwise reach the real db's
    // default export for unblock-notice lookups — a fake keeps it off it.
    db: { taskDependency: { findByBlocker: async () => [] } },
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
    type: ChannelType.GuildText,
    guild: { id: 'g1' },
    send: async () => {},
    permissionOverwrites: { edit: async () => {}, delete: async () => {} },
  }
  const h = harness({ channel })
  const task = { id: h.taskId, title: 'T', status: 'closed', assigneeIds: ['11'], discordChannelId: 'own' }
  const out = await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { status: 'done' }, actorId: '99', db: noQueryDb,
  })
  assert.deepEqual(out.dmed, [])
})

test('the meeting review channel is never treated as the task channel', async () => {
  const posts = []
  const grants = []
  const reviewChannel = {
    id: 'review',
    name: 'pipeline-test',
    type: ChannelType.GuildText,
    guild: { id: 'g1' },
    send: async (m) => posts.push(m),
    permissionOverwrites: { edit: async (id) => grants.push(id), delete: async () => {} },
  }
  const h = harness({ channel: reviewChannel })
  const task = { id: h.taskId, title: 'T', status: 'open', assigneeIds: [], discordChannelId: 'review' }
  const out = await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { assigneeIds: ['11'] }, actorId: '99', db: noQueryDb,
  })
  // A fresh channel is made instead; the shared review channel is untouched.
  assert.equal(out.created, true)
  assert.equal(out.channelId, 'newchan')
  assert.equal(posts.length, 0)
  assert.equal(grants.length, 0)
})

test('a task whose channel was renamed out of recognition is reused, never duplicated', async () => {
  const posts = []
  const grants = []
  // /project-setup renamed this one into its project's section. Its name no
  // longer carries the task id; only the row does.
  const renamed = {
    id: 'own',
    name: 'feature-add-booking-rules',
    topic: 'Feature: Add booking rules',
    type: ChannelType.GuildText,
    guild: { id: 'g1' },
    send: async (m) => posts.push(m),
    permissionOverwrites: { edit: async (id) => grants.push(id), delete: async () => {} },
  }
  const h = harness({ channel: renamed })
  const task = { id: h.taskId, title: 'Add booking rules', status: 'open', assigneeIds: [], discordChannelId: 'own' }
  const out = await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { assigneeIds: ['11'] }, actorId: '99', db: noQueryDb,
  })
  assert.equal(out.created, false, 'a second channel beside the first is the bug')
  assert.equal(out.channelId, 'own')
  assert.equal(h.created.length, 0)
  assert.deepEqual(grants, ['11'])
  assert.equal(posts.length, 1)
})

test('a bug task with no channel gets a bug channel that points at /resolve-bug', async () => {
  const h = harness()
  const task = { id: h.taskId, title: 'Login crashes', type: 'bug', status: 'open', assigneeIds: [], discordChannelId: null }
  await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { assigneeIds: ['11'] }, actorId: '99', db: noQueryDb,
  })
  // A unified task table really does carry type='bug' rows, so a bug gets the
  // Bugs category, the `bug-` prefix and the red embed — not a feature's.
  assert.equal(h.created[0].name, 'Bugs')
  assert.equal(h.created[1].name, 'bug-123456')
  const embed = h.sends[0].embeds[0].toJSON()
  assert.match(embed.title, /^Bug: Login crashes/)
  assert.equal(embed.color, 0xed4245)
  // /close-feature will not take a bug row; the channel must not tell its
  // assignee to use it.
  const close = embed.fields.find((f) => f.name === 'Close')
  assert.match(close.value, /\/resolve-bug/)
})

test('an unassigned task with no channel notifies nobody and creates nothing', async () => {
  const h = harness()
  const task = { id: h.taskId, title: 'T', status: 'open', assigneeIds: [], discordChannelId: null }
  const out = await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { status: 'in_progress' }, actorId: '99', db: noQueryDb,
  })
  assert.equal(out.created, false)
  assert.equal(out.channelId, null)
  assert.deepEqual(out.dmed, [])
  assert.equal(h.created.length, 0)
})

// --- unblockNotices ---------------------------------------------------------

test('unblockNotices: one notice per task the blocker was holding, counting what remains open', async () => {
  const blocker = { id: 'C', title: 'Error handling', status: 'done' }
  const tasks = {
    A: { id: 'A', title: 'Git Sync', status: 'open', discordChannelId: 'chA' },
    B: { id: 'B', title: 'Router', status: 'open', discordChannelId: null },
    D: { id: 'D', title: 'Other blocker', status: 'in_progress' },
    C: blocker,
  }
  const deps = [
    { taskId: 'A', blockedByTaskId: 'C' }, { taskId: 'A', blockedByTaskId: 'D' },
    { taskId: 'B', blockedByTaskId: 'C' },
  ]
  const db = {
    taskDependency: {
      findByBlocker: async ({ where }) => deps.filter((d) => d.blockedByTaskId === where.blockedByTaskId),
      findByTask: async ({ where }) => deps.filter((d) => d.taskId === where.taskId),
    },
    task: { findByIds: async ({ where }) => where.ids.map((i) => tasks[i]).filter(Boolean) },
  }
  const out = await unblockNotices({ db, guildConfigId: 'g1', blockerTask: blocker })
  assert.deepEqual(out, [
    { channelId: 'chA', text: '✅ Blocker **Error handling** is done. 1 blocker still open.' },
  ])
})

// --- warning line + unblock notices wired into notifyTaskUpdate ------------

test('a status-change warning is appended as the last line of the channel post', async () => {
  const posts = []
  const channel = {
    id: 'own',
    name: 'feature-123456',
    type: ChannelType.GuildText,
    guild: { id: 'g1' },
    send: async (m) => posts.push(m),
    permissionOverwrites: { edit: async () => {}, delete: async () => {} },
  }
  const h = harness({ channel })
  const task = { id: h.taskId, title: 'T', status: 'open', assigneeIds: ['11'], discordChannelId: 'own' }
  await notifyTaskUpdate({
    client: h.client,
    guild: h.guild,
    task,
    before: task,
    updates: { passedQaTests: 3 },
    actorId: '99',
    warning: '⛔ Still blocked by: **Router** (open)',
    db: noQueryDb,
  })
  assert.equal(posts.length, 1)
  const lines = posts[0].split('\n')
  assert.equal(lines[lines.length - 1], '• ⛔ Still blocked by: **Router** (open)')
})

test('moving a task to done posts an unblock notice into each dependent task channel', async () => {
  const notices = []
  const channels = {
    chA: { id: 'chA', isTextBased: () => true, send: async (m) => notices.push(m) },
  }
  const client = {
    channels: { fetch: async (id) => channels[id] || null },
    users: { fetch: async (id) => ({ send: async () => {} }) },
  }
  const guild = { id: 'g1' }
  // No assignees and no channel of its own, so only the unblock-notice path
  // under test runs.
  const task = {
    id: 'taskC',
    title: 'Error handling',
    status: 'in_progress',
    assigneeIds: [],
    discordChannelId: null,
    guildConfigId: 'g1cfg',
  }
  const db = {
    taskDependency: {
      findByBlocker: async ({ where }) =>
        where.blockedByTaskId === 'taskC' ? [{ taskId: 'A', blockedByTaskId: 'taskC' }] : [],
      findByTask: async ({ where }) =>
        where.taskId === 'A' ? [{ taskId: 'A', blockedByTaskId: 'taskC' }] : [],
    },
    task: {
      findByIds: async ({ where }) =>
        where.ids.includes('A') ? [{ id: 'A', title: 'Git Sync', status: 'open', discordChannelId: 'chA' }] : [],
    },
  }
  await notifyTaskUpdate({
    client,
    guild,
    task,
    before: task,
    updates: { status: 'done' },
    actorId: '99',
    db,
  })
  assert.deepEqual(notices, ['✅ Blocker **Error handling** is done. This task is no longer blocked.'])
})

test('a task with no guildConfigId skips the unblock-notice lookup entirely, without throwing', async () => {
  const originalWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args)
  try {
    let dbTouched = false
    const db = {
      taskDependency: {
        findByBlocker: async () => {
          dbTouched = true
          return []
        },
      },
    }
    const client = {
      channels: { fetch: async () => null },
      users: { fetch: async () => ({ send: async () => {} }) },
    }
    const guild = { id: 'g1' }
    const task = { id: 'taskD', title: 'X', status: 'in_progress', assigneeIds: [], discordChannelId: null }
    await assert.doesNotReject(
      notifyTaskUpdate({ client, guild, task, before: task, updates: { status: 'closed' }, actorId: '99', db }),
    )
    assert.equal(dbTouched, false)
  } finally {
    console.warn = originalWarn
  }
})

// --- actorLabel: who the post says made the change --------------------------

/** One post into a task's own channel; returns the text that was sent. */
async function postWith({ actorId = null, actorLabel = null } = {}) {
  const posts = []
  const channel = {
    id: 'own',
    name: 'feature-123456',
    type: ChannelType.GuildText,
    guild: { id: 'g1' },
    send: async (m) => posts.push(m),
    permissionOverwrites: { edit: async () => {}, delete: async () => {} },
  }
  const h = harness({ channel })
  const task = { id: h.taskId, title: 'T', status: 'open', assigneeIds: ['11'], discordChannelId: 'own' }
  await notifyTaskUpdate({
    client: h.client,
    guild: h.guild,
    task,
    before: task,
    updates: { status: 'in_progress' },
    actorId,
    actorLabel,
    db: noQueryDb,
  })
  assert.equal(posts.length, 1)
  return posts[0]
}

test('actorLabel names the person when there is no Discord id to mention', async () => {
  const text = await postWith({ actorId: null, actorLabel: 'Afaq (via the site)' })
  assert.ok(text.startsWith('Afaq (via the site) updated this task'), text)
})

test('with neither an actor id nor a label the post falls back to "Someone"', async () => {
  const text = await postWith()
  assert.ok(text.startsWith('Someone updated this task'), text)
})

// --- another task's title never reaches a client's request channel ----------

test('a request channel never carries the blocker warning — another task\'s title is not the client\'s to read', async () => {
  const posts = []
  const channel = {
    id: 'own',
    name: 'feature-123456',
    type: ChannelType.GuildText,
    guild: { id: 'g1' },
    send: async (m) => posts.push(m),
    permissionOverwrites: { edit: async () => {}, delete: async () => {} },
  }
  const h = harness({ channel })
  const task = { id: h.taskId, title: 'T', status: 'open', assigneeIds: ['11'], discordChannelId: 'own', requestedBy: 'u-c' }
  await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { passedQaTests: 3 }, actorId: '99',
    warning: '⛔ Still blocked by: **Router** (open)',
    db: noQueryDb,
  })
  assert.equal(posts.length, 1)
  assert.ok(!posts[0].includes('Router'), 'the blocking task\'s title stays out of the request channel')
  assert.match(posts[0], /QA tests passed/, 'the change itself is still posted')
})

test('unblockNotices skips a blocked task that is a client request — the blocker\'s title would leak into it', async () => {
  const blocker = { id: 'C', title: 'Error handling', status: 'done' }
  const tasks = {
    A: { id: 'A', title: 'Git Sync', status: 'open', discordChannelId: 'chA' },
    R: { id: 'R', title: 'Login fails', status: 'open', discordChannelId: 'chR', requestedBy: 'u-c' },
    C: blocker,
  }
  const deps = [
    { taskId: 'A', blockedByTaskId: 'C' },
    { taskId: 'R', blockedByTaskId: 'C' },
  ]
  const db = {
    taskDependency: {
      findByBlocker: async ({ where }) => deps.filter((d) => d.blockedByTaskId === where.blockedByTaskId),
      findByTask: async ({ where }) => deps.filter((d) => d.taskId === where.taskId),
    },
    task: { findByIds: async ({ where }) => where.ids.map((i) => tasks[i]).filter(Boolean) },
  }
  const out = await unblockNotices({ db, guildConfigId: 'g1', blockerTask: blocker })
  assert.deepEqual(out, [
    { channelId: 'chA', text: '✅ Blocker **Error handling** is done. This task is no longer blocked.' },
  ])
})
