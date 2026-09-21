import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertCanFinish, syncParent, createSubtask } from './taskHierarchy.js'
import { applyTaskUpdate } from './taskStatusChange.js'
import { notifyTaskUpdate } from './taskUpdateNotify.js'
import { TaskRuleError } from '../utils/taskHierarchy.js'
import { taskInsertSql } from '../Database/index.js'

/** An in-memory task table: updates and creates really change what later reads return. */
function fakeDb(seed) {
  const tasks = seed.map((t) => ({ guildConfigId: 'g1', ...t }))
  const calls = []
  const activity = []
  let n = 0
  return {
    tasks, calls, activity,
    task: {
      findFirst: async ({ where }) => { const t = tasks.find((x) => x.id === where.id); return t ? { ...t } : null },
      findChildren: async ({ where }) => tasks.filter((t) => t.parentTaskId === where.parentTaskId).map((t) => ({ ...t })),
      findByIds: async ({ where }) => tasks.filter((t) => where.ids.includes(t.id)).map((t) => ({ ...t })),
      update: async ({ where, data }) => { calls.push(['update', where.id, data]); Object.assign(tasks.find((t) => t.id === where.id), data); return null },
      create: async ({ data }) => { const row = { id: `new${++n}`, ...data }; tasks.push(row); calls.push(['create', row.id]); return { ...row } },
    },
    taskActivity: { add: async ({ data }) => { activity.push(data) } },
    taskDependency: { findByTask: async () => [] },
    guildConfig: { findById: async () => ({ id: 'g1', guildId: 'guild1' }) },
  }
}

const P = { id: 'P', title: 'Parent', status: 'in_progress', projectId: 'p1', projectName: 'Framework', repositoryId: 'r1', discordChannelId: 'ch1' }
const A = { id: 'A', title: 'Sub A', status: 'open', parentTaskId: 'P' }
const B = { id: 'B', title: 'Sub B', status: 'open', parentTaskId: 'P' }
const seed = (over = {}) => [{ ...P, ...(over.P || {}) }, { ...A, ...(over.A || {}) }, { ...B, ...(over.B || {}) }]

const client = { guilds: { cache: new Map([['guild1', { id: 'guild1', name: 'G' }]]) } }
const notifications = []
const notify = async (a) => { notifications.push(a); return { channelId: null, created: false, dmed: [] } }
const setTask = (db, id) => ({ ...db.tasks.find((t) => t.id === id) })
const apply = (db, id, updates, actor = { discordId: 'u1' }) =>
  applyTaskUpdate({ db, client, task: setTask(db, id), updates, actor, notify })

// -------------------------------------------------------------- the rule ----

test('assertCanFinish refuses a finishing move while a subtask is open, and passes everything else', async () => {
  const db = fakeDb(seed())
  const task = setTask(db, 'P')
  await assert.rejects(assertCanFinish({ db, task, updates: { status: 'done' } }), (e) => e instanceof TaskRuleError && /Sub A/.test(e.message))
  await assertCanFinish({ db, task, updates: { status: 'in_progress' } })
  await assertCanFinish({ db, task, updates: { title: 'x' } })
  await assertCanFinish({ db, task: { ...task, status: 'done' }, updates: { status: 'closed' } }) // already finished
})

test('assertCanFinish does not even read the subtasks unless a finishing move is made', async () => {
  const db = fakeDb(seed())
  let reads = 0
  db.task.findChildren = async () => { reads += 1; return [] }
  await assertCanFinish({ db, task: setTask(db, 'P'), updates: { status: 'in_progress' } })
  await assertCanFinish({ db, task: setTask(db, 'P'), updates: { scope: 'qa' } })
  assert.equal(reads, 0)
})

test('applyTaskUpdate refuses to finish a parent with an open subtask and writes nothing', async () => {
  const db = fakeDb(seed({ A: { status: 'done' } }))
  await assert.rejects(apply(db, 'P', { status: 'done' }), (e) => e instanceof TaskRuleError && /Sub B/.test(e.message))
  assert.deepEqual(db.calls, [])
  assert.deepEqual(db.activity, [])
  assert.equal(setTask(db, 'P').status, 'in_progress')
})

test('a parent can be finished once every subtask is finished', async () => {
  const db = fakeDb(seed({ A: { status: 'done' }, B: { status: 'closed' } }))
  await apply(db, 'P', { status: 'done' })
  assert.equal(setTask(db, 'P').status, 'done')
})

// ------------------------------------------------------- automatic parent ----

