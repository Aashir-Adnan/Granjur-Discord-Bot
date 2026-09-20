import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHubPayload, buildEditModal, updatesFromModal, buildCountsModal, countsFromModal, blockerCandidates, noticeFor,
  showHub, handleHubComponent, handleEditSubmit, handleCountsSubmit, MAX_TEST_COUNT,
} from './taskHub.js'

const admin = () => ({ permissions: { has: (p) => p === 'Administrator' } })
const plain = () => ({ permissions: { has: () => false }, roles: { cache: { some: () => false } } })

const HELD = { id: 'H', guildConfigId: 'g1', title: 'My feature', status: 'open', assigneeIds: ['u1'], projectId: 'p1', projectName: 'Framework', scope: 'qa', implementationStatus: 'in_progress', passedApiTests: 3, passedQaTests: null, passedAcceptanceCriteria: 1 }
const OTHER = { id: 'O', title: 'Not mine', status: 'in_progress', assigneeIds: ['u2'], projectId: 'p2', projectName: 'Badar HMS' }
const DONE = { id: 'D', title: 'Finished', status: 'done', assigneeIds: ['u1'] }
const BUG = { id: 'B', title: 'A bug', status: 'open', is_bug: 1, assigneeIds: [], taggedMemberIds: ['u1'] }
const projects = [{ id: 'p1', name: 'Framework' }, { id: 'p2', name: 'Badar HMS' }]

const json = (payload) => payload.components.map((r) => r.toJSON())
const customIds = (payload) => json(payload).flatMap((r) => r.components.map((c) => c.custom_id))

// -------------------------------------------------------- candidates + hub ----

test('blockerCandidates leaves out itself, current blockers, finished tasks and cycles; same project first', () => {
  const rows = [
    HELD,
    { id: 'X', status: 'open', projectId: 'p2' },
    { id: 'Y', status: 'open', projectId: 'p1' },
    { id: 'Z', status: 'done', projectId: 'p1' },
    { id: 'C', status: 'open', projectId: 'p1' },
    { id: 'W', status: 'open', projectId: 'p1' },
  ]
  const deps = [{ taskId: 'W', blockedByTaskId: 'H' }] // W already waits on H, so H cannot wait on W
  const out = blockerCandidates(HELD, rows, deps, ['C'])
  assert.deepEqual(out.map((t) => t.id), ['Y', 'X'])
})

test('blockerCandidates never returns more than a select can hold', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, status: 'open' }))
  assert.equal(blockerCandidates(HELD, many, []).length, 25)
})

const baseHub = { task: HELD, projects, blockers: [], candidates: [OTHER] }

test('the hub shows every editable property and never more than five rows', () => {
  const p = buildHubPayload({ ...baseHub, blockers: [{ id: 'B1', title: 'Router fix', status: 'open' }], nameFor: () => 'Ana' })
  const e = p.embeds[0].toJSON()
  assert.equal(e.title, 'My feature')
  const field = (n) => e.fields.find((f) => f.name === n).value
  assert.equal(field('Status'), 'open')
  assert.equal(field('Scope'), 'QA')
  assert.equal(field('Project'), 'Framework')
  assert.equal(field('Implementation'), 'in progress')
  assert.equal(field('Tests passed'), 'API 3 · QA — · AC 1')
  assert.equal(field('Assignees'), 'Ana')
  assert.match(field('Blocked by'), /Router fix \(open\)/)
  // project, implementation, add-blocker, remove-blocker, buttons
  assert.deepEqual(customIds(p).map((id) => id.split(':')[0]), [
    'uth_proj', 'uth_impl', 'uth_block', 'uth_unblock', 'uth_basics', 'uth_counts', 'uth_back', 'uth_close',
  ])
  assert.ok(p.components.length <= 5)
})

