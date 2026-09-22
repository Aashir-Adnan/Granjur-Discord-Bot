import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMyTimePayload, buildEditModal, showTimePanel, handleTimeComponent, handleTimeEditSubmit } from './timePanel.js'

// Every test passes fakes for db and getConfig. Nothing here may reach the real
// db export or the real getOrCreateGuildConfig: the root .env points at production.

const NOW = new Date('2026-09-22T12:00:00Z') // a Tuesday
const entries = [
  { id: 'e1', guildConfigId: 'g1', taskId: 'H', discordId: 'u1', minutes: 90, clockInAt: new Date('2026-09-22T09:00:00Z'), clockOutAt: new Date('2026-09-22T10:30:00Z'), source: 'timer' },
  { id: 'e2', guildConfigId: 'g1', taskId: null, discordId: 'u1', minutes: 30, clockInAt: new Date('2026-09-22T11:00:00Z'), clockOutAt: new Date('2026-09-22T11:30:00Z'), source: 'manual' },
  { id: 'e3', guildConfigId: 'g1', taskId: 'H', discordId: 'u1', minutes: 60, clockInAt: new Date('2026-09-21T09:00:00Z'), clockOutAt: new Date('2026-09-21T10:00:00Z'), source: 'auto_stopped' },
]
const HELD = { id: 'H', guildConfigId: 'g1', title: 'My feature' }
const tasks = [HELD]
const json = (p) => p.components.map((r) => r.toJSON())
const embedText = (p) => JSON.stringify(p.embeds[0].toJSON())
const idsOf = (p) => json(p).flatMap((r) => r.components.map((c) => c.custom_id))

const getConfig = async () => ({ id: 'g1', timezone: 'UTC' })
const PLAIN = { permissions: { has: () => false }, roles: { cache: { some: () => false } } }
const ADMIN = { permissions: { has: (p) => p === 'Administrator' }, roles: { cache: { some: () => false } } }

function fakeDb({ rows = entries, taskRows = tasks, running = null } = {}) {
  const live = rows.map((r) => ({ ...r }))
  const s = { removed: [], updates: [], activity: [], finds: [], activeFor: [] }
  return {
    s, live,
    clockEntry: {
      findById: async (id) => { const r = live.find((x) => x.id === id); return r ? { ...r } : null },
      findMany: async (q) => {
        s.finds.push(q)
        const { where, take } = q
        return live
          .filter((r) => r.discordId === where.discordId && r.guildConfigId === where.guildConfigId
            && (!where.since || new Date(r.clockInAt) >= where.since)
            && (!where.until || new Date(r.clockInAt) < where.until))
          .slice(0, take)
      },
      findActive: async (guildId, discordId) => { s.activeFor.push([guildId, discordId]); return running && running.discordId === discordId ? running : null },
      update: async (id, data) => { s.updates.push([id, data]); Object.assign(live.find((x) => x.id === id), data); return null },
      remove: async (id) => { s.removed.push(id); const i = live.findIndex((x) => x.id === id); if (i >= 0) live.splice(i, 1); return { removed: 1 } },
    },
    task: {
      findFirst: async ({ where }) => taskRows.find((t) => t.id === where.id && t.guildConfigId === where.guildConfigId) ?? null,
      findByIds: async ({ where }) => taskRows.filter((t) => where.ids.includes(t.id)),
    },
    taskActivity: { add: async ({ data }) => { s.activity.push(data) } },
  }
}

function fakeInteraction({ userId = 'u1', member = PLAIN, customId = '', values, deferred = true, fields = null } = {}) {
  const sent = { edits: [], updates: [], modals: [], deferUpdates: 0, deferReplies: 0 }
  return {
    sent, customId, values, deferred, fields,
    guild: { id: 'guild1', members: { cache: new Map() } },
    user: { id: userId }, member, client: {},
    editReply: async (p) => { sent.edits.push(p); return p },
    update: async (p) => { sent.updates.push(p); return p },
    showModal: async (m) => { sent.modals.push(m) },
    deferUpdate: async function () { sent.deferUpdates += 1; this.deferred = true },
    deferReply: async function () { sent.deferReplies += 1; this.deferred = true },
    isFromMessage: () => true,
  }
}
const lastEdit = (it) => it.sent.edits[it.sent.edits.length - 1]
const noticeOf = (it) => lastEdit(it).content

