import { test } from 'node:test'
import assert from 'node:assert/strict'
import { data, execute, buildReportPayload, autocomplete } from './time-report.js'
import { GENERAL } from './clock-in.js'

// Every test passes fakes for db and getConfig. Nothing here may reach the real
// db export or the real getOrCreateGuildConfig: the root .env points at production.

const NOW = new Date('2026-09-22T12:00:00Z')
const getConfig = async () => ({ id: 'g1', timezone: 'UTC' })
const PLAIN = { permissions: { has: () => false }, roles: { cache: { some: () => false } } }
const ADMIN = { permissions: { has: (p) => p === 'Administrator' }, roles: { cache: { some: () => false } } }

const at = (iso) => new Date(iso)
const entry = (o) => ({ id: `e${Math.random()}`, guildConfigId: 'g1', minutes: 60, clockInAt: at('2026-09-22T09:00:00Z'), clockOutAt: at('2026-09-22T10:00:00Z'), ...o })
const text = (p) => JSON.stringify(p.embeds[0].toJSON())
const NAMES = { u1: 'Ana', u2: 'Ben' }
const nameFor = (id) => NAMES[id] ?? null

// A db whose every method records its calls, so "nothing was read" is checkable.
function fakeDb({ entries = [], tasks = [], projects = [] } = {}) {
  const reads = []
  return {
    reads,
    clockEntry: { findMany: async (q) => { reads.push(['clockEntry.findMany', q]); return entries } },
    task: { findByIds: async (q) => { reads.push(['task.findByIds', q]); return tasks.filter((t) => q.where.ids.includes(t.id)) } },
    project: { findMany: async (q) => { reads.push(['project.findMany', q]); return projects } },
  }
}

function fakeInteraction(opts = {}, { member = PLAIN, users = {}, focused = null } = {}) {
  const edits = []
  const responses = []
  return {
    edits, responses,
    deferred: true,
    guild: { id: 'guild1', members: { cache: new Map() } },
    user: { id: 'boss' }, member,
    options: {
      getString: (k) => opts[k] ?? null,
      getUser: (k) => users[k] ?? null,
      getFocused: () => focused,
    },
    editReply: async (p) => { edits.push(p); return p },
    respond: async (c) => { responses.push(c) },
  }
}
const shown = (it) => JSON.stringify(it.edits[0].embeds?.[0]?.toJSON?.() ?? {})

// ------------------------------------------------------------- the command ----

test('the command is /time-report with person, project, task and a range of today, week, month, all', () => {
  const json = data.toJSON()
  assert.equal(json.name, 'time-report')
  const by = Object.fromEntries(json.options.map((o) => [o.name, o]))
  assert.equal(by.person.type, 6) // USER
  assert.equal(by.project.type, 3)
  assert.equal(by.project.autocomplete, true)
  assert.equal(by.task.type, 3)
  assert.equal(by.task.autocomplete, true)
  assert.deepEqual(by.range.choices.map((c) => c.value), ['today', 'week', 'month', 'all'])
  for (const o of json.options) assert.notEqual(o.required, true, `${o.name} is optional`)
})

test('a non-leadership caller is refused and no data is read', async () => {
  const db = fakeDb({ entries: [entry({ taskId: 'H', discordId: 'u1' })] })
  const it = fakeInteraction({}, { member: PLAIN })
  await execute(it, { db, getConfig, now: NOW })
  assert.equal(it.edits[0].content, "Only CEO and Server Manager can view the team's time.")
  assert.deepEqual(db.reads, [], 'not one db.clockEntry / db.task / db.project call')
})

test('a server that is not set up is told to run /init', async () => {
  const it = fakeInteraction({}, { member: ADMIN })
  await execute(it, { db: fakeDb(), getConfig: async () => null, now: NOW })
  assert.match(it.edits[0].content, /\/init/)
})