test('the blocker rows only appear when there is something to pick', () => {
  const none = buildHubPayload({ ...baseHub, candidates: [], blockers: [] })
  assert.deepEqual(customIds(none).map((id) => id.split(':')[0]), ['uth_proj', 'uth_impl', 'uth_basics', 'uth_counts', 'uth_back', 'uth_close'])
})

test('the project and implementation selects preselect the current values', () => {
  const p = json(buildHubPayload(baseHub))
  assert.equal(p[0].components[0].options.find((o) => o.default).value, 'p1')
  assert.equal(p[1].components[0].options.find((o) => o.default).value, 'in_progress')
  const noProject = json(buildHubPayload({ ...baseHub, task: { ...HELD, projectId: null, projectName: null } }))
  assert.equal(noProject[0].components[0].options.find((o) => o.default).value, '-')
})

test('every custom id and option in the hub fits Discord limits', () => {
  const long = { ...HELD, id: 'a'.repeat(25), title: 'T'.repeat(300), projectName: 'P'.repeat(300) }
  const manyProjects = Array.from({ length: 40 }, (_, i) => ({ id: `${'b'.repeat(24)}${i % 10}`, name: 'N'.repeat(150) }))
  const cands = Array.from({ length: 25 }, (_, i) => ({ id: `${'c'.repeat(24)}${i % 10}`, title: 'C'.repeat(150), status: 'in_progress', projectName: 'Q'.repeat(150) }))
  const p = buildHubPayload({ task: long, projects: manyProjects, blockers: cands.slice(0, 5), candidates: cands, notice: 'n'.repeat(5000) })
  for (const id of customIds(p)) assert.ok(id.length <= 100, id)
  for (const row of json(p)) for (const c of row.components) {
    if (c.options) {
      assert.ok(c.options.length <= 25)
      for (const o of c.options) { assert.ok(o.label.length <= 100); if (o.description) assert.ok(o.description.length <= 100) }
    }
  }
  assert.ok(p.content.length <= 2000)
  assert.ok(p.embeds[0].toJSON().title.length <= 256)
})

test('noticeFor lists what saved, dependency lines, the blocker warning and the project note', () => {
  const text = noticeFor(HELD, { projectId: 'p2', projectName: 'Badar HMS', status: 'done' }, {
    dep: { lines: ['**Blocked by:** Router fix'] }, warning: '⛔ still blocked', notified: { created: false, dmed: ['u9'] },
  })
  assert.match(text, /Saved: project, status\./)
  assert.match(text, /Blocked by:\*\* Router fix/)
  assert.match(text, /⛔ still blocked/)
  assert.match(text, /channel has not moved/)
  assert.match(text, /Notified 1 member/)
  assert.equal(noticeFor(HELD, {}, { dep: { lines: [] }, warning: '', notified: {} }), '')
})

// ------------------------------------------------------------- the modals ----

test('the details modal has the five fields, prefilled from the task', () => {
  const m = buildEditModal({ ...HELD, description: 'Body' }).toJSON()
  assert.equal(m.custom_id, 'ut_edit:H')
  assert.deepEqual(m.components.map((c) => c.component.custom_id), ['status', 'scope', 'assignees', 'title', 'description'])
  const byId = Object.fromEntries(m.components.map((c) => [c.component.custom_id, c.component]))
  assert.equal(byId.status.options.find((o) => o.default).value, 'open')
  assert.equal(byId.scope.options.find((o) => o.default).value, 'qa')
  assert.deepEqual(byId.assignees.default_values.map((d) => d.id), ['u1'])
  assert.equal(byId.title.value, 'My feature')
  assert.equal(byId.description.value, 'Body')
  assert.ok(m.title.length <= 45)
})

