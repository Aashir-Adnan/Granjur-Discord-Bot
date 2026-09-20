import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CommandInteractionOptionResolver, ApplicationCommandOptionType as T } from 'discord.js'
import { projectChoices, NO_PROJECT, nextAssignees, applyDependencyChange, canSeeTask, execute, autocomplete } from './update-task.js'

const projects = [
  { id: 'p-fw', name: 'Framework' },
  { id: 'p-hms', name: 'Badar HMS' },
  { id: 'p-cs', name: 'CSAAS' },
]

test('"No project" is first and detaching carries the sentinel value', () => {
  const out = projectChoices(projects, '')
  assert.equal(out[0].value, NO_PROJECT)
  assert.match(out[0].name, /^No project/)
})

test('projects are listed by name, not database order', () => {
  const out = projectChoices(projects, '')
  assert.deepEqual(out.slice(1).map((c) => c.name), ['Badar HMS', 'CSAAS', 'Framework'])
})

test('typing filters case-insensitively and keeps the detach entry', () => {
  const out = projectChoices(projects, 'hms')
  assert.deepEqual(out.map((c) => c.value), [NO_PROJECT, 'p-hms'])
})

test('never more than 25 choices, and names never exceed 100 characters', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, name: `Project ${'n'.repeat(120)} ${i}` }))
  const out = projectChoices(many, '')
  assert.ok(out.length <= 25)
  for (const c of out) assert.ok(c.name.length <= 100)
})

test('nextAssignees: replace wins, then add and remove apply, no duplicates', () => {
  assert.deepEqual(nextAssignees(['1', '2'], { add: '3' }), ['1', '2', '3'])
  assert.deepEqual(nextAssignees(['1', '2'], { remove: '1' }), ['2'])
  assert.deepEqual(nextAssignees(['1', '2'], { add: '2' }), ['1', '2'])
  assert.deepEqual(nextAssignees(['1', '2'], { remove: '9' }), ['1', '2'])
  assert.deepEqual(nextAssignees(['1'], { replace: ['5', '6'], add: '7', remove: '5' }), ['6', '7'])
  assert.equal(nextAssignees(['1'], {}), null) // nothing asked → no update
})

function fakeDb({ tasks = [], deps = [], removed = 1 } = {}) {
  const calls = []
  const activity = []
  return {
    calls,
    activity,
    taskActivity: { add: async ({ data }) => { activity.push(data) } },
    task: {
      findByIds: async ({ where }) => tasks.filter((t) => where.ids.includes(t.id)),
      findFirst: async ({ where }) => tasks.find((t) => t.id === where.id) ?? null,
      findMany: async () => tasks,
      update: async (args) => { calls.push(['update', args]); return args.data },
    },
    project: { findFirst: async () => null, findMany: async () => [] },
    taskDependency: {
      findManyForGuild: async () => deps,
      findByTask: async ({ where }) => deps.filter((d) => d.taskId === where.taskId),
      add: async ({ data }) => { calls.push(['add', data]); return data },
      remove: async ({ where }) => { calls.push(['remove', where]); return { removed } },
    },
  }
}

/**
 * Fake slash interaction: option values come from `opts`; replies are recorded.
 * Defaults to an Administrator caller, so every test written before the
 * ownership gate existed keeps its original meaning unchanged. Tests OF the
 * gate pass their own `member`.
 */
function fakeInteraction(opts = {}, { focused = null, userId = 'u1', member = adminMember() } = {}) {
  const replies = []
  const get = (name) => (Object.prototype.hasOwnProperty.call(opts, name) ? opts[name] : null)
  return {
    replies,
    guild: { id: 'guild1', members: { cache: new Map() } },
    user: { id: userId },
    member,
    client: {},
    options: {
      getString: get,
      getInteger: get,
      get: (name) => (get(name) ? { value: get(name) } : null),
      getUser: (name) => (get(name) ? { id: get(name) } : null),
      getFocused: () => focused,
    },
    editReply: async (payload) => { replies.push(payload); return payload },
    respond: async (choices) => { replies.push(choices); return choices },
  }
}

function adminMember() {
  return { permissions: { has: (p) => p === 'Administrator' } }
}

function plainMember() {
  return { permissions: { has: () => false }, roles: { cache: { some: () => false } } }
}