// ------------------------------------------------------------------ payload ----

test('the panel totals by task, names general work, and marks an auto-stopped entry', () => {
  const p = buildMyTimePayload({ entries, tasks, running: null, range: { label: 'this week' } })
  const text = embedText(p)
  assert.match(text, /2h 30m/, 'the task total')
  assert.match(text, /General/)
  assert.match(text, /auto-stopped/i)
  assert.match(text, /manual/)
})

test('a task whose row no longer exists is labelled, not shown as an id', () => {
  const p = buildMyTimePayload({ entries, tasks: [], running: null, range: { label: 'this week' } })
  assert.match(embedText(p), /Deleted task/)
  assert.doesNotMatch(embedText(p), /\*\*H\*\*/)
})

test('a running timer leads the panel and is not offered for editing', () => {
  const running = { id: 'e9', taskId: 'H', clockInAt: new Date(NOW.getTime() - 20 * 60000) }
  const p = buildMyTimePayload({ entries, tasks, running, range: { label: 'this week' }, now: NOW })
  const d = p.embeds[0].toJSON().description
  assert.match(d, /^.{0,4}Running now: \*\*My feature\*\* — 20m/)
  assert.ok(!json(p).some((r) => r.components.some((c) => c.options?.some((o) => o.value === 'e9'))))
})

test('a running timer on general work reads "General"', () => {
  const running = { id: 'e9', taskId: null, clockInAt: new Date(NOW.getTime() - 5 * 60000) }
  const p = buildMyTimePayload({ entries: [], tasks, running, range: { label: 'today' }, now: NOW })
  assert.match(p.embeds[0].toJSON().description, /Running now: \*\*General\*\* — 5m/)
})

test('every entry can be picked for editing, within Discord limits', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ ...entries[0], id: `x${i}` }))
  const p = buildMyTimePayload({ entries: many, tasks, running: null, range: { label: 'this week' } })
  for (const row of json(p)) for (const c of row.components) {
    if (c.options) assert.ok(c.options.length <= 25)
    assert.ok(c.custom_id.length <= 100)
  }
  assert.ok(json(p).length <= 5)
  assert.ok(p.embeds[0].toJSON().fields.every((f) => f.value.length <= 1024))
})

test('only closed entries are offered, and the select carries the entry id as its value', () => {
  const open = { ...entries[0], id: 'open1', minutes: null, clockOutAt: null }
  const p = buildMyTimePayload({ entries: [open, ...entries], tasks, running: null, range: { label: 'this week' } })
  const select = json(p)[0].components[0]
  assert.equal(select.custom_id, 'mt_pick')
  assert.deepEqual(select.options.map((o) => o.value), ['e1', 'e2', 'e3'])
})

test('a picked entry is selected and gets Edit and Delete buttons that carry only its id', () => {
  const p = buildMyTimePayload({ entries, tasks, running: null, range: { label: 'this week' }, selected: entries[1] })
  assert.deepEqual(idsOf(p), ['mt_pick', 'mt_edit:e2', 'mt_delete:e2'])
  assert.equal(json(p)[0].components[0].options.find((o) => o.value === 'e2').default, true)
})

test('a picked entry outside the listed range is still selectable', () => {
  const old = { ...entries[0], id: 'old', clockInAt: new Date('2026-01-01T09:00:00Z'), clockOutAt: new Date('2026-01-01T10:30:00Z') }
  const p = buildMyTimePayload({ entries, tasks, running: null, range: { label: 'this week' }, selected: old })
  assert.ok(json(p)[0].components[0].options.some((o) => o.value === 'old' && o.default))
  assert.deepEqual(idsOf(p).slice(1), ['mt_edit:old', 'mt_delete:old'])
})

test('nothing to pick means no select, and an empty select is never sent', () => {
  const p = buildMyTimePayload({ entries: [], tasks, running: null, range: { label: 'today' } })
  assert.deepEqual(json(p), [])
})