test('a bug is prefilled with its tagged members; past 25 holders assignees are left out', () => {
  const bug = Object.fromEntries(buildEditModal(BUG).toJSON().components.map((c) => [c.component.custom_id, c.component]))
  assert.deepEqual(bug.assignees.default_values.map((d) => d.id), ['u1'])
  const crowd = { ...HELD, assigneeIds: Array.from({ length: 26 }, (_, i) => String(1000 + i)) }
  assert.deepEqual(buildEditModal(crowd).toJSON().components.map((c) => c.component.custom_id), ['status', 'scope', 'title', 'description'])
})

test('updatesFromModal writes only what changed', () => {
  const same = { status: 'open', scope: 'qa', title: 'My feature', description: '', assignees: ['u1'] }
  assert.deepEqual(updatesFromModal(HELD, same), {})
  assert.deepEqual(updatesFromModal(HELD, { ...same, status: 'done', scope: 'design', title: '  New  ', description: 'Text' }), { status: 'done', scope: 'design', title: 'New', description: 'Text' })
  assert.deepEqual(updatesFromModal(HELD, { ...same, assignees: ['u1', 'u3'] }), { assigneeIds: ['u1', 'u3'] })
  assert.deepEqual(updatesFromModal(HELD, { ...same, assignees: [] }), { assigneeIds: [] })
  assert.deepEqual(updatesFromModal({ ...HELD, description: 'was' }, { status: 'open', title: '  ', description: '', assignees: ['u1'] }), { description: null })
  assert.deepEqual(updatesFromModal(BUG, { status: 'open', title: 'A bug', description: '', assignees: ['u1'] }), {})
  assert.deepEqual(updatesFromModal(HELD, { status: 'open', title: 'My feature' }), {})
})

test('the counts modal has three optional fields prefilled with the current numbers', () => {
  const m = buildCountsModal(HELD).toJSON()
  assert.equal(m.custom_id, 'ut_counts:H')
  const byId = Object.fromEntries(m.components.map((c) => [c.component.custom_id, c.component]))
  assert.deepEqual(Object.keys(byId), ['api', 'qa', 'ac'])
  assert.equal(byId.api.value, '3')
  assert.equal(byId.qa.value, undefined) // null: nothing prefilled
  assert.equal(byId.ac.value, '1')
  assert.ok(m.title.length <= 45)
})

test('countsFromModal: blank leaves a count alone, numbers save, junk saves nothing', () => {
  assert.deepEqual(countsFromModal(HELD, { api: '', qa: '  ', ac: '' }), { updates: {}, error: null })
  assert.deepEqual(countsFromModal(HELD, { api: '3', qa: '7', ac: '' }), { updates: { passedQaTests: 7 }, error: null })
  assert.deepEqual(countsFromModal(HELD, { api: '0', qa: '', ac: '' }).updates, { passedApiTests: 0 })
  for (const bad of ['abc', '-1', '1.5', String(MAX_TEST_COUNT + 1), '1000']) {
    const out = countsFromModal(HELD, { api: '5', qa: bad, ac: '' })
    assert.deepEqual(out.updates, {}, bad)
    assert.match(out.error, /whole numbers from 0 to 127/)
  }
})

// ------------------------------------------------------------- handlers ----

const getConfig = async () => ({ id: 'g1' })

function fakeDb(tasks, { deps = [] } = {}) {
  const calls = []
  const activity = []
  const dependencies = [...deps]
  return {
    calls, activity, dependencies,
    task: {
      // Rows are copied out, as a real database returns them: the caller's snapshot
      // must not change underneath it when the update lands.
      findMany: async () => tasks.map((t) => ({ ...t })),
      findFirst: async ({ where }) => { const t = tasks.find((x) => x.id === where.id); return t ? { ...t } : null },
      findByIds: async ({ where }) => tasks.filter((t) => where.ids.includes(t.id)).map((t) => ({ ...t })),
      update: async (a) => { calls.push(['update', a]); const t = tasks.find((x) => x.id === a.where.id); if (t) Object.assign(t, a.data); return null },
    },
    project: { findMany: async () => projects, findFirst: async ({ where }) => projects.find((p) => p.id === where.id) ?? null },
    taskActivity: { add: async ({ data }) => { activity.push(data) } },
    taskDependency: {
      findManyForGuild: async () => dependencies,
      findByTask: async ({ where }) => dependencies.filter((d) => d.taskId === where.taskId),
      add: async ({ data }) => { dependencies.push({ taskId: data.taskId, blockedByTaskId: data.blockedByTaskId }); return data },
      remove: async ({ where }) => {
        const before = dependencies.length
        const i = dependencies.findIndex((d) => d.taskId === where.taskId && d.blockedByTaskId === where.blockedByTaskId)
        if (i >= 0) dependencies.splice(i, 1)
        return { removed: before - dependencies.length }
      },
    },
  }
}