test('leadership reads this week by default, scoped to the guild config', async () => {
  const db = fakeDb({
    entries: [entry({ taskId: 'H', discordId: 'u1', minutes: 300 }), entry({ taskId: 'H', discordId: 'u2', minutes: 120 })],
    tasks: [{ id: 'H', title: 'My feature', estimateMinutes: 480, projectId: null }],
  })
  const it = fakeInteraction({}, { member: ADMIN })
  await execute(it, { db, getConfig, now: NOW })
  const find = db.reads.find((r) => r[0] === 'clockEntry.findMany')[1]
  assert.equal(find.where.guildConfigId, 'g1')
  assert.equal(find.where.since.toISOString(), '2026-09-21T00:00:00.000Z')
  assert.equal(find.take, 2000)
  assert.ok(!('discordId' in find.where) && !('taskId' in find.where))
  assert.match(shown(it), /this week/)
  assert.match(shown(it), /7h/)
})

test('the person and task options narrow the read; the range widens it', async () => {
  const db = fakeDb({ entries: [entry({ taskId: 'H', discordId: 'u2' })], tasks: [{ id: 'H', title: 'My feature' }] })
  const it = fakeInteraction({ task: 'H', range: 'all' }, { member: ADMIN, users: { person: { id: 'u2' } } })
  await execute(it, { db, getConfig, now: NOW })
  const find = db.reads.find((r) => r[0] === 'clockEntry.findMany')[1]
  assert.equal(find.where.discordId, 'u2')
  assert.equal(find.where.taskId, 'H')
  assert.equal(find.where.since.getTime(), 0)
  assert.match(shown(it), /all time/)
})

test('the project option keeps only entries whose task is in that project', async () => {
  const db = fakeDb({
    entries: [
      entry({ taskId: 'A', discordId: 'u1', minutes: 60 }),
      entry({ taskId: 'B', discordId: 'u1', minutes: 120 }),
      entry({ taskId: null, discordId: 'u1', minutes: 30 }),
      entry({ taskId: 'GONE', discordId: 'u1', minutes: 15 }),
    ],
    tasks: [{ id: 'A', title: 'In alpha', projectId: 'p1' }, { id: 'B', title: 'In beta', projectId: 'p2' }],
    projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }],
  })
  const it = fakeInteraction({ project: 'p1' }, { member: ADMIN })
  await execute(it, { db, getConfig, now: NOW })
  const t = shown(it)
  assert.match(t, /In alpha/)
  assert.doesNotMatch(t, /In beta/)
  assert.match(t, /Total this week: 1h/)
})

test('the GENERAL task choice means general work only: entries with no task', async () => {
  const db = fakeDb({
    entries: [entry({ taskId: null, discordId: 'u1', minutes: 30 }), entry({ taskId: 'A', discordId: 'u1', minutes: 60 })],
    tasks: [{ id: 'A', title: 'In alpha', projectId: 'p1' }],
  })
  const it = fakeInteraction({ task: GENERAL }, { member: ADMIN })
  await execute(it, { db, getConfig, now: NOW })
  const find = db.reads.find((r) => r[0] === 'clockEntry.findMany')[1]
  assert.ok(!('taskId' in find.where), 'the read is not narrowed by the sentinel')
  assert.match(shown(it), /General work/)
  assert.match(shown(it), /Total this week: 30m/)
  assert.doesNotMatch(shown(it), /In alpha/)
})

test('exactly 2000 rows adds the truncation note; fewer does not', async () => {
  const many = Array.from({ length: 2000 }, () => entry({ taskId: null, discordId: 'u1', minutes: 1 }))
  const it = fakeInteraction({}, { member: ADMIN })
  await execute(it, { db: fakeDb({ entries: many }), getConfig, now: NOW })
  assert.match(shown(it), /Limited to the latest 2000 entries — narrow the range\./)

  const it2 = fakeInteraction({}, { member: ADMIN })
  await execute(it2, { db: fakeDb({ entries: many.slice(0, 1999) }), getConfig, now: NOW })
  assert.doesNotMatch(shown(it2), /Limited to the latest/)
})