// ---------------------------------------------------------------- the panel ----

test('the panel reads the range in the server timezone, falling back to UTC for an invalid one', async () => {
  const db = fakeDb()
  const it = fakeInteraction()
  // 20:00 UTC on Tuesday is already 01:00 on Wednesday in Karachi.
  await showTimePanel(it, { ownerId: 'u1', rangeKey: 'today' }, { db, getConfig: async () => ({ id: 'g1', timezone: 'Asia/Karachi' }), now: new Date('2026-09-22T20:00:00Z') })
  assert.equal(db.s.finds[0].where.since.toISOString(), '2026-09-22T19:00:00.000Z')

  const db2 = fakeDb()
  await showTimePanel(fakeInteraction(), { ownerId: 'u1', rangeKey: 'today' }, { db: db2, getConfig: async () => ({ id: 'g1', timezone: 'Not/AZone' }), now: new Date('2026-09-22T20:00:00Z') })
  assert.equal(db2.s.finds[0].where.since.toISOString(), '2026-09-22T00:00:00.000Z')
})

test('the panel reads the owner\'s entries capped at 2000 and their running timer', async () => {
  const db = fakeDb()
  const it = fakeInteraction()
  await showTimePanel(it, { ownerId: 'u1' }, { db, getConfig, now: NOW })
  assert.equal(db.s.finds[0].take, 2000)
  assert.equal(db.s.finds[0].where.discordId, 'u1')
  assert.equal(db.s.finds[0].where.guildConfigId, 'g1')
  assert.deepEqual(db.s.activeFor, [['guild1', 'u1']])
  // default range is this week, from Monday
  assert.equal(db.s.finds[0].where.since.toISOString(), '2026-09-21T00:00:00.000Z')
  assert.match(embedText(lastEdit(it)), /2h 30m/)
})

test('exactly 2000 rows is flagged as limited; fewer is not', async () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ ...entries[0], id: `m${i}` }))
  const full = fakeInteraction()
  await showTimePanel(full, { ownerId: 'u1' }, { db: fakeDb({ rows: mk(2000) }), getConfig, now: NOW })
  assert.match(embedText(lastEdit(full)), /Limited to the latest 2000 entries — narrow the range\./)
  const under = fakeInteraction()
  await showTimePanel(under, { ownerId: 'u1' }, { db: fakeDb({ rows: mk(1999) }), getConfig, now: NOW })
  assert.doesNotMatch(embedText(lastEdit(under)), /Limited to/)
})

test('totals are summed over every fetched entry, not only the ones listed', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ ...entries[0], id: `m${i}`, minutes: 10 }))
  const it = fakeInteraction()
  await showTimePanel(it, { ownerId: 'u1' }, { db: fakeDb({ rows }), getConfig, now: NOW })
  assert.match(embedText(lastEdit(it)), /10h/) // 60 x 10m
})

test('task titles come from findByIds for this server', async () => {
  const db = fakeDb()
  let asked
  const orig = db.task.findByIds
  db.task.findByIds = async (q) => { asked = q; return orig(q) }
  await showTimePanel(fakeInteraction(), { ownerId: 'u1' }, { db, getConfig, now: NOW })
  assert.equal(asked.where.guildConfigId, 'g1')
  assert.deepEqual([...asked.where.ids].sort(), ['H'])
})

test('a panel shown for somebody else says whose it is', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ userId: 'boss', member: ADMIN })
  it.guild.members.cache.set('u1', { displayName: 'Ana' })
  await showTimePanel(it, { ownerId: 'u1' }, { db, getConfig, now: NOW })
  assert.match(embedText(lastEdit(it)), /Ana/)
})

// ------------------------------------------------------------ component: pick ----

test('picking an entry redraws the panel with that entry selected', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ customId: 'mt_pick', values: ['e2'] })
  await handleTimeComponent(it, { db, getConfig, now: NOW })
  assert.deepEqual(idsOf(lastEdit(it)), ['mt_pick', 'mt_edit:e2', 'mt_delete:e2'])
})