function fakeInteraction({ member = admin(), userId = 'u1', customId = '', values = undefined, deferred = true, fields = null } = {}) {
  const sent = { edits: [], updates: [], replies: [], modals: [] }
  return {
    sent, customId, values, deferred, fields,
    guild: { id: 'guild1', members: { cache: new Map() } },
    user: { id: userId }, member, client: {},
    editReply: async (p) => { sent.edits.push(p); return p },
    update: async (p) => { sent.updates.push(p); return p },
    reply: async (p) => { sent.replies.push(p); return p },
    showModal: async (m) => { sent.modals.push(m) },
    deferUpdate: async function () { this.deferred = true },
    isFromMessage: () => true,
  }
}
const notify = async () => ({ channelId: null, created: false, dmed: [] })
const fresh = () => [{ ...HELD }, { ...OTHER }, { ...DONE }]
const lastNotice = (it) => it.sent.edits[it.sent.edits.length - 1].content

test('showHub draws the hub; for a task that is not yours it draws nothing of it', async () => {
  const it = fakeInteraction()
  await showHub(it, 'H', { db: fakeDb(fresh()), getConfig })
  assert.equal(it.sent.edits[0].embeds[0].toJSON().title, 'My feature')
  const denied = fakeInteraction({ member: plain() })
  await showHub(denied, 'O', { db: fakeDb(fresh()), getConfig })
  assert.match(denied.sent.edits[0].content, /not available/)
  assert.deepEqual(denied.sent.edits[0].embeds, [])
})

test('the details and counts buttons open their modals', async () => {
  const db = fakeDb(fresh())
  const a = fakeInteraction({ customId: 'uth_basics:H', deferred: false })
  await handleHubComponent(a, { db, getConfig })
  assert.equal(a.sent.modals[0].toJSON().custom_id, 'ut_edit:H')
  const b = fakeInteraction({ customId: 'uth_counts:H', deferred: false })
  await handleHubComponent(b, { db, getConfig })
  assert.equal(b.sent.modals[0].toJSON().custom_id, 'ut_counts:H')
})

test('a modal button for a task that is not yours opens nothing', async () => {
  const it = fakeInteraction({ customId: 'uth_basics:O', deferred: false, member: plain() })
  await handleHubComponent(it, { db: fakeDb(fresh()), getConfig })
  assert.equal(it.sent.modals.length, 0)
  assert.match(it.sent.updates[0].content, /not available/)
})

test('choosing a project saves it, records who did it, warns the channel did not move, and redraws', async () => {
  const db = fakeDb(fresh())
  const it = fakeInteraction({ customId: 'uth_proj:H', values: ['p2'] })
  await handleHubComponent(it, { db, getConfig, notify })
  assert.deepEqual(db.calls[0][1].data, { projectId: 'p2', projectName: 'Badar HMS' })
  assert.equal(db.activity[0].actorDiscordId, 'u1')
  assert.match(lastNotice(it), /Saved: project/)
  assert.match(lastNotice(it), /channel has not moved/)
  assert.equal(it.sent.edits[0].embeds[0].toJSON().fields.find((f) => f.name === 'Project').value, 'Badar HMS')
})