function fakeNotify() {
  const seen = []
  const fn = async (args) => { seen.push(args); return { channelId: null, created: false, dmed: [] } }
  fn.seen = seen
  return fn
}

const getConfig = async () => ({ id: 'g1' })
const embedOf = (payload) => payload.embeds[0].toJSON()
const embedText = (payload) => {
  const e = embedOf(payload)
  return [e.description, ...(e.fields || []).map((f) => f.value)].join('\n')
}
const kinds = (db) => db.calls.map(([k]) => k)

test('applyDependencyChange refuses self-block and cycles, never writing', async () => {
  const cfg = { id: 'g1' }
  const task = { id: 'A', title: 'Git Sync', status: 'open' }
  const db = fakeDb({ tasks: [task, { id: 'B', title: 'Router fix', status: 'open' }], deps: [{ taskId: 'B', blockedByTaskId: 'A' }] })
  const self = await applyDependencyChange({ db, cfg, task, blockedById: 'A' })
  assert.match(self.error, /itself/)
  const cyc = await applyDependencyChange({ db, cfg, task, blockedById: 'B' })
  assert.equal(cyc.error, '**Router fix** already depends on **Git Sync**, so **Git Sync** cannot be blocked by **Router fix**.')
  assert.equal(db.calls.length, 0)
})

test('applyDependencyChange refuses an unknown blocker', async () => {
  const db = fakeDb({ tasks: [{ id: 'A', title: 'Git Sync', status: 'open' }] })
  const out = await applyDependencyChange({ db, cfg: { id: 'g1' }, task: { id: 'A', title: 'Git Sync' }, blockedById: 'nope' })
  assert.match(out.error, /No task matches/)
})

test('applyDependencyChange writes a blocker and an unblock, reporting both', async () => {
  const task = { id: 'A', title: 'Git Sync', status: 'open' }
  const db = fakeDb({ tasks: [task, { id: 'B', title: 'Router fix', status: 'open' }, { id: 'C', title: 'Old', status: 'open' }], deps: [{ taskId: 'A', blockedByTaskId: 'C' }] })
  const out = await applyDependencyChange({ db, cfg: { id: 'g1' }, task, blockedById: 'B', unblockId: 'C', actorId: 'u1' })
  assert.equal(out.error, null)
  assert.deepEqual(db.calls[0], ['add', { guildConfigId: 'g1', taskId: 'A', blockedByTaskId: 'B', createdBy: 'u1' }])
  assert.deepEqual(db.calls[1], ['remove', { taskId: 'A', blockedByTaskId: 'C' }])
  assert.deepEqual(out.lines, ['**Blocked by:** Router fix', '**Unblocked:** Old'])
})

test('projectChoices can omit the detach entry', () => {
  const out = projectChoices(projects, '', { withDetach: false })
  assert.ok(out.every((c) => c.value !== NO_PROJECT))
  assert.equal(out.length, 3)
})

test('applyDependencyChange says so when unblock names a task that was not blocking', async () => {
  const task = { id: 'A', title: 'Git Sync', status: 'open' }
  const db = fakeDb({ tasks: [task, { id: 'C', title: 'Old', status: 'open' }], removed: 0 })
  const out = await applyDependencyChange({ db, cfg: { id: 'g1' }, task, unblockId: 'C' })
  assert.deepEqual(out.lines, ['**Unblock:** Old was not blocking this task'])
})

const A = { id: 'A', title: 'Git Sync', status: 'open', assigneeIds: ['1'] }
const B = { id: 'B', title: 'Router fix', status: 'open' }

test('execute: only blocked_by records the blocker without updating or notifying', async () => {
  const db = fakeDb({ tasks: [A, B] })
  const notify = fakeNotify()
  const it = fakeInteraction({ task: 'A', blocked_by: 'B' })
  await execute(it, { db, notify, getConfig })
  assert.deepEqual(kinds(db), ['add'])
  assert.equal(notify.seen.length, 0)
  assert.match(embedText(it.replies[0]), /\*\*Blocked by:\*\* Router fix/)
})

test('execute: a cycle is refused with nothing written', async () => {
  const db = fakeDb({ tasks: [A, B], deps: [{ taskId: 'B', blockedByTaskId: 'A' }] })
  const notify = fakeNotify()
  const it = fakeInteraction({ task: 'A', blocked_by: 'B', status: 'in_progress' })
  await execute(it, { db, notify, getConfig })
  assert.equal(it.replies[0].content, '**Router fix** already depends on **Git Sync**, so **Git Sync** cannot be blocked by **Router fix**.')
  assert.deepEqual(kinds(db), [])
  assert.equal(notify.seen.length, 0)
})

