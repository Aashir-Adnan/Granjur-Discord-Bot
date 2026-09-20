import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAGE_SIZE, defaultState, encodeState, decodeState, parseFinderId, filterTasks, pageOf,
  buildFinderPayload, buildEditModal, updatesFromModal, showFinder, handleFinderComponent, handleEditSubmit,
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

// ------------------------------------------------------------- the modal ----

test('the edit modal has the five fields, prefilled from the task', () => {
  const m = buildEditModal({ ...HELD, description: 'Body', scope: 'qa' }).toJSON()
  assert.equal(m.custom_id, 'ut_edit:H')
  const ids = m.components.map((c) => c.component.custom_id)
  assert.deepEqual(ids, ['status', 'scope', 'assignees', 'title', 'description'])
  const byId = Object.fromEntries(m.components.map((c) => [c.component.custom_id, c.component]))
  assert.equal(byId.status.options.find((o) => o.default).value, 'open')
  assert.equal(byId.scope.options.find((o) => o.default).value, 'qa')
  assert.deepEqual(byId.assignees.default_values.map((d) => d.id), ['u1'])
  assert.equal(byId.title.value, 'My feature')
  assert.equal(byId.description.value, 'Body')
  assert.ok(m.title.length <= 45)
})

test('a bug is prefilled with its tagged members, and a task with no scope has none preselected', () => {
  const m = buildEditModal(BUG).toJSON()
  const byId = Object.fromEntries(m.components.map((c) => [c.component.custom_id, c.component]))
  assert.deepEqual(byId.assignees.default_values.map((d) => d.id), ['u1'])
  assert.equal(byId.scope.options.some((o) => o.default), false)
})

test('past 25 holders the assignees field is left out rather than silently truncated', () => {
  const crowd = { ...HELD, assigneeIds: Array.from({ length: 26 }, (_, i) => String(1000 + i)) }
  const ids = buildEditModal(crowd).toJSON().components.map((c) => c.component.custom_id)
  assert.deepEqual(ids, ['status', 'scope', 'title', 'description'])
})

test('updatesFromModal writes only what changed', () => {
  const same = { status: 'open', scope: 'qa', title: 'My feature', description: '', assignees: ['u1'] }
  assert.deepEqual(updatesFromModal(HELD, same), {})
  assert.deepEqual(updatesFromModal(HELD, { ...same, status: 'done', scope: 'design', title: '  New  ', description: 'Text' }), {
    status: 'done', scope: 'design', title: 'New', description: 'Text',
  })
  assert.deepEqual(updatesFromModal(HELD, { ...same, assignees: ['u1', 'u3'] }), { assigneeIds: ['u1', 'u3'] })
  assert.deepEqual(updatesFromModal(HELD, { ...same, assignees: [] }), { assigneeIds: [] })
})

test('updatesFromModal: no scope selected leaves it alone; a blank title is ignored; a cleared description is null', () => {
  const t = { ...HELD, description: 'was here' }
  assert.deepEqual(updatesFromModal(t, { status: 'open', scope: undefined, title: '   ', description: '', assignees: ['u1'] }), { description: null })
})

test('updatesFromModal: saving a bug untouched does not turn its tagged members into assignees', () => {
  const out = updatesFromModal(BUG, { status: 'open', scope: undefined, title: 'A bug', description: '', assignees: ['u1'] })
  assert.deepEqual(out, {})
})

test('updatesFromModal: a modal without the assignees or description field leaves them alone', () => {
  assert.deepEqual(updatesFromModal(HELD, { status: 'open', title: 'My feature' }), {})
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

test('picking a task opens the edit modal', async () => {
  const it = fakeInteraction({ customId: 'utf_task:-:-:0:0', values: ['H'], deferred: false })
  await handleFinderComponent(it, { db: fakeDb(rows), getConfig })
  assert.equal(it.sent.modals.length, 1)
  assert.equal(it.sent.modals[0].toJSON().custom_id, 'ut_edit:H')
})

test('picking a task that is not yours is refused, without opening a modal', async () => {
  const it = fakeInteraction({ customId: 'utf_task:-:-:0:0', values: ['O'], deferred: false, member: plain() })
  await handleFinderComponent(it, { db: fakeDb(rows), getConfig })
  assert.equal(it.sent.modals.length, 0)
  assert.match(it.sent.replies[0].content, /not available/)
})

function modalFields({ status = 'open', scope = [], assignees = ['u1'], title = 'My feature', description = '' } = {}) {
  const map = new Map([
    ['status', { values: [status] }], ['scope', { values: scope }], ['assignees', { values: assignees }],
    ['title', { value: title }], ['description', { value: description }],
  ])
  return { fields: map, getTextInputValue: (id) => map.get(id).value }
}

test('submitting the modal applies the changes through the shared update path and records who did it', async () => {
  const db = fakeDb([HELD])
  const notified = []
  const it = fakeInteraction({ customId: 'ut_edit:H', fields: modalFields({ status: 'in_progress', scope: ['design'], assignees: ['u1', 'u3'] }) })
  await handleEditSubmit(it, { db, getConfig, notify: async (a) => { notified.push(a); return { channelId: null, created: false, dmed: [] } } })
  assert.deepEqual(db.calls[0][1].data, { status: 'in_progress', scope: 'design', assigneeIds: ['u1', 'u3'] })
  assert.equal(notified.length, 1)
  assert.equal(db.activity[0].actorDiscordId, 'u1')
  assert.equal(it.sent.edits[0].embeds[0].toJSON().title, 'Task updated')
})

test('submitting the modal without changing anything says so and writes nothing', async () => {
  const db = fakeDb([HELD])
  const it = fakeInteraction({ customId: 'ut_edit:H', fields: modalFields({ scope: ['qa'] }) })
  await handleEditSubmit(it, { db, getConfig, notify: async () => ({ channelId: null, created: false, dmed: [] }) })
  assert.equal(it.sent.edits[0].content, 'Nothing changed.')
  assert.deepEqual(db.calls, [])
})

test('a modal submitted for a task the member cannot see writes nothing', async () => {
  const db = fakeDb([OTHER])
  const it = fakeInteraction({ customId: 'ut_edit:O', member: plain(), fields: modalFields({ status: 'done', assignees: ['u2'] }) })
  await handleEditSubmit(it, { db, getConfig, notify: async () => ({}) })
  assert.match(it.sent.edits[0].content, /not available/)
  assert.deepEqual(db.calls, [])
})