test('a running timer is not counted, and the report says so', async () => {
  const db = fakeDb({
    entries: [entry({ taskId: null, discordId: 'u1', minutes: 60 }), entry({ taskId: null, discordId: 'u2', minutes: null, clockOutAt: null })],
  })
  const it = fakeInteraction({}, { member: ADMIN })
  await execute(it, { db, getConfig, now: NOW })
  assert.match(shown(it), /Total this week: 1h/)
  assert.match(shown(it), /1 timer still running/)
})

test('a very long total is reported, never refused or capped', async () => {
  const db = fakeDb({ entries: [entry({ taskId: null, discordId: 'u1', minutes: 60 * 900 })] })
  const it = fakeInteraction({}, { member: ADMIN })
  await execute(it, { db, getConfig, now: NOW })
  assert.match(shown(it), /900h/)
})

// -------------------------------------------------------------- autocomplete ----

test('autocomplete dispatches on the focused option', async () => {
  const projects = [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }]
  const db = {
    ...fakeDb({ projects }),
    task: { findMany: async () => [] },
    projectMember: { findByMember: async () => [] },
  }
  const focusedOf = (name, value = '') => {
    const it = fakeInteraction({}, { member: ADMIN })
    it.options.getFocused = (full) => (full ? { name, value } : value)
    return it
  }

  const p = focusedOf('project', 'alp')
  await autocomplete(p, { db, getConfig })
  assert.deepEqual(p.responses[0], [{ name: 'Alpha', value: 'p1' }], 'project choices, without the detach entry')

  const t = focusedOf('task')
  await autocomplete(t, { db, getConfig })
  assert.equal(t.responses[0][0].value, GENERAL, 'the clock-in picker leads with general work')

  const other = focusedOf('range')
  await autocomplete(other, { db, getConfig })
  assert.deepEqual(other.responses[0], [])
})

// ------------------------------------------------------------------- payload ----

test('leadership gets totals per person and per task, with estimate comparison', () => {
  const p = buildReportPayload({
    entries: [
      { taskId: 'H', discordId: 'u1', minutes: 300 },
      { taskId: 'H', discordId: 'u2', minutes: 120 },
    ],
    tasks: [{ id: 'H', title: 'My feature', estimateMinutes: 480 }],
    projects: [], filters: { label: 'this week' }, nameFor,
  })
  const t = text(p)
  assert.match(t, /Ana/)
  assert.match(t, /5h/)
  assert.match(t, /7h of 8h/)
  assert.match(t, /88%/)
  assert.doesNotMatch(t, /over/i)
})

test('a task that is over its estimate is flagged', () => {
  const p = buildReportPayload({
    entries: [{ taskId: 'H', discordId: 'u1', minutes: 600 }],
    tasks: [{ id: 'H', title: 'My feature', estimateMinutes: 480 }],
    projects: [], filters: { label: 'this week' }, nameFor: () => 'Ana',
  })
  const t = text(p)
  assert.match(t, /10h of 8h/)
  assert.match(t, /125%/)
  assert.match(t, /over/i)
})

test('people and projects are ordered largest first; missing projects and general work get their own rows', () => {
  const p = buildReportPayload({
    entries: [
      { taskId: 'A', discordId: 'u1', minutes: 60 },
      { taskId: 'B', discordId: 'u2', minutes: 240 },
      { taskId: 'N', discordId: 'u2', minutes: 30 },
      { taskId: null, discordId: 'u1', minutes: 20 },
    ],
    tasks: [
      { id: 'A', title: 'Alpha task', projectId: 'p1' },
      { id: 'B', title: 'Beta task', projectId: 'p2' },
      { id: 'N', title: 'Loose task', projectId: null },
    ],
    projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }],
    filters: { label: 'this week' }, nameFor,
  })
  const fields = Object.fromEntries(p.embeds[0].toJSON().fields.map((f) => [f.name, f.value]))
  const people = fields['By person']
  assert.ok(people.indexOf('Ben') < people.indexOf('Ana'), 'Ben (4h 30m) before Ana (1h 20m)')
  const projects = fields['By project']
  assert.ok(projects.indexOf('Beta') < projects.indexOf('Alpha'))
  assert.match(projects, /No project/)
  assert.match(projects, /General work/)
})