test('execute: moving a blocked task to in progress warns in notify and the reply', async () => {
  const db = fakeDb({ tasks: [A, B], deps: [{ taskId: 'A', blockedByTaskId: 'B' }] })
  const notify = fakeNotify()
  const it = fakeInteraction({ task: 'A', status: 'in_progress' })
  await execute(it, { db, notify, getConfig })
  assert.deepEqual(kinds(db), ['update'])
  assert.match(notify.seen[0].warning, /Still blocked by: \*\*Router fix\*\*/)
  assert.equal(notify.seen[0].db, db)
  assert.match(embedOf(it.replies[0]).description, /^\*\*Git Sync\*\*\n.*Still blocked by/)
})

test('execute: an unchanged status carries no warning', async () => {
  const task = { ...A, status: 'in_progress' }
  const db = fakeDb({ tasks: [task, B], deps: [{ taskId: 'A', blockedByTaskId: 'B' }] })
  const notify = fakeNotify()
  await execute(fakeInteraction({ task: 'A', status: 'in_progress' }), { db, notify, getConfig })
  assert.equal(notify.seen[0].warning, '')
})

test('execute: a failing warning lookup does not fail the update', async () => {
  const db = fakeDb({ tasks: [A, B] })
  db.taskDependency.findByTask = async () => { throw new Error('boom') }
  const notify = fakeNotify()
  const it = fakeInteraction({ task: 'A', status: 'done' })
  const origError = console.error
  console.error = () => {}
  try {
    await execute(it, { db, notify, getConfig })
  } finally {
    console.error = origError
  }
  assert.equal(notify.seen[0].warning, '')
  assert.ok(it.replies[0].embeds, 'replied with an embed, not "Update failed"')
})

test('execute: a very long warning is cut to 1500 characters', async () => {
  const blockers = Array.from({ length: 60 }, (_, i) => ({ id: `X${i}`, title: `Blocker ${'t'.repeat(40)} ${i}`, status: 'open' }))
  const db = fakeDb({ tasks: [A, ...blockers], deps: blockers.map((b) => ({ taskId: 'A', blockedByTaskId: b.id })) })
  const notify = fakeNotify()
  await execute(fakeInteraction({ task: 'A', status: 'in_progress' }), { db, notify, getConfig })
  const w = notify.seen[0].warning
  assert.equal(w.length, 1500)
  assert.ok(w.endsWith('…'))
})

test('execute: unblock naming a non-blocker says it was not blocking', async () => {
  const db = fakeDb({ tasks: [A, B], removed: 0 })
  const notify = fakeNotify()
  const it = fakeInteraction({ task: 'A', unblock: 'B' })
  await execute(it, { db, notify, getConfig })
  assert.match(embedText(it.replies[0]), /\*\*Unblock:\*\* Router fix was not blocking this task/)
  assert.equal(notify.seen.length, 0)
})

test('execute: adding an assignee who is already on the task changes nothing', async () => {
  const db = fakeDb({ tasks: [A, B] })
  const notify = fakeNotify()
  const it = fakeInteraction({ task: 'A', add_assignee: '1' })
  await execute(it, { db, notify, getConfig })
  assert.deepEqual(kinds(db), [])
  assert.match(it.replies[0].content, /Provide at least one field/)
})

test('execute: add_assignee writes the extended list', async () => {
  const db = fakeDb({ tasks: [A, B] })
  const notify = fakeNotify()
  await execute(fakeInteraction({ task: 'A', add_assignee: '2' }), { db, notify, getConfig })
  assert.deepEqual(db.calls[0][1].data, { assigneeIds: ['1', '2'] })
})

test('execute: a Dependencies field over 1024 characters is capped with an ellipsis', async () => {
  const longTitle = 't'.repeat(1100)
  const longBlocker = { id: 'L', title: longTitle, status: 'open' }
  const db = fakeDb({ tasks: [A, longBlocker] })
  const notify = fakeNotify()
  const it = fakeInteraction({ task: 'A', blocked_by: 'L' })
  await execute(it, { db, notify, getConfig })
  const depField = embedOf(it.replies[0]).fields.find((f) => f.name === 'Dependencies')
  assert.equal(depField.value.length, 1024)
  assert.ok(depField.value.endsWith('…'))
})

