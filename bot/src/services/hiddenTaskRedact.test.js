// The three bot texts that can name a related task back to a site caller — the
// blocker warning, the unblock line and the "can't be finished" refusal — name
// a task whose id is in `redact` (CSAAS's `hiddenTaskIds`) as "A task in another
// project". Without the set (every Discord caller) they are exactly as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockerWarning, HIDDEN_TASK_TITLE } from '../utils/taskDeps.js'
import { finishBlockMessage, TaskRuleError } from '../utils/taskHierarchy.js'
import { applyTaskUpdate } from './taskStatusChange.js'
import { applyDependencyChange, applyEdit } from './taskEdit.js'
import { assertCanFinish } from './taskHierarchy.js'
import { handleStatusRequest, handleUpdateRequest, handleSubtaskRequest, redactSetFrom } from './internalTaskRoute.js'

const hidden = new Set(['H'])

test('the hidden title is the exact stub sentence', () => {
  assert.equal(HIDDEN_TASK_TITLE, 'A task in another project')
})

// ── 1. blocker warning ──────────────────────────────────────────────────────
test('blockerWarning: real titles without a set, the stub for a hidden id with one', () => {
  const open = [{ id: 'H', title: 'Secret thing', status: 'open' }, { id: 'V', title: 'Visible', status: 'in_progress' }]
  assert.equal(blockerWarning(open), '⛔ Still blocked by: **Secret thing** (open), **Visible** (in progress)')
  assert.equal(blockerWarning(open, hidden), '⛔ Still blocked by: **A task in another project** (open), **Visible** (in progress)')
})

function statusDb() {
  return {
    task: {
      update: async () => null,
      findByIds: async ({ where }) => [{ id: 'H', title: 'Secret thing', status: 'open' }].filter((t) => where.ids.includes(t.id)),
      findChildren: async () => [],
    },
    taskActivity: { add: async () => {} },
    taskDependency: { findByTask: async () => [{ taskId: 'A', blockedByTaskId: 'H' }] },
    guildConfig: { findById: async () => ({ id: 'g1', guildId: 'guild1' }) },
  }
}
const client = { guilds: { cache: new Map([['guild1', { id: 'guild1' }]]) } }
const move = async () => ({ moved: false, archived: null, reason: null })

test('applyTaskUpdate: the returned warning hides the blocker, the channel post keeps its title', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'Mine', status: 'open' }
  const posts = []
  const notify = async (a) => { posts.push(a.warning); return { channelId: null, created: false, dmed: [] } }
  const plain = await applyTaskUpdate({ db: statusDb(), client, task, updates: { status: 'in_progress' }, notify, move })
  assert.equal(plain.warning, '⛔ Still blocked by: **Secret thing** (open)')
  const red = await applyTaskUpdate({ db: statusDb(), client, task, updates: { status: 'in_progress' }, notify, move, redact: hidden })
  assert.equal(red.warning, '⛔ Still blocked by: **A task in another project** (open)')
  assert.deepEqual(posts, ['⛔ Still blocked by: **Secret thing** (open)', '⛔ Still blocked by: **Secret thing** (open)'])
})

// ── 2. unblock line ─────────────────────────────────────────────────────────
function depDb() {
  const activity = []
  return {
    activity,
    task: { findByIds: async ({ where }) => where.ids.map((id) => ({ id, title: id === 'H' ? 'Secret thing' : `Task ${id}`, status: 'open' })) },
    taskDependency: { remove: async () => ({ removed: 1 }) },
    taskActivity: { add: async ({ data }) => { activity.push(data.changes[0].title) } },
  }
}
const task = { id: 'T', guildConfigId: 'g1', title: 'Mine', status: 'open', parentTaskId: null }

test('applyDependencyChange: the unblock line hides the blocker only with the set; the activity row keeps the title', async () => {
  const d1 = depDb()
  const plain = await applyDependencyChange({ db: d1, cfg: { id: 'g1' }, task, unblockId: 'H' })
  assert.deepEqual(plain.lines, ['**Unblocked:** Secret thing'])
  const d2 = depDb()
  const red = await applyDependencyChange({ db: d2, cfg: { id: 'g1' }, task, unblockId: 'H', redact: hidden })
  assert.deepEqual(red.lines, ['**Unblocked:** A task in another project'])
  assert.deepEqual(d2.activity, ['Secret thing'])
})

test('applyEdit threads the set to the unblock line and to apply', async () => {
  let seen
  const r = await applyEdit({
    db: { ...depDb(), task: { ...depDb().task, findChildren: async () => [] } }, cfg: { id: 'g1' }, task,
    updates: { title: 'New' }, blockers: { add: [], remove: ['H', 'V'] }, redact: hidden,
    apply: async (a) => { seen = a; return { warning: '', notified: {} } },
  })
  assert.deepEqual(r.dep.lines, ['**Unblocked:** A task in another project', '**Unblocked:** Task V'])
  assert.equal(seen.redact, hidden)
})