test('a person with no display name is shown as a mention inside a field, never in the title', () => {
  const p = buildReportPayload({
    entries: [{ taskId: null, discordId: '123', minutes: 60 }],
    tasks: [], projects: [], filters: { label: 'today' }, nameFor: () => null,
  })
  const json = p.embeds[0].toJSON()
  assert.match(json.fields.find((f) => f.name === 'By person').value, /<@123>/)
  assert.doesNotMatch(json.title, /<@/)
})

test('each list is capped at 10 with an "and N more" tail', () => {
  const entries = []
  const tasks = []
  for (let i = 1; i <= 13; i += 1) {
    entries.push({ taskId: `t${i}`, discordId: `user${i}`, minutes: i * 10 })
    tasks.push({ id: `t${i}`, title: `Task number ${i}`, projectId: `p${i}` })
  }
  const projects = tasks.map((t) => ({ id: t.projectId, name: `Project ${t.projectId}` }))
  const p = buildReportPayload({ entries, tasks, projects, filters: { label: 'this week' }, nameFor: (id) => `Name ${id}` })
  for (const f of p.embeds[0].toJSON().fields) {
    assert.equal(f.value.split('\n').filter((l) => l.startsWith('•')).length, 10, `${f.name} lists 10`)
    assert.match(f.value, /…and 3 more/, f.name)
    assert.ok(f.value.length <= 1024)
  }
  // The biggest is kept, the smallest dropped.
  assert.match(text(p), /Task number 13/)
  assert.doesNotMatch(text(p), /Task number 1\b/)
})

test('an empty report says so', () => {
  const p = buildReportPayload({ entries: [], tasks: [], projects: [], filters: { label: 'this week' }, nameFor })
  assert.match(text(p), /No time logged for these filters\./)
  assert.equal(p.embeds[0].toJSON().fields ?? undefined, undefined)
})

test('open entries are ignored by the report', () => {
  const p = buildReportPayload({
    entries: [{ taskId: null, discordId: 'u1', minutes: null }],
    tasks: [], projects: [], filters: { label: 'this week' }, nameFor,
  })
  assert.match(text(p), /No time logged for these filters\./)
})

test('a deleted task is labelled and its time goes under No project', () => {
  const p = buildReportPayload({
    entries: [{ taskId: 'GONE', discordId: 'u1', minutes: 90 }],
    tasks: [], projects: [], filters: { label: 'this week' }, nameFor,
  })
  const t = text(p)
  assert.match(t, /Deleted task/)
  assert.match(t, /No project/)
  assert.match(t, /1h 30m/)
})

test('general work is counted for the person and the total but is not a task row', () => {
  const p = buildReportPayload({
    entries: [{ taskId: null, discordId: 'u1', minutes: 45 }],
    tasks: [], projects: [], filters: { label: 'today' }, nameFor,
  })
  const fields = Object.fromEntries(p.embeds[0].toJSON().fields.map((f) => [f.name, f.value]))
  assert.match(fields['By person'], /Ana/)
  assert.match(fields['By project'], /General work/)
  assert.equal(fields['Top tasks'], undefined)
  assert.match(text(p), /Total today: 45m/)
})

test('a 100-character task title stays inside the field limits', () => {
  const title = 'x'.repeat(100)
  const p = buildReportPayload({
    entries: Array.from({ length: 10 }, (_, i) => ({ taskId: `t${i}`, discordId: 'u1', minutes: 60 + i })),
    tasks: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, title, estimateMinutes: 30, projectId: null })),
    projects: [], filters: { label: 'this week' }, nameFor,
  })
  const json = p.embeds[0].toJSON()
  for (const f of json.fields) assert.ok(f.value.length <= 1024, `${f.name} is ${f.value.length}`)
  assert.ok(JSON.stringify(json).length < 6000)
})