test('a leader picking somebody else\'s entry sees that person\'s panel', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ userId: 'boss', member: ADMIN, customId: 'mt_pick', values: ['e2'] })
  await handleTimeComponent(it, { db, getConfig, now: NOW })
  assert.equal(db.s.finds[0].where.discordId, 'u1')
  assert.deepEqual(idsOf(lastEdit(it)), ['mt_pick', 'mt_edit:e2', 'mt_delete:e2'])
})

test('picking somebody else\'s entry is refused and shows the caller\'s own panel', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ userId: 'u2', customId: 'mt_pick', values: ['e2'] })
  await handleTimeComponent(it, { db, getConfig, now: NOW })
  assert.match(noticeOf(it), /That entry isn't yours\./)
  assert.equal(db.s.finds[0].where.discordId, 'u2')
  assert.ok(!idsOf(lastEdit(it)).includes('mt_edit:e2'))
})

test('picking a running entry is refused', async () => {
  const running = { id: 'run', guildConfigId: 'g1', taskId: 'H', discordId: 'u1', minutes: null, clockInAt: new Date(NOW.getTime() - 60000), clockOutAt: null, source: 'timer' }
  const db = fakeDb({ rows: [...entries, running] })
  const it = fakeInteraction({ customId: 'mt_pick', values: ['run'] })
  await handleTimeComponent(it, { db, getConfig, now: NOW })
  assert.match(noticeOf(it), /clock-out/)
})

test('an entry that was deleted meanwhile says so', async () => {
  const it = fakeInteraction({ customId: 'mt_pick', values: ['ghost'] })
  await handleTimeComponent(it, { db: fakeDb(), getConfig, now: NOW })
  assert.match(noticeOf(it), /no longer exists/)
})

// ---------------------------------------------------------- component: delete ----

test('deleting an entry removes it, only if it is yours', async () => {
  const db = fakeDb()
  const mine = fakeInteraction({ customId: 'mt_delete:e1' })
  await handleTimeComponent(mine, { db, getConfig, now: NOW })
  assert.deepEqual(db.s.removed, ['e1'])
  assert.match(noticeOf(mine), /Deleted/)

  const theirs = fakeInteraction({ userId: 'u2', customId: 'mt_delete:e2' })
  await handleTimeComponent(theirs, { db, getConfig, now: NOW })
  assert.deepEqual(db.s.removed, ['e1'], 'somebody else\'s entry is untouched')
  assert.match(noticeOf(theirs), /That entry isn't yours\./)
})

test('leadership can delete anybody\'s entry, and the panel redraws for its owner', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ userId: 'boss', member: ADMIN, customId: 'mt_delete:e1' })
  await handleTimeComponent(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.s.removed, ['e1'])
  assert.equal(db.s.finds[0].where.discordId, 'u1')
})

test('an entry from another server is never touched', async () => {
  const db = fakeDb({ rows: [{ ...entries[0], guildConfigId: 'other-guild' }] })
  const it = fakeInteraction({ customId: 'mt_delete:e1' })
  await handleTimeComponent(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.s.removed, [])
  assert.match(noticeOf(it), /That entry isn't yours\./)
})

test('a running entry cannot be deleted here', async () => {
  const running = { id: 'run', guildConfigId: 'g1', taskId: null, discordId: 'u1', minutes: null, clockInAt: NOW, clockOutAt: null, source: 'timer' }
  const db = fakeDb({ rows: [running] })
  const it = fakeInteraction({ customId: 'mt_delete:run' })
  await handleTimeComponent(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.s.removed, [])
})

test('deleting time on a task is written to the task activity log', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ userId: 'boss', member: ADMIN, customId: 'mt_delete:e1' })
  await handleTimeComponent(it, { db, getConfig, now: NOW })
  assert.equal(db.s.activity.length, 1)
  assert.deepEqual(db.s.activity[0], {
    guildConfigId: 'g1', taskId: 'H', actorDiscordId: 'boss', actorLabel: null,
    changes: [{ field: 'time', action: 'deleted', minutes: 90, personId: 'u1' }],
  })
})

