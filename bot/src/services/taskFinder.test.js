import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAGE_SIZE, defaultState, encodeState, decodeState, parseFinderId, filterTasks, pageOf,
  buildFinderPayload, showFinder, handleFinderComponent,
} from './taskFinder.js'

const admin = () => ({ permissions: { has: (p) => p === 'Administrator' } })
const plain = () => ({ permissions: { has: () => false }, roles: { cache: { some: () => false } } })

const HELD = { id: 'H', title: 'My feature', status: 'open', assigneeIds: ['u1'], projectId: 'p1', scope: 'qa' }
const OTHER = { id: 'O', title: 'Not mine', status: 'in_progress', assigneeIds: ['u2'], projectId: 'p2' }
const DONE = { id: 'D', title: 'Finished', status: 'done', assigneeIds: ['u1'], projectId: 'p1' }
const BUG = { id: 'B', title: 'A bug', status: 'open', is_bug: 1, assigneeIds: [], taggedMemberIds: ['u1'] }
const projects = [{ id: 'p1', name: 'Framework' }, { id: 'p2', name: 'Badar HMS' }]

// ---------------------------------------------------------------- state ----

test('state round-trips through a custom id, and malformed input falls back to the default', () => {
  const s = { project: 'abc123', person: '9001', page: 3, done: true }
  assert.deepEqual(decodeState(encodeState(s)), s)
  assert.deepEqual(decodeState(encodeState(defaultState())), defaultState())
  assert.deepEqual(decodeState('garbage'), { project: 'garbage', person: null, page: 0, done: false })
  assert.deepEqual(decodeState(undefined), defaultState())
  assert.equal(decodeState('-:-:-5:0').page, 0)
})

test('parseFinderId splits the action from the state', () => {
  const id = `utf_proj:${encodeState({ project: 'p1', person: null, page: 2, done: false })}`
  assert.deepEqual(parseFinderId(id), { action: 'proj', state: { project: 'p1', person: null, page: 2, done: false } })
})

// -------------------------------------------------------------- filtering ----

const rows = [HELD, OTHER, DONE, BUG]
const ids = (list) => list.map((t) => t.id)

test('filterTasks: a normal member only sees tasks they hold; finished ones are hidden by default', () => {
  const f = { project: null, person: null, done: false, isLeadership: false, callerId: 'u1' }
  assert.deepEqual(ids(filterTasks(rows, f)), ['H', 'B'])
  assert.deepEqual(ids(filterTasks(rows, { ...f, done: true })), ['H', 'D', 'B'])
})

test('filterTasks: leadership sees everyone, and can narrow by project and by person', () => {
  const f = { project: null, person: null, done: false, isLeadership: true, callerId: 'x' }
  assert.deepEqual(ids(filterTasks(rows, f)), ['H', 'O', 'B'])
  assert.deepEqual(ids(filterTasks(rows, { ...f, project: 'p2' })), ['O'])
  assert.deepEqual(ids(filterTasks(rows, { ...f, person: 'u1' })), ['H', 'B'])
  assert.deepEqual(ids(filterTasks(rows, { ...f, person: 'u1', project: 'p1' })), ['H'])
})