test('finishing the last open subtask completes the parent automatically, and says why', async () => {
  const db = fakeDb(seed({ A: { status: 'done' } }))
  notifications.length = 0
  await apply(db, 'B', { status: 'done' })
  assert.equal(setTask(db, 'P').status, 'done')
  const parentUpdate = db.calls.find((c) => c[0] === 'update' && c[1] === 'P')
  assert.deepEqual(parentUpdate[2], { status: 'done' })
  const parentNotice = notifications.find((n) => n.task.id === 'P')
  assert.equal(parentNotice.actorLabel, 'Automatic (all subtasks done)')
  const parentActivity = db.activity.find((a) => a.taskId === 'P')
  assert.equal(parentActivity.actorLabel, 'Automatic (all subtasks done)')
  assert.deepEqual(parentActivity.changes, [{ field: 'status', from: 'in_progress', to: 'done' }])
})

test('finishing a subtask while another is open leaves the parent alone', async () => {
  const db = fakeDb(seed())
  await apply(db, 'A', { status: 'done' })
  assert.equal(setTask(db, 'P').status, 'in_progress')
  assert.deepEqual(db.calls.map((c) => c[1]), ['A'])
})

test('reopening a subtask under a finished parent puts the parent back in progress', async () => {
  const db = fakeDb(seed({ P: { status: 'done' }, A: { status: 'done' }, B: { status: 'done' } }))
  await apply(db, 'B', { status: 'open' })
  assert.equal(setTask(db, 'P').status, 'in_progress')
  assert.equal(db.activity.find((a) => a.taskId === 'P').actorLabel, 'Automatic (a subtask is open again)')
})

test('a change to a subtask that is not a status change never touches the parent', async () => {
  const db = fakeDb(seed({ A: { status: 'done' }, B: { status: 'done' }, P: { status: 'in_progress' } }))
  await apply(db, 'B', { title: 'Renamed' })
  assert.deepEqual(db.calls.map((c) => c[1]), ['B'])
})

test('a task with no parent is unaffected, and a missing parent row is ignored', async () => {
  const db = fakeDb([{ id: 'X', title: 'Solo', status: 'open' }, { id: 'Y', title: 'Orphan', status: 'open', parentTaskId: 'gone' }])
  await apply(db, 'X', { status: 'done' })
  await apply(db, 'Y', { status: 'done' })
  assert.deepEqual(db.calls.map((c) => c[1]), ['X', 'Y'])
})

test('syncParent never throws: a failing parent update is logged and reported as unchanged', async () => {
  const db = fakeDb(seed({ A: { status: 'done' }, B: { status: 'done' } }))
  const orig = console.error; console.error = () => {}
  try {
    const out = await syncParent({ db, client, parentId: 'P', notify, apply: async () => { throw new Error('boom') } })
    assert.equal(out, null)
  } finally { console.error = orig }
  assert.equal(await syncParent({ db, client, parentId: null, notify, apply }), null)
})

// ------------------------------------------------------- creating subtasks ----

const fields = { title: '  Write tests  ', description: 'Cover the rules', scope: 'qa', assigneeIds: ['u2', 'u2', 'u3'] }

test('createSubtask makes a channel-less child of the parent that inherits its project, and records it', async () => {
  const db = fakeDb(seed())
  notifications.length = 0
  const child = await createSubtask({ db, client, parent: setTask(db, 'P'), fields, actor: { discordId: 'u1' }, notify, apply: (a) => applyTaskUpdate({ ...a }) })
  const row = db.tasks.find((t) => t.id === child.id)
  assert.equal(row.parentTaskId, 'P')
  assert.equal(row.title, 'Write tests')
  assert.equal(row.type, 'feature')
  assert.equal(row.status, 'open')
  assert.deepEqual(row.assigneeIds, ['u2', 'u3'])
  assert.equal(row.projectId, 'p1')
  assert.equal(row.projectName, 'Framework')
  assert.equal(row.repositoryId, 'r1')
  assert.equal(row.scope, 'qa')
  assert.equal(row.createdBy, 'u1')
  assert.equal(row.discordChannelId, undefined)
  assert.deepEqual(db.activity.find((a) => a.taskId === 'P').changes, [{ field: 'subtask', action: 'added', title: 'Write tests' }])
  const told = notifications.find((n) => n.task.id === child.id)
  assert.deepEqual(told.extraLines, ['**subtask added**'])
  assert.deepEqual(told.updates, { assigneeIds: ['u2', 'u3'] })
})

test('adding a subtask under a finished parent reopens it', async () => {
  const db = fakeDb(seed({ P: { status: 'done' }, A: { status: 'done' }, B: { status: 'done' } }))
  await createSubtask({ db, client, parent: setTask(db, 'P'), fields, actor: { discordId: 'u1' }, notify, apply: (a) => applyTaskUpdate(a) })
  assert.equal(setTask(db, 'P').status, 'in_progress')
})