test('deleting general work, or time on a task that is gone, writes no activity', async () => {
  const db = fakeDb()
  await handleTimeComponent(fakeInteraction({ customId: 'mt_delete:e2' }), { db, getConfig, now: NOW })
  assert.deepEqual(db.s.removed, ['e2'])
  assert.deepEqual(db.s.activity, [])

  const orphan = fakeDb({ taskRows: [] })
  await handleTimeComponent(fakeInteraction({ customId: 'mt_delete:e1' }), { db: orphan, getConfig, now: NOW })
  assert.deepEqual(orphan.s.removed, ['e1'])
  assert.deepEqual(orphan.s.activity, [])
})

test('a refused delete writes no activity', async () => {
  const db = fakeDb()
  await handleTimeComponent(fakeInteraction({ userId: 'u2', customId: 'mt_delete:e1' }), { db, getConfig, now: NOW })
  assert.deepEqual(db.s.activity, [])
})

test('a failing activity write does not undo or hide the delete', async () => {
  const db = fakeDb()
  db.taskActivity.add = async () => { throw new Error('boom') }
  const it = fakeInteraction({ customId: 'mt_delete:e1' })
  const orig = console.error
  console.error = () => {}
  try { await handleTimeComponent(it, { db, getConfig, now: NOW }) } finally { console.error = orig }
  assert.deepEqual(db.s.removed, ['e1'])
  assert.match(noticeOf(it), /Deleted/)
})

// ------------------------------------------------------------ component: edit ----

test('the Edit button opens a modal prefilled from the entry', async () => {
  const it = fakeInteraction({ customId: 'mt_edit:e1', deferred: false })
  const db = fakeDb({ rows: [{ ...entries[0], note: 'pairing' }] })
  await handleTimeComponent(it, { db, getConfig, now: NOW })
  const m = it.sent.modals[0].toJSON()
  assert.equal(m.custom_id, 'mt_edit:e1')
  const inputs = m.components.map((c) => c.component)
  assert.deepEqual(inputs.map((c) => c.custom_id), ['duration', 'when', 'note'])
  assert.equal(inputs[0].value, '1h 30m')
  assert.equal(inputs[1].required, false)
  assert.equal(inputs[2].value, 'pairing')
  assert.equal(inputs[2].max_length, 500)
})