test('pageOf clamps the page and never returns more than a page', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}` }))
  assert.equal(pageOf(many, 0).items.length, PAGE_SIZE)
  assert.equal(pageOf(many, 2).items.length, 10)
  assert.equal(pageOf(many, 99).page, 2)
  assert.equal(pageOf(many, -4).page, 0)
  assert.deepEqual(pageOf([], 0), { items: [], page: 0, pages: 1 })
})

// ------------------------------------------------------------- the panel ----

const json = (payload) => payload.components.map((r) => r.toJSON())
const allIds = (payload) => json(payload).flatMap((r) => r.components.map((c) => c.custom_id))

test('the panel shows the person filter to leadership only', () => {
  const base = { rows, projects, state: defaultState(), callerId: 'u1' }
  const lead = json(buildFinderPayload({ ...base, isLeadership: true }))
  const member = json(buildFinderPayload({ ...base, isLeadership: false }))
  const types = (rowsJson) => rowsJson.map((r) => r.components[0].type)
  assert.deepEqual(types(lead), [3, 5, 3, 2]) // project, person, task, buttons
  assert.deepEqual(types(member), [3, 3, 2])
})

test('the task list is the filtered page, with status, project and holder in each description', () => {
  const p = buildFinderPayload({ rows, projects, state: defaultState(), isLeadership: true, callerId: 'x', nameFor: (id) => ({ u1: 'Ana', u2: 'Ben' })[id] })
  const taskMenu = json(p)[2].components[0]
  assert.deepEqual(taskMenu.options.map((o) => o.value), ['H', 'O', 'B'])
  const held = taskMenu.options[0]
  assert.equal(held.label, 'My feature')
  assert.equal(held.description, 'open · QA · Framework · Ana')
  assert.match(taskMenu.placeholder, /3 matches/)
})

test('every custom id and option fits Discord limits, even with long names and many tasks', () => {
  const long = Array.from({ length: 80 }, (_, i) => ({
    id: `${'a'.repeat(24)}${i % 10}`, title: 'T'.repeat(150), status: 'in_progress', assigneeIds: ['u1', 'u2', 'u3', 'u4'],
    projectId: 'p1', scope: 'backend',
  }))
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `${'b'.repeat(24)}${i % 10}`, name: 'P'.repeat(150) }))
  const p = buildFinderPayload({
    rows: long, projects: many, isLeadership: true, callerId: 'x', nameFor: () => 'A very long display name indeed',
    state: { project: 'b'.repeat(25), person: '123456789012345678', page: 1, done: true },
  })
  for (const id of allIds(p)) assert.ok(id.length <= 100, `${id.length}: ${id}`)
  for (const row of json(p)) {
    for (const c of row.components) {
      if (c.options) {
        assert.ok(c.options.length <= 25)
        for (const o of c.options) {
          assert.ok(o.label.length <= 100)
          if (o.description) assert.ok(o.description.length <= 100)
        }
      }
    }
  }
  assert.ok(json(p).length <= 5)
})

test('paging buttons carry the next state and are disabled at the ends', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: 'open', assigneeIds: ['u1'] }))
  const first = json(buildFinderPayload({ rows: many, projects, state: defaultState(), isLeadership: true, callerId: 'x' }))
  const buttons = first[first.length - 1].components
  const prev = buttons.find((b) => b.custom_id.startsWith('utf_prev'))
  const next = buttons.find((b) => b.custom_id.startsWith('utf_next'))
  assert.equal(prev.disabled, true)
  assert.equal(next.disabled, false)
  assert.equal(parseFinderId(next.custom_id).state.page, 1)
  const last = json(buildFinderPayload({ rows: many, projects, state: { ...defaultState(), page: 1 }, isLeadership: true, callerId: 'x' }))
  const lastButtons = last[last.length - 1].components
  assert.equal(lastButtons.find((b) => b.custom_id.startsWith('utf_next')).disabled, true)
})

test('no matches: no task list, and the message says so', () => {
  const p = buildFinderPayload({ rows: [OTHER], projects, state: defaultState(), isLeadership: false, callerId: 'u1' })
  assert.equal(json(p).length, 2) // project + buttons
  assert.match(p.embeds[0].toJSON().description, /No tasks match/)
})

// ------------------------------------------------------------- handlers ----

const getConfig = async () => ({ id: 'g1' })

function fakeDb(tasks) {
  const calls = []
  const activity = []
  return {
    calls, activity,
    task: {
      findMany: async () => tasks,
      findByIds: async ({ where }) => tasks.filter((t) => where.ids.includes(t.id)),
      findChildren: async ({ where }) => tasks.filter((t) => t.parentTaskId === where.parentTaskId),
      findFirst: async ({ where }) => tasks.find((t) => t.id === where.id) ?? null,
      update: async (a) => { calls.push(['update', a]); return null },
    },
    project: { findMany: async () => projects },
    taskActivity: { add: async ({ data }) => { activity.push(data) } },
    taskDependency: { findManyForGuild: async () => [], findByTask: async () => [], add: async () => ({}), remove: async () => ({ removed: 0 }) },
  }
}

function fakeInteraction({ member = admin(), userId = 'u1', customId = '', values = undefined, deferred = true, fields = null } = {}) {
  const sent = { edits: [], updates: [], replies: [], modals: [] }
  return {
    sent, customId, values, deferred, fields,
    guild: { id: 'guild1', members: { cache: new Map() } },
    user: { id: userId },
    member,
    client: {},
    editReply: async (p) => { sent.edits.push(p); return p },
    update: async (p) => { sent.updates.push(p); return p },
    reply: async (p) => { sent.replies.push(p); return p },
    showModal: async (m) => { sent.modals.push(m) },
  }
}

test('showFinder answers the deferred command with the panel', async () => {
  const it = fakeInteraction()
  await showFinder(it, { db: fakeDb(rows), getConfig })
  assert.equal(it.sent.edits.length, 1)
  assert.equal(it.sent.edits[0].embeds[0].toJSON().title, 'Find a task')
})

test('choosing a project rebuilds the panel filtered to it and resets the page', async () => {
  const it = fakeInteraction({ customId: `utf_proj:${encodeState({ ...defaultState(), page: 4 })}`, values: ['p2'] })
  await handleFinderComponent(it, { db: fakeDb(rows), getConfig })
  const p = it.sent.edits[0]
  const menu = p.components[2].toJSON().components[0]
  assert.deepEqual(menu.options.map((o) => o.value), ['O'])
  assert.equal(parseFinderId(menu.custom_id).state.project, 'p2')
  assert.equal(parseFinderId(menu.custom_id).state.page, 0)
})

test('a not-deferred component (a user select) updates the message instead of editing the reply', async () => {
  const it = fakeInteraction({ customId: `utf_person:${encodeState(defaultState())}`, values: ['u2'], deferred: false })
  await handleFinderComponent(it, { db: fakeDb(rows), getConfig })
  assert.equal(it.sent.edits.length, 0)
  assert.deepEqual(it.sent.updates[0].components[2].toJSON().components[0].options.map((o) => o.value), ['O'])
})

test('close removes the panel', async () => {
  const it = fakeInteraction({ customId: 'utf_close:-:-:0:0' })
  await handleFinderComponent(it, { db: fakeDb(rows), getConfig })
  assert.deepEqual(it.sent.edits[0].components, [])
})

test('picking a task shows its hub, not a modal', async () => {
  const it = fakeInteraction({ customId: 'utf_task:-:-:0:0', values: ['H'] })
  await handleFinderComponent(it, { db: fakeDb(rows), getConfig })
  assert.equal(it.sent.modals.length, 0)
  assert.equal(it.sent.edits[0].embeds[0].toJSON().title, 'My feature')
  assert.ok(it.sent.edits[0].components.length >= 3)
})

test('picking a task that is not yours shows nothing of it', async () => {
  const it = fakeInteraction({ customId: 'utf_task:-:-:0:0', values: ['O'], member: plain() })
  await handleFinderComponent(it, { db: fakeDb(rows), getConfig })
  assert.match(it.sent.edits[0].content, /not available/)
  assert.deepEqual(it.sent.edits[0].embeds, [])
})

test('the task list shows a parent\'s subtask progress and a subtask\'s parent', () => {
  const P = { id: 'P', title: 'Parent task', status: 'in_progress', assigneeIds: ['u1'] }
  const S1 = { id: 'S1', title: 'Write tests', status: 'open', assigneeIds: ['u1'], parentTaskId: 'P' }
  const S2 = { id: 'S2', title: 'Deploy', status: 'done', assigneeIds: ['u1'], parentTaskId: 'P' }
  const p = buildFinderPayload({ rows: [P, S1, S2], projects: [], state: { ...defaultState(), done: true }, isLeadership: true, callerId: 'x', nameFor: () => 'Ana' })
  const menu = json(p)[2].components[0]
  const byValue = Object.fromEntries(menu.options.map((o) => [o.value, o.description]))
  assert.equal(byValue.P, 'in_progress · Ana · 1/2 subtasks')
  assert.equal(byValue.S1, 'open · ↳ Parent task · Ana')
  for (const o of menu.options) assert.ok(o.description.length <= 100)
})