test('createSubtask refuses a subtask as parent, a blank title and a full parent', async () => {
  const db = fakeDb(seed())
  const base = { db, client, actor: { discordId: 'u1' }, notify, apply }
  await assert.rejects(createSubtask({ ...base, parent: setTask(db, 'A'), fields }), /cannot have subtasks of its own/)
  await assert.rejects(createSubtask({ ...base, parent: setTask(db, 'P'), fields: { ...fields, title: '   ' } }), /needs a title/)
  for (let i = 0; i < 23; i++) db.tasks.push({ id: `k${i}`, title: `K${i}`, status: 'open', parentTaskId: 'P', guildConfigId: 'g1' })
  await assert.rejects(createSubtask({ ...base, parent: setTask(db, 'P'), fields }), /at most 25 subtasks/)
  assert.equal(db.calls.filter((c) => c[0] === 'create').length, 0)
})

test('a failing notification does not undo the subtask', async () => {
  const db = fakeDb(seed())
  const orig = console.error; console.error = () => {}
  try {
    const child = await createSubtask({ db, client, parent: setTask(db, 'P'), fields, actor: { discordId: 'u1' }, notify: async () => { throw new Error('discord down') }, apply })
    assert.ok(db.tasks.some((t) => t.id === child.id))
  } finally { console.error = orig }
})

// --------------------------------------------- notifications for subtasks ----

function fakeChannel() {
  const sent = []
  const overwrites = []
  return {
    id: 'ch1', type: 0, name: 'feature-parent', topic: 'Feature: Parent — Task P', guild: { id: 'guild1' },
    sent, overwrites,
    send: async (t) => { sent.push(t) },
    permissionOverwrites: { edit: async (...a) => { overwrites.push(['edit', ...a]) }, delete: async (...a) => { overwrites.push(['delete', ...a]) } },
  }
}

test('a subtask is announced in its parent\'s channel and gets no channel or permission changes of its own', async () => {
  const db = fakeDb(seed())
  const channel = fakeChannel()
  const bot = { channels: { fetch: async (id) => (id === 'ch1' ? channel : null) }, users: { fetch: async () => ({ send: async () => {} }) } }
  const child = { id: 'A', title: 'Sub A', status: 'open', parentTaskId: 'P', guildConfigId: 'g1' }
  const out = await notifyTaskUpdate({
    client: bot, guild: { id: 'guild1' }, task: child, before: { ...child, assigneeIds: [] }, updates: { assigneeIds: ['u9'] },
    actorId: 'u1', extraLines: ['**subtask added**'], db,
  })
  assert.equal(out.created, false)
  assert.equal(out.channelId, 'ch1')
  assert.equal(channel.overwrites.length, 0)
  assert.equal(channel.sent.length, 1)
  assert.match(channel.sent[0], /updated subtask \*\*Sub A\*\*/)
  assert.match(channel.sent[0], /subtask added/)
  assert.match(channel.sent[0], /assigned to\*\* <@u9>/)
})

test('a subtask whose parent has no channel is not given one', async () => {
  const db = fakeDb(seed({ P: { discordChannelId: null } }))
  const child = { id: 'A', title: 'Sub A', status: 'open', parentTaskId: 'P', guildConfigId: 'g1' }
  const out = await notifyTaskUpdate({
    client: { channels: { fetch: async () => null }, users: { fetch: async () => ({ send: async () => {} }) } },
    guild: { id: 'guild1' }, task: child, before: { ...child, assigneeIds: [] }, updates: { assigneeIds: ['u9'] }, actorId: 'u1', db,
  })
  assert.equal(out.created, false)
  assert.equal(out.channelId, null)
})

// ------------------------------------------------------------- the insert ----

test('task insert: placeholders equal params, parentTaskId is the last column and defaults to null', () => {
  const { sql, params } = taskInsertSql({ guildConfigId: 'g1', title: 'T' }, 'pk1')
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.equal((sql.match(/\?/g) || []).length, params.length)
  assert.equal(cols.length, params.length)
  assert.deepEqual(cols.slice(0, 3), ['id', 'guildConfigId', 'type'])
  assert.equal(cols[cols.length - 1], 'parentTaskId')
  assert.equal(params[0], 'pk1')
  assert.equal(params[params.length - 1], null)
  assert.equal(taskInsertSql({ guildConfigId: 'g1', parentTaskId: 'P' }, 'pk2').params.at(-1), 'P')
})

test('task insert: a bug defaults to pending and a feature to open, json columns are text', () => {
  const bug = taskInsertSql({ guildConfigId: 'g', is_bug: 1 }, 'a')
  const feature = taskInsertSql({ guildConfigId: 'g' }, 'b')
  const col = (r, name) => r.params[r.sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim()).indexOf(name)]
  assert.equal(col(bug, 'status'), 'pending')
  assert.equal(col(feature, 'status'), 'open')
  assert.equal(col(feature, 'type'), 'feature')
  assert.equal(col(feature, 'assigneeIds'), '[]')
})