test('choosing "No project" detaches; choosing the current project changes nothing', async () => {
  const db = fakeDb(fresh())
  const off = fakeInteraction({ customId: 'uth_proj:H', values: ['-'] })
  await handleHubComponent(off, { db, getConfig, notify })
  assert.deepEqual(db.calls[0][1].data, { projectId: null, projectName: null })
  const db2 = fakeDb(fresh())
  const same = fakeInteraction({ customId: 'uth_proj:H', values: ['p1'] })
  await handleHubComponent(same, { db: db2, getConfig, notify })
  assert.deepEqual(db2.calls, [])
  assert.match(lastNotice(same), /Already in Framework/)
})

test('an unknown project is refused and nothing is written', async () => {
  const db = fakeDb(fresh())
  const it = fakeInteraction({ customId: 'uth_proj:H', values: ['nope'] })
  await handleHubComponent(it, { db, getConfig, notify })
  assert.deepEqual(db.calls, [])
  assert.match(lastNotice(it), /no longer exists/)
})

test('choosing an implementation status saves it; the current one is a no-op', async () => {
  const db = fakeDb(fresh())
  const it = fakeInteraction({ customId: 'uth_impl:H', values: ['done'] })
  await handleHubComponent(it, { db, getConfig, notify })
  assert.deepEqual(db.calls[0][1].data, { implementationStatus: 'done' })
  const db2 = fakeDb(fresh())
  const same = fakeInteraction({ customId: 'uth_impl:H', values: ['in_progress'] })
  await handleHubComponent(same, { db: db2, getConfig, notify })
  assert.deepEqual(db2.calls, [])
})

test('adding a blocker records the dependency and the activity, and the hub then lists it', async () => {
  const db = fakeDb(fresh())
  const it = fakeInteraction({ customId: 'uth_block:H', values: ['O'] })
  await handleHubComponent(it, { db, getConfig, notify })
  assert.deepEqual(db.dependencies, [{ taskId: 'H', blockedByTaskId: 'O' }])
  assert.deepEqual(db.activity[0].changes, [{ field: 'blocked_by', action: 'added', title: 'Not mine' }])
  assert.match(lastNotice(it), /Blocked by:\*\* Not mine/)
  assert.match(it.sent.edits[0].embeds[0].toJSON().fields.find((f) => f.name === 'Blocked by').value, /Not mine/)
})

test('a blocker that would make a cycle is refused with nothing written', async () => {
  const db = fakeDb(fresh(), { deps: [{ taskId: 'O', blockedByTaskId: 'H' }] })
  const it = fakeInteraction({ customId: 'uth_block:H', values: ['O'] })
  await handleHubComponent(it, { db, getConfig, notify })
  assert.deepEqual(db.dependencies, [{ taskId: 'O', blockedByTaskId: 'H' }])
  assert.match(lastNotice(it), /❌/)
})

test('removing a blocker unblocks and says so', async () => {
  const db = fakeDb(fresh(), { deps: [{ taskId: 'H', blockedByTaskId: 'O' }] })
  const it = fakeInteraction({ customId: 'uth_unblock:H', values: ['O'] })
  await handleHubComponent(it, { db, getConfig, notify })
  assert.deepEqual(db.dependencies, [])
  assert.match(lastNotice(it), /Unblocked:\*\* Not mine/)
})

test('close removes the hub; back returns to the finder panel', async () => {
  const db = fakeDb(fresh())
  const close = fakeInteraction({ customId: 'uth_close:H' })
  await handleHubComponent(close, { db, getConfig })
  assert.deepEqual(close.sent.edits[0].components, [])
  const back = fakeInteraction({ customId: 'uth_back:H' })
  await handleHubComponent(back, { db, getConfig })
  assert.equal(back.sent.edits[0].embeds[0].toJSON().title, 'Find a task')
})