// ── 3. the "can't be finished" refusal ──────────────────────────────────────
test('finishBlockMessage: the hidden subtask is a stub bullet with the set, its title without', () => {
  const parent = { id: 'P', title: 'Parent' }
  const kids = [{ id: 'H', title: 'Secret sub', status: 'open' }, { id: 'V', title: 'Visible sub', status: 'open' }]
  assert.equal(finishBlockMessage(parent, kids, 'done'),
    "**Parent** can't be marked done yet — 2 subtasks are still open:\n• Secret sub\n• Visible sub")
  assert.equal(finishBlockMessage(parent, kids, 'done', hidden),
    "**Parent** can't be marked done yet — 2 subtasks are still open:\n• A task in another project\n• Visible sub")
})

test('assertCanFinish and applyEdit carry the set into the refusal', async () => {
  const db = { task: { findChildren: async () => [{ id: 'H', title: 'Secret sub', status: 'open' }] } }
  const parent = { id: 'P', title: 'Parent', status: 'in_progress' }
  await assert.rejects(assertCanFinish({ db, task: parent, updates: { status: 'done' } }), (e) => e instanceof TaskRuleError && /• Secret sub/.test(e.message))
  await assert.rejects(assertCanFinish({ db, task: parent, updates: { status: 'done' }, redact: hidden }), (e) => /• A task in another project/.test(e.message) && !/Secret/.test(e.message))
  const r = await applyEdit({ db, cfg: { id: 'g1' }, task: parent, updates: { status: 'done' }, redact: hidden, apply: async () => { throw new Error('not reached') } })
  assert.match(r.error, /• A task in another project/)
  assert.doesNotMatch(r.error, /Secret/)
})

// ── the routes: `hiddenTaskIds` → a Set, validated ──────────────────────────
test('redactSetFrom accepts an array of up to 200 strings of at most 64 chars, and ignores anything else', () => {
  assert.deepEqual([...redactSetFrom(['a', 'b'])], ['a', 'b'])
  assert.equal(redactSetFrom(undefined).size, 0)
  assert.equal(redactSetFrom('a').size, 0)
  assert.equal(redactSetFrom(['a', 5]).size, 0)
  assert.equal(redactSetFrom(['a', 'x'.repeat(65)]).size, 0)
  assert.equal(redactSetFrom(['a', '']).size, 0)
  assert.equal(redactSetFrom(Array.from({ length: 200 }, (_, i) => `t${i}`)).size, 200)
  assert.equal(redactSetFrom(Array.from({ length: 201 }, (_, i) => `t${i}`)).size, 0)
})

const H = { 'x-internal-secret': 's3cret' }
const routeTask = { id: 'A', guildConfigId: 'g1', title: 'Mine', status: 'open' }
const routeDb = {
  task: { findFirst: async ({ where }) => (where.id === 'A' ? routeTask : null) },
  guildMember: { findByConfigEmail: async () => null, findMany: async () => [] },
  guildConfig: { findById: async () => ({ id: 'g1', guildId: 'guild1' }) },
}

test('status route passes hiddenTaskIds to apply as a Set, and an empty Set when absent', async () => {
  const seen = []
  const apply = async (a) => { seen.push(a.redact); return { warning: '' } }
  await handleStatusRequest({ headers: H, body: { taskId: 'A', status: 'done', hiddenTaskIds: ['H'] }, db: routeDb, client: {}, secret: 's3cret', apply })
  await handleStatusRequest({ headers: H, body: { taskId: 'A', status: 'done' }, db: routeDb, client: {}, secret: 's3cret', apply })
  assert.deepEqual(seen.map((s) => [...s]), [['H'], []])
})

test('update route passes hiddenTaskIds to edit as a Set', async () => {
  let seen
  await handleUpdateRequest({
    headers: H, body: { taskId: 'A', changes: { title: 'Renamed' }, hiddenTaskIds: ['H', 'K'] }, db: routeDb, client: {}, secret: 's3cret',
    edit: async (a) => { seen = a.redact; return { error: null, dep: { lines: [] }, warning: '' } },
  })
  assert.deepEqual([...seen], ['H', 'K'])
})

test('subtask route passes hiddenTaskIds on as a Set', async () => {
  let seen
  await handleSubtaskRequest({
    headers: H, body: { parentId: 'A', title: 'Sub', hiddenTaskIds: ['H'] }, db: routeDb, client: {}, secret: 's3cret',
    addSubtask: async (a) => { seen = a.redact; return { id: 'S', status: 'open', parentTaskId: 'A' } },
  })
  assert.deepEqual([...seen], ['H'])
})