test('autocomplete: unblock lists only the picked task blockers, empty when it has none', async () => {
  const C = { id: 'C', title: 'Old', status: 'open' }
  const withDep = fakeDb({ tasks: [A, B, C], deps: [{ taskId: 'A', blockedByTaskId: 'B' }] })
  const it1 = fakeInteraction({ task: 'A' }, { focused: { name: 'unblock', value: '' } })
  await autocomplete(it1, { db: withDep, getConfig })
  assert.deepEqual(it1.replies[0].map((c) => c.value), ['B'])

  const none = fakeDb({ tasks: [A, B, C] })
  const it2 = fakeInteraction({ task: 'A' }, { focused: { name: 'unblock', value: '' } })
  await autocomplete(it2, { db: none, getConfig })
  assert.deepEqual(it2.replies[0], [])

  const it3 = fakeInteraction({ task: 'typed text' }, { focused: { name: 'unblock', value: '' } })
  await autocomplete(it3, { db: none, getConfig })
  assert.equal(it3.replies[0].length, 3)
})

// ---------------------------------------------------------------------------
// B12: a task that changes project keeps its channel, and says so
// ---------------------------------------------------------------------------

test('execute: moving a task to another project says the channel has not moved', async () => {
  const db = fakeDb({ tasks: [A] })
  db.project.findFirst = async ({ where }) =>
    where.id === 'pNew' ? { id: 'pNew', name: 'Aurora', guildConfigId: 'g1' } : null
  const it = fakeInteraction({ task: 'A', project: 'pNew' })

  await execute(it, { db, notify: fakeNotify(), getConfig })

  const text = embedText(it.replies[0])
  assert.match(text, /now belongs to \*\*Aurora\*\*/)
  assert.match(text, /channel has not moved/)
  assert.match(text, /previous project's role/)
  assert.match(text, /project-setup/)
})

test('execute: detaching a task from its project says the same thing', async () => {
  const db = fakeDb({ tasks: [{ ...A, projectId: 'pOld' }] })
  const it = fakeInteraction({ task: 'A', project: 'none' })
  await execute(it, { db, notify: fakeNotify(), getConfig })
  assert.match(embedText(it.replies[0]), /now belongs to no project.*channel has not moved/s)
})

test('execute: an update that leaves the project alone says nothing about it', async () => {
  const db = fakeDb({ tasks: [{ ...A, projectId: 'pOld' }] })
  const it = fakeInteraction({ task: 'A', status: 'in_progress' })
  await execute(it, { db, notify: fakeNotify(), getConfig })
  assert.doesNotMatch(embedText(it.replies[0]), /channel has not moved/)
})

// ---------------------------------------------------------------------------
// Only CEO/Server Manager see and can update every task; everyone else only
// a task they hold. A bug task's holder is whoever is tagged, not assigned.
// ---------------------------------------------------------------------------

const HELD = { id: 'H', title: 'My feature', status: 'open', assigneeIds: ['u1'] }
const BUG_HELD = { id: 'HB', title: 'My bug', status: 'pending', is_bug: 1, taggedMemberIds: ['u1'] }
const OTHERS = { id: 'O', title: "Someone else's task", status: 'open', assigneeIds: ['u2'] }

test('canSeeTask: leadership sees everything; a normal caller only their own', () => {
  assert.equal(canSeeTask(OTHERS, { isLeadership: true, callerId: 'u1' }), true)
  assert.equal(canSeeTask(OTHERS, { isLeadership: false, callerId: 'u1' }), false)
  assert.equal(canSeeTask(HELD, { isLeadership: false, callerId: 'u1' }), true)
  assert.equal(canSeeTask(BUG_HELD, { isLeadership: false, callerId: 'u1' }), true) // tagged, not assigned
})

test('execute: a normal member can update a task they hold', async () => {
  const db = fakeDb({ tasks: [HELD] })
  const it = fakeInteraction({ task: 'H', status: 'in_progress' }, { userId: 'u1', member: plainMember() })
  await execute(it, { db, notify: fakeNotify(), getConfig })
  assert.doesNotMatch(embedText(it.replies[0]), /No task matches/)
  assert.equal(kinds(db)[0], 'update')
})

test('execute: a normal member is refused a task that is not theirs, same message as a nonexistent one', async () => {
  const db = fakeDb({ tasks: [OTHERS] })
  const it = fakeInteraction({ task: 'O', status: 'in_progress' }, { userId: 'u1', member: plainMember() })
  await execute(it, { db, notify: fakeNotify(), getConfig })
  assert.equal(it.replies[0].content, 'No task matches **O**. Start typing a title and pick one from the list.')
  assert.deepEqual(kinds(db), []) // nothing written
})

test('execute: leadership can update a task that is not theirs', async () => {
  const db = fakeDb({ tasks: [OTHERS] })
  const it = fakeInteraction({ task: 'O', status: 'in_progress' }, { userId: 'u1', member: adminMember() })
  await execute(it, { db, notify: fakeNotify(), getConfig })
  assert.doesNotMatch(embedText(it.replies[0]), /No task matches/)
  assert.equal(kinds(db)[0], 'update')
})

test('execute: scope writes the field, from the fixed choices', async () => {
  const db = fakeDb({ tasks: [A] })
  const it = fakeInteraction({ task: 'A', scope: 'qa' })
  await execute(it, { db, notify: fakeNotify(), getConfig })
  assert.equal(kinds(db)[0], 'update')
  assert.equal(db.calls[0][1].data.scope, 'qa')
})

// ---------------------------------------------------------------------------
// autocomplete: the `task` field is scoped by who is asking; blocked_by and
// unblock are never scoped — a blocker can belong to anyone.
// ---------------------------------------------------------------------------

test('autocomplete: task suggestions are narrowed to held tasks for a normal caller', async () => {
  const db = fakeDb({ tasks: [HELD, OTHERS] })
  const it = fakeInteraction({}, { focused: { name: 'task', value: '' }, userId: 'u1', member: plainMember() })
  await autocomplete(it, { db, getConfig })
  assert.deepEqual(it.replies[0].map((c) => c.value), ['H'])
})

test('autocomplete: task suggestions show everything for leadership', async () => {
  const db = fakeDb({ tasks: [HELD, OTHERS] })
  const it = fakeInteraction({}, { focused: { name: 'task', value: '' }, userId: 'u1', member: adminMember() })
  await autocomplete(it, { db, getConfig })
  assert.deepEqual(it.replies[0].map((c) => c.value).sort(), ['H', 'O'])
})

/**
 * An autocomplete interaction as Discord really sends it, built on the real
 * option resolver: a User option carries only its raw id (no `resolved`
 * block), so getUser() is null and `.get(name).value` is the only way to read
 * it. A hand-rolled fake once hid exactly that.
 */
function autocompleteInteraction(options, { userId = 'u1', member = adminMember(), members = [] } = {}) {
  const replies = []
  const cache = new Map(members.map((m) => [m.id, m]))
  return {
    replies,
    guild: { id: 'guild1', members: { cache } },
    user: { id: userId },
    member,
    options: new CommandInteractionOptionResolver({}, options, {}),
    respond: async (choices) => { replies.push(choices); return choices },
  }
}
const focusedTask = (value = '') => ({ name: 'task', type: T.String, value, focused: true })

test('autocomplete: the real resolver returns null from getUser for a filter, so it must be read by value', () => {
  const it = autocompleteInteraction([{ name: 'filter_assignee', type: T.User, value: 'u2' }, focusedTask()])
  assert.equal(it.options.getUser('filter_assignee'), null)
  assert.equal(it.options.get('filter_assignee').value, 'u2')
})

test('autocomplete: filter_assignee narrows the task list to that person, for leadership too', async () => {
  const db = fakeDb({ tasks: [HELD, OTHERS] })
  const it = autocompleteInteraction([{ name: 'filter_assignee', type: T.User, value: 'u2' }, focusedTask()])
  await autocomplete(it, { db, getConfig })
  assert.deepEqual(it.replies[0].map((c) => c.value), ['O'])
})

test('autocomplete: filter_project narrows the task list to that project', async () => {
  const db = fakeDb({ tasks: [{ ...HELD, projectId: 'p-fw' }, { ...OTHERS, projectId: 'p-hms' }] })
  const it = autocompleteInteraction([{ name: 'filter_project', type: T.String, value: 'p-hms' }, focusedTask()])
  await autocomplete(it, { db, getConfig })
  assert.deepEqual(it.replies[0].map((c) => c.value), ['O'])
})

test('autocomplete: both filters together narrow to the person within the project', async () => {
  const db = fakeDb({ tasks: [
    { ...OTHERS, id: 'O1', projectId: 'p-fw' },
    { ...OTHERS, id: 'O2', projectId: 'p-hms' },
    { ...HELD, projectId: 'p-hms' },
  ] })
  const it = autocompleteInteraction([
    { name: 'filter_assignee', type: T.User, value: 'u2' },
    { name: 'filter_project', type: T.String, value: 'p-hms' },
    focusedTask(),
  ])
  await autocomplete(it, { db, getConfig })
  assert.deepEqual(it.replies[0].map((c) => c.value), ['O2'])
})

test("autocomplete: typing a project name finds that project's tasks and the label names the project", async () => {
  const db = fakeDb({ tasks: [{ ...HELD, projectId: 'p-fw' }, { ...OTHERS, projectId: 'p-hms' }] })
  db.project.findMany = async () => projects
  const it = autocompleteInteraction([focusedTask('badar')])
  await autocomplete(it, { db, getConfig })
  assert.deepEqual(it.replies[0].map((c) => c.value), ['O'])
  assert.match(it.replies[0][0].name, /· Badar HMS ·/)
})

test('autocomplete: typing a scope finds tasks of that scope', async () => {
  const db = fakeDb({ tasks: [{ ...HELD, scope: 'qa' }, { ...OTHERS, scope: 'backend' }, { id: 'X', title: 'No scope', status: 'open' }] })
  const it = autocompleteInteraction([focusedTask('back')])
  await autocomplete(it, { db, getConfig })
  assert.deepEqual(it.replies[0].map((c) => c.value), ['O'])
})

test('autocomplete: still lists tasks (without project names) when the project lookup fails', async () => {
  const db = fakeDb({ tasks: [HELD] })
  db.project.findMany = async () => { throw new Error('boom') }
  const it = autocompleteInteraction([focusedTask()])
  await autocomplete(it, { db, getConfig })
  assert.deepEqual(it.replies[0].map((c) => c.value), ['H'])
})

test('autocomplete: filter_project suggests project names, with no detach entry', async () => {
  const db = fakeDb({ tasks: [] })
  db.project.findMany = async () => projects
  const it = fakeInteraction({}, { focused: { name: 'filter_project', value: 'hms' } })
  await autocomplete(it, { db, getConfig })
  assert.deepEqual(it.replies[0].map((c) => c.value), ['p-hms'])
})

test('autocomplete: blocked_by and unblock are never narrowed by ownership — a blocker can belong to anyone', async () => {
  const db = fakeDb({ tasks: [HELD, OTHERS] })
  const it = fakeInteraction(
    { task: 'H' },
    { focused: { name: 'blocked_by', value: '' }, userId: 'u1', member: plainMember() }
  )
  await autocomplete(it, { db, getConfig })
  assert.deepEqual(it.replies[0].map((c) => c.value).sort(), ['H', 'O'])
})

test('adding and removing a blocker is written to the activity log with who did it', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'Git Sync', status: 'open' }
  const db = fakeDb({ tasks: [task, { id: 'B', title: 'Router fix', status: 'open' }, { id: 'C', title: 'Old', status: 'open' }], deps: [{ taskId: 'A', blockedByTaskId: 'C' }] })
  await applyDependencyChange({ db, cfg: { id: 'g1' }, task, blockedById: 'B', unblockId: 'C', actorId: 'u1' })
  assert.deepEqual(db.activity.map((a) => [a.actorDiscordId, a.changes]), [
    ['u1', [{ field: 'blocked_by', action: 'added', title: 'Router fix' }]],
    ['u1', [{ field: 'blocked_by', action: 'removed', title: 'Old' }]],
  ])
})

test('a refused blocker and an unblock of a task that was not blocking write no activity', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'Git Sync', status: 'open' }
  const db = fakeDb({ tasks: [task, { id: 'C', title: 'Old', status: 'open' }], removed: 0 })
  await applyDependencyChange({ db, cfg: { id: 'g1' }, task, blockedById: 'A', actorId: 'u1' })
  await applyDependencyChange({ db, cfg: { id: 'g1' }, task, unblockId: 'C', actorId: 'u1' })
  assert.deepEqual(db.activity, [])
})