// ------------------------------------------------- fix round 1: gate and tail ----

test('autocomplete for a non-leader is empty and reads nothing but the config, for project and task', async () => {
  const reads = []
  const spy = (name) => new Proxy({}, { get: (_, method) => async () => { reads.push(`${name}.${String(method)}`); return [] } })
  const db = { clockEntry: spy('clockEntry'), task: spy('task'), project: spy('project'), projectMember: spy('projectMember') }
  let configReads = 0
  const cfgSpy = async () => { configReads += 1; return { id: 'g1', timezone: 'UTC' } }
  for (const name of ['project', 'task', 'range']) {
    const it = fakeInteraction({}, { member: PLAIN })
    it.options.getFocused = (full) => (full ? { name, value: '' } : '')
    await autocomplete(it, { db, getConfig: cfgSpy })
    assert.deepEqual(it.responses, [[]], `${name}: an empty list`)
  }
  assert.deepEqual(reads, [], 'no db.clockEntry / db.task / db.project / db.projectMember call')
  assert.ok(configReads >= 1, 'the config is read to evaluate the gate')
})

test('autocomplete for a server that is not set up is empty', async () => {
  const it = fakeInteraction({}, { member: ADMIN })
  it.options.getFocused = (full) => (full ? { name: 'project', value: '' } : '')
  await autocomplete(it, { db: fakeDb(), getConfig: async () => null })
  assert.deepEqual(it.responses, [[]])
})

test('the "and N more" tail survives worst-case lines, N is truthful, and no line is cut', () => {
  const N = 14
  const title = 'w'.repeat(100)
  const entries = Array.from({ length: N }, (_, i) => ({ taskId: `t${i}`, discordId: 'u1', minutes: (1234 + i) * 60 + 59 }))
  const tasks = Array.from({ length: N }, (_, i) => ({ id: `t${i}`, title, estimateMinutes: 480, projectId: null }))
  const p = buildReportPayload({ entries, tasks, projects: [], filters: { label: 'this week' }, nameFor })
  const field = p.embeds[0].toJSON().fields.find((f) => f.name === 'Top tasks')
  assert.ok(field.value.length <= 1024, `is ${field.value.length}`)
  const lines = field.value.split('\n')
  const tail = lines.pop()
  const m = tail.match(/^…and (\d+) more$/)
  assert.ok(m, `the tail is present: ${tail}`)
  assert.ok(lines.length < 10, 'a line was dropped to make room')
  assert.equal(Number(m[1]), N - lines.length, 'N is the total minus the lines shown')
  for (const l of lines) {
    assert.ok(l.startsWith('•') && l.endsWith('**over**'), `line is whole: ${l}`)
    assert.equal((l.match(/\*\*/g) || []).length % 2, 0, `balanced ** in: ${l}`)
  }
})

test('a list of 10 or fewer lines that is too long still keeps a truthful tail', () => {
  const N = 10
  const entries = Array.from({ length: N }, (_, i) => ({ taskId: `t${i}`, discordId: 'u1', minutes: (1234 + i) * 60 + 59 }))
  const tasks = Array.from({ length: N }, (_, i) => ({ id: `t${i}`, title: 'w'.repeat(100), estimateMinutes: 480, projectId: null }))
  const p = buildReportPayload({ entries, tasks, projects: [], filters: { label: 'this week' }, nameFor })
  const field = p.embeds[0].toJSON().fields.find((f) => f.name === 'Top tasks')
  assert.ok(field.value.length <= 1024)
  const lines = field.value.split('\n')
  const m = lines.pop().match(/^…and (\d+) more$/)
  assert.ok(m)
  assert.equal(Number(m[1]), N - lines.length)
})