test('the Edit button for somebody else\'s entry opens nothing', async () => {
  const it = fakeInteraction({ userId: 'u2', customId: 'mt_edit:e1', deferred: false })
  await handleTimeComponent(it, { db: fakeDb(), getConfig, now: NOW })
  assert.equal(it.sent.modals.length, 0)
  assert.match(it.sent.updates[0].content, /That entry isn't yours\./)
})

test('leadership can open the editor for anybody\'s entry', async () => {
  const it = fakeInteraction({ userId: 'boss', member: ADMIN, customId: 'mt_edit:e1', deferred: false })
  await handleTimeComponent(it, { db: fakeDb(), getConfig, now: NOW })
  assert.equal(it.sent.modals.length, 1)
})

test('the edit modal never puts more than a text input can hold', () => {
  const m = buildEditModal({ id: 'e1', minutes: 5, note: 'x'.repeat(900) }).toJSON()
  assert.ok(m.components[2].component.value.length <= 500)
  assert.ok(m.title.length <= 45)
})

// -------------------------------------------------------------- modal submit ----

const editFields = ({ duration = '1h 30m', when = '', note = '' } = {}) => {
  const map = { duration, when, note }
  return { getTextInputValue: (id) => map[id] }
}
const submit = (over = {}, o = {}) => fakeInteraction({ customId: 'mt_edit:e1', fields: editFields(over), ...o })

test('a new duration keeps the end and moves the start, in one update with everything together', async () => {
  const db = fakeDb()
  const it = submit({ duration: '2h' }, { deferred: false }) // as from a modal opened by a button
  await handleTimeEditSubmit(it, { db, getConfig, now: NOW })
  assert.equal(db.s.updates.length, 1)
  const [id, data] = db.s.updates[0]
  assert.equal(id, 'e1')
  assert.deepEqual(data, {
    clockInAt: new Date('2026-09-22T08:30:00Z'),
    clockOutAt: new Date('2026-09-22T10:30:00Z'),
    minutes: 120,
    note: null,
  })
  assert.match(noticeOf(it), /2h/)
  assert.equal(it.sent.deferUpdates, 1, 'the panel message is edited in place')
})

test('a day given by name moves the entry and keeps its UTC time of day', async () => {
  const db = fakeDb()
  await handleTimeEditSubmit(submit({ when: 'yesterday' }), { db, getConfig, now: NOW })
  const [, data] = db.s.updates[0]
  assert.equal(data.clockOutAt.toISOString(), '2026-09-21T10:30:00.000Z')
  assert.equal(data.clockInAt.toISOString(), '2026-09-21T09:00:00.000Z')
  assert.equal(data.minutes, 90)
})

test('a YYYY-MM-DD day moves the entry and keeps its UTC time of day', async () => {
  const db = fakeDb()
  await handleTimeEditSubmit(submit({ when: '2026-09-15', duration: '1h' }), { db, getConfig, now: NOW })
  const [, data] = db.s.updates[0]
  assert.equal(data.clockOutAt.toISOString(), '2026-09-15T10:30:00.000Z')
  assert.equal(data.clockInAt.toISOString(), '2026-09-15T09:30:00.000Z')
})

test('"today" means today, not the entry\'s own day', async () => {
  const db = fakeDb({ rows: [{ ...entries[2] }] }) // e3 ended yesterday 10:00
  await handleTimeEditSubmit(submit({ when: 'today', duration: '1h' }, { customId: 'mt_edit:e3' }), { db, getConfig, now: NOW })
  assert.equal(db.s.updates[0][1].clockOutAt.toISOString(), '2026-09-22T10:00:00.000Z')
})

test('the same input writes nothing and says so', async () => {
  const db = fakeDb()
  const it = submit()
  await handleTimeEditSubmit(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.s.updates, [])
  assert.match(noticeOf(it), /Nothing changed\./)

  const same = submit({ when: 'today' }) // same day, same time of day
  await handleTimeEditSubmit(same, { db, getConfig, now: NOW })
  assert.deepEqual(db.s.updates, [])
  assert.match(noticeOf(same), /Nothing changed\./)
})

test('an unreadable duration is refused with the accepted formats, and nothing changes', async () => {
  const db = fakeDb()
  const it = submit({ duration: 'a while' })
  await handleTimeEditSubmit(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.s.updates, [])
  assert.match(noticeOf(it), /2h30m, 90m, 2\.5h or 1:30/)
  assert.match(noticeOf(it), /^❌/)
})

test('there is no maximum duration', async () => {
  const db = fakeDb()
  await handleTimeEditSubmit(submit({ duration: '400h' }), { db, getConfig, now: NOW })
  assert.equal(db.s.updates[0][1].minutes, 24000)
})

test('a duration too large to store, or a start before year 1000, is refused', async () => {
  for (const duration of ['99999999999m', '2147483647m']) {
    const db = fakeDb()
    const it = submit({ duration })
    await handleTimeEditSubmit(it, { db, getConfig, now: NOW })
    assert.deepEqual(db.s.updates, [], duration)
    assert.match(noticeOf(it), /too large/, duration)
  }
})

test('an unreadable or impossible day is refused', async () => {
  for (const when of ['someday', '2026-02-31', '2026-13-01']) {
    const db = fakeDb()
    const it = submit({ when })
    await handleTimeEditSubmit(it, { db, getConfig, now: NOW })
    assert.deepEqual(db.s.updates, [], when)
    assert.match(noticeOf(it), /could not read that date/, when)
  }
})

test('an edit that would end in the future is refused, judged against the real now', async () => {
  const late = { ...entries[2], id: 'late', clockInAt: new Date('2026-09-21T22:30:00Z'), clockOutAt: new Date('2026-09-21T23:30:00Z') }
  const db = fakeDb({ rows: [late] })
  const it = submit({ when: 'today', duration: '1h' }, { customId: 'mt_edit:late' })
  await handleTimeEditSubmit(it, { db, getConfig, now: NOW }) // today 23:30 is after 12:00
  assert.deepEqual(db.s.updates, [])
  assert.match(noticeOf(it), /in the future/)

  const db2 = fakeDb()
  const tomorrow = submit({ when: '2026-09-23' })
  await handleTimeEditSubmit(tomorrow, { db: db2, getConfig, now: NOW })
  assert.deepEqual(db2.s.updates, [])
})

test('a note-only edit is saved, but is not a change of time so it is not recorded', async () => {
  const db = fakeDb()
  const it = submit({ note: 'reviewed the PR' })
  await handleTimeEditSubmit(it, { db, getConfig, now: NOW })
  assert.equal(db.s.updates[0][1].note, 'reviewed the PR')
  assert.equal(db.s.updates[0][1].minutes, 90)
  assert.deepEqual(db.s.activity, [])
})

test('clearing the note writes null', async () => {
  const db = fakeDb({ rows: [{ ...entries[0], note: 'old' }] })
  await handleTimeEditSubmit(submit({ note: '   ' }), { db, getConfig, now: NOW })
  assert.equal(db.s.updates[0][1].note, null)
})

test('changing the time on a task is written to the task activity log', async () => {
  const db = fakeDb()
  await handleTimeEditSubmit(submit({ duration: '2h' }), { db, getConfig, now: NOW })
  assert.deepEqual(db.s.activity, [{
    guildConfigId: 'g1', taskId: 'H', actorDiscordId: 'u1', actorLabel: null,
    changes: [{ field: 'time', action: 'edited', from: 90, to: 120, personId: 'u1' }],
  }])
})

test('a leader editing somebody else\'s entry records the owner as the person and themselves as the actor', async () => {
  const db = fakeDb()
  const it = submit({ duration: '2h' }, { userId: 'boss', member: ADMIN })
  await handleTimeEditSubmit(it, { db, getConfig, now: NOW })
  assert.equal(db.s.updates.length, 1)
  assert.equal(db.s.activity[0].actorDiscordId, 'boss')
  assert.equal(db.s.activity[0].changes[0].personId, 'u1')
  assert.equal(db.s.finds[0].where.discordId, 'u1', 'redraws for the owner')
})

test('editing general work, or an entry whose task is gone, writes no activity', async () => {
  const db = fakeDb()
  await handleTimeEditSubmit(submit({ duration: '1h' }, { customId: 'mt_edit:e2' }), { db, getConfig, now: NOW })
  assert.equal(db.s.updates.length, 1)
  assert.deepEqual(db.s.activity, [])

  const orphan = fakeDb({ taskRows: [] })
  await handleTimeEditSubmit(submit({ duration: '2h' }), { db: orphan, getConfig, now: NOW })
  assert.equal(orphan.s.updates.length, 1)
  assert.deepEqual(orphan.s.activity, [])
})

test('somebody else\'s entry cannot be edited by submitting its modal', async () => {
  const db = fakeDb()
  const it = submit({ duration: '5h' }, { userId: 'u2' })
  await handleTimeEditSubmit(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.s.updates, [])
  assert.deepEqual(db.s.activity, [])
  assert.match(noticeOf(it), /That entry isn't yours\./)
})

test('an entry from another server, or a running one, cannot be edited', async () => {
  const foreign = fakeDb({ rows: [{ ...entries[0], guildConfigId: 'other-guild' }] })
  await handleTimeEditSubmit(submit({ duration: '5h' }), { db: foreign, getConfig, now: NOW })
  assert.deepEqual(foreign.s.updates, [])

  const running = fakeDb({ rows: [{ ...entries[0], minutes: null, clockOutAt: null }] })
  await handleTimeEditSubmit(submit({ duration: '5h' }), { db: running, getConfig, now: NOW })
  assert.deepEqual(running.s.updates, [])
})

test('a failing save says so and does not record activity', async () => {
  const db = fakeDb()
  db.clockEntry.update = async () => { throw new Error('db down') }
  const it = submit({ duration: '2h' })
  const orig = console.error
  console.error = () => {}
  try { await handleTimeEditSubmit(it, { db, getConfig, now: NOW }) } finally { console.error = orig }
  assert.match(noticeOf(it), /❌/)
  assert.deepEqual(db.s.activity, [])
})