function detailsFields({ status = 'open', scope = [], assignees = ['u1'], title = 'My feature', description = '' } = {}) {
  const map = new Map([
    ['status', { values: [status] }], ['scope', { values: scope }], ['assignees', { values: assignees }],
    ['title', { value: title }], ['description', { value: description }],
  ])
  return { fields: map, getTextInputValue: (id) => map.get(id).value }
}

test('submitting the details modal saves through the shared path and redraws the hub in place', async () => {
  const db = fakeDb(fresh())
  const seen = []
  const it = fakeInteraction({ customId: 'ut_edit:H', fields: detailsFields({ status: 'in_progress', scope: ['design'], assignees: ['u1', 'u3'] }) })
  await handleEditSubmit(it, { db, getConfig, notify: async (a) => { seen.push(a); return { channelId: null, created: false, dmed: [] } } })
  assert.deepEqual(db.calls[0][1].data, { status: 'in_progress', scope: 'design', assigneeIds: ['u1', 'u3'] })
  assert.equal(seen.length, 1)
  assert.equal(db.activity[0].actorDiscordId, 'u1')
  assert.match(lastNotice(it), /Saved: status, scope, assignees/)
})

test('a modal submit that arrives un-acknowledged is acknowledged as an update of the hub message', async () => {
  const db = fakeDb(fresh())
  const it = fakeInteraction({ customId: 'ut_edit:H', deferred: false, fields: detailsFields() })
  await handleEditSubmit(it, { db, getConfig, notify })
  assert.equal(it.deferred, true)
})

test('submitting the details modal untouched says so and writes nothing; someone else\'s task writes nothing', async () => {
  const db = fakeDb(fresh())
  const it = fakeInteraction({ customId: 'ut_edit:H', fields: detailsFields({ scope: ['qa'] }) })
  await handleEditSubmit(it, { db, getConfig, notify })
  assert.equal(lastNotice(it), 'Nothing changed.')
  assert.deepEqual(db.calls, [])
  const db2 = fakeDb(fresh())
  const other = fakeInteraction({ customId: 'ut_edit:O', member: plain(), fields: detailsFields({ status: 'done', assignees: ['u2'] }) })
  await handleEditSubmit(other, { db: db2, getConfig, notify })
  assert.match(other.sent.edits[0].content, /not available/)
  assert.deepEqual(db2.calls, [])
})

function countsFields(values) {
  const map = new Map(Object.entries(values).map(([k, v]) => [k, { value: v }]))
  return { fields: map, getTextInputValue: (id) => map.get(id).value }
}

test('submitting test counts saves the changed ones', async () => {
  const db = fakeDb(fresh())
  const it = fakeInteraction({ customId: 'ut_counts:H', fields: countsFields({ api: '3', qa: '9', ac: '' }) })
  await handleCountsSubmit(it, { db, getConfig, notify })
  assert.deepEqual(db.calls[0][1].data, { passedQaTests: 9 })
  assert.match(lastNotice(it), /Saved: QA tests/)
})

test('a bad test count saves nothing and says why', async () => {
  const db = fakeDb(fresh())
  const it = fakeInteraction({ customId: 'ut_counts:H', fields: countsFields({ api: '5', qa: 'lots', ac: '' }) })
  await handleCountsSubmit(it, { db, getConfig, notify })
  assert.deepEqual(db.calls, [])
  assert.match(lastNotice(it), /❌ Test counts must be whole numbers/)
})

test('a failing write is reported on the hub instead of leaving it hanging', async () => {
  const db = fakeDb(fresh())
  db.task.update = async () => { throw new Error('db down') }
  const orig = console.error; console.error = () => {}
  try {
    const it = fakeInteraction({ customId: 'uth_impl:H', values: ['done'] })
    await handleHubComponent(it, { db, getConfig, notify })
    assert.match(lastNotice(it), /Update failed: db down/)
  } finally { console.error = orig }
})
