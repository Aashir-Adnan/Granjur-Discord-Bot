import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runClockWatchPass, handleClockButton } from './clockWatch.js'
import { closeEntry } from '../commands/clock-in.js'

// Every test passes a fake db and a fake client. Nothing here can reach the
// real database or Discord (the repo's .env points at production).

const START = new Date('2026-09-22T00:00:00Z')
const at = (h) => new Date(START.getTime() + h * 3600000)

function fakeWatchDb(entries, cfgOverrides = {}, { tasks = [{ id: 'H', title: 'My feature' }], gate = null } = {}) {
  const rows = entries.map((e) => ({ guildConfigId: 'gc1', clockOutAt: null, remindedAt: null, taskId: null, ...e }))
  const calls = { findOpen: [], cfgReads: 0 }
  const cfg = { id: 'gc1', guildId: 'guild1', clockedInRoleId: 'role1', clockReminderHours: null, clockCapHours: null, ...cfgOverrides }
  return {
    rows, calls,
    clockEntry: {
      findOpen: async (...args) => {
        calls.findOpen.push(args)
        if (gate) await gate
        return rows.filter((r) => !r.clockOutAt)
      },
      findById: async (id) => rows.find((r) => r.id === id) ?? null,
      update: async (id, data) => { const row = rows.find((r) => r.id === id); Object.assign(row, data); return row },
    },
    guildConfig: { findById: async (id) => { calls.cfgReads += 1; return id === cfg.id ? cfg : null } },
    task: { findFirst: async ({ where }) => tasks.find((t) => t.id === where.id) ?? null },
  }
}

function fakeClient({ dmFail = new Set(), dmFailOnSend = new Set(), noGuild = false, noMember = false } = {}) {
  const sent = []
  const removed = []
  const guild = {
    members: {
      fetch: async (id) => (noMember ? Promise.reject(new Error('unknown member')) : { roles: { remove: async (r) => { removed.push([id, r]) } } }),
    },
  }
  return {
    sent, removed,
    users: {
      fetch: async (id) => {
        if (dmFail.has(id)) throw new Error('cannot DM')
        return { send: async (p) => { if (dmFailOnSend.has(id)) throw new Error('DMs closed'); sent.push({ to: id, ...p }) } }
      },
    },
    guilds: { cache: new Map(noGuild ? [] : [['guild1', guild]]) },
  }
}

function fakeButton(customId, userId, client = fakeClient()) {
  const edits = []
  return {
    edits, customId, client,
    user: { id: userId },
    guild: null, // buttons arrive from a DM
    deferred: true,
    replied: false,
    editReply: async (p) => { edits.push(p); return p },
    update: async () => { throw new Error('the button was auto-deferred; must editReply') },
  }
}

async function quietly(fn) {
  const orig = console.error
  console.error = () => {}
  try { return await fn() } finally { console.error = orig }
}

test('an entry past the reminder hour is DM\'d once, with both buttons', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: START }])
  const client = fakeClient()
  await runClockWatchPass(client, { db, now: at(7) })
  assert.equal(client.sent.length, 1)
  const ids = client.sent[0].components[0].toJSON().components.map((c) => c.custom_id)
  assert.deepEqual(ids, ['clk_keep:e1', 'clk_stop:e1'])
  assert.match(client.sent[0].content, /Still on \*\*My feature\*\*\? It's been 7h\./)
  assert.ok(db.rows[0].remindedAt, 'remindedAt is stamped so it is not sent again')
  assert.equal(db.rows[0].clockOutAt, null, 'a reminder does not close anything')

  await runClockWatchPass(client, { db, now: at(8) })
  assert.equal(client.sent.length, 1, 'not reminded twice')
})

test('findOpen is called with no arguments and each guild config is read once per pass', async () => {
  const db = fakeWatchDb([
    { id: 'e1', discordId: 'u1', clockInAt: at(1) },
    { id: 'e2', discordId: 'u2', clockInAt: at(1) },
    { id: 'e3', discordId: 'u3', clockInAt: at(1) },
  ])
  await runClockWatchPass(fakeClient(), { db, now: at(2) })
  assert.deepEqual(db.calls.findOpen, [[]])
  assert.equal(db.calls.cfgReads, 1)
})

test('nothing happens before the reminder hour', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: START }])
  const client = fakeClient()
  await runClockWatchPass(client, { db, now: at(5.9) })
  assert.equal(client.sent.length, 0)
  assert.equal(db.rows[0].remindedAt, null)
  assert.equal(db.rows[0].clockOutAt, null)
})

test('general work (no task) reads sensibly, and a deleted task says so', async () => {
  const db = fakeWatchDb([
    { id: 'e1', discordId: 'u1', taskId: null, clockInAt: START },
    { id: 'e2', discordId: 'u2', taskId: 'GONE', clockInAt: START },
  ])
  const client = fakeClient()
  await runClockWatchPass(client, { db, now: at(6.5) })
  const byUser = Object.fromEntries(client.sent.map((s) => [s.to, s.content]))
  assert.equal(byUser.u1, 'Still clocked in? It\'s been 6h 30m.')
  assert.equal(byUser.u2, 'Still on **a task that no longer exists**? It\'s been 6h 30m.')
})

test('an entry past the cap is closed AT the cap and marked auto_stopped', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: START }])
  const client = fakeClient()
  await runClockWatchPass(client, { db, now: at(20) })
  const row = db.rows[0]
  assert.equal(new Date(row.clockOutAt).toISOString(), '2026-09-22T12:00:00.000Z', 'closed at the cap, not at now')
  assert.equal(row.minutes, 720)
  assert.equal(row.source, 'auto_stopped')
  assert.equal(client.sent.length, 1)
  assert.equal(client.sent[0].content, 'Your timer on **My feature** was stopped automatically after 12h. If that is wrong, fix it with **/log-time**.')
  assert.equal(client.sent[0].components, undefined, 'the stop notice carries no buttons')
})

test('a real clock-out landing between findOpen and the cap-close write is not overwritten', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: START }])
  // findOpen returns a snapshot copy, like a real query result. The stored row
  // is then closed by a genuine /clock-out AFTER that snapshot is taken but
  // before this pass reaches the entry.
  const originalFindOpen = db.clockEntry.findOpen
  db.clockEntry.findOpen = async (...args) => {
    const snapshot = (await originalFindOpen(...args)).map((r) => ({ ...r }))
    db.rows[0].clockOutAt = new Date('2026-09-22T05:00:00Z')
    db.rows[0].minutes = 300
    return snapshot
  }
  const client = fakeClient()
  await runClockWatchPass(client, { db, now: at(20) })
  assert.equal(new Date(db.rows[0].clockOutAt).toISOString(), '2026-09-22T05:00:00.000Z', 'the real clock-out is not overwritten')
  assert.equal(db.rows[0].minutes, 300)
  assert.notEqual(db.rows[0].source, 'auto_stopped')
  assert.deepEqual(client.removed, [], 'the role is not stripped for an entry the watcher did not actually close')
  assert.equal(client.sent.length, 0, 'no auto-stop DM for an entry the watcher left alone')
})

test('the cap message for general work does not name a task', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', taskId: null, clockInAt: START }])
  const client = fakeClient()
  await runClockWatchPass(client, { db, now: at(13) })
  assert.match(client.sent[0].content, /^Your timer was stopped automatically after 12h\./)
})

test('the guild config can override the cap', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: START }], { clockCapHours: 2 })
  await runClockWatchPass(fakeClient(), { db, now: at(3) })
  assert.equal(db.rows[0].source, 'auto_stopped')
  assert.equal(db.rows[0].minutes, 120)
  assert.equal(new Date(db.rows[0].clockOutAt).toISOString(), '2026-09-22T02:00:00.000Z')
})

test('the guild config can override the reminder hour', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: START }], { clockReminderHours: 1 })
  const client = fakeClient()
  await runClockWatchPass(client, { db, now: at(1.5) })
  assert.equal(client.sent.length, 1, 'reminded after the configured hour, not the default 6')
  assert.equal(db.rows[0].clockOutAt, null)
})

test('a null override means the defaults', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: START }], { clockReminderHours: null, clockCapHours: null })
  const client = fakeClient()
  await runClockWatchPass(client, { db, now: at(11) })
  assert.equal(client.sent.length, 1)
  assert.equal(db.rows[0].clockOutAt, null, 'not capped at 11h')
})

test('closeEntry at a past time, source auto_stopped, records the minutes up to that time', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: START }])
  const minutes = await closeEntry(db, db.rows[0], { at: at(12), source: 'auto_stopped' })
  assert.equal(minutes, 720)
  assert.equal(db.rows[0].minutes, 720)
  assert.equal(db.rows[0].source, 'auto_stopped')
  assert.equal(new Date(db.rows[0].clockOutAt).toISOString(), '2026-09-22T12:00:00.000Z')
})

test('one failing DM never stops the rest of the pass, and the close still happens', async () => {
  const db = fakeWatchDb([
    { id: 'e1', discordId: 'bad', clockInAt: START },
    { id: 'e2', discordId: 'u2', clockInAt: START },
    { id: 'e3', discordId: 'bad2', clockInAt: START },
  ])
  const client = fakeClient({ dmFail: new Set(['bad']), dmFailOnSend: new Set(['bad2']) })
  await quietly(() => runClockWatchPass(client, { db, now: at(20) }))
  for (const row of db.rows) assert.equal(row.source, 'auto_stopped', `${row.id} is closed even though a DM failed`)
  assert.equal(client.sent.length, 1)
  assert.equal(client.sent[0].to, 'u2')
})

test('remindedAt is stamped even when the reminder DM throws, so it is not retried', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'closed-dms', clockInAt: START }])
  const client = fakeClient({ dmFail: new Set(['closed-dms']) })
  await quietly(() => runClockWatchPass(client, { db, now: at(7) }))
  assert.ok(db.rows[0].remindedAt)
  assert.equal(db.rows[0].clockOutAt, null)

  let fetches = 0
  const orig = client.users.fetch
  client.users.fetch = async (id) => { fetches += 1; return orig(id) }
  await quietly(() => runClockWatchPass(client, { db, now: at(8) }))
  assert.equal(fetches, 0, 'no second attempt')
})

test('one entry that blows up (even in the database) never stops the rest of the pass', async () => {
  const db = fakeWatchDb([
    { id: 'e1', discordId: 'u1', clockInAt: START },
    { id: 'e2', discordId: 'u2', clockInAt: START },
  ])
  const realUpdate = db.clockEntry.update
  db.clockEntry.update = async (id, data) => { if (id === 'e1') throw new Error('db hiccup'); return realUpdate(id, data) }
  await quietly(() => runClockWatchPass(fakeClient(), { db, now: at(20) }))
  assert.equal(db.rows[0].clockOutAt, null)
  assert.equal(db.rows[1].source, 'auto_stopped')
})

test('the clocked-in role is removed when the cap stops a timer, even if the DM failed', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: START }])
  const client = fakeClient({ dmFail: new Set(['u1']) })
  await quietly(() => runClockWatchPass(client, { db, now: at(13) }))
  assert.deepEqual(client.removed, [['u1', 'role1']])
})

test('a reminder never touches the role', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: START }])
  const client = fakeClient()
  await runClockWatchPass(client, { db, now: at(7) })
  assert.deepEqual(client.removed, [])
})

test('an unresolvable guild or member, or no configured role, skips the role silently', async () => {
  for (const [label, client, cfg] of [
    ['no guild', fakeClient({ noGuild: true }), {}],
    ['no member', fakeClient({ noMember: true }), {}],
    ['no role configured', fakeClient(), { clockedInRoleId: null }],
  ]) {
    const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: START }], cfg)
    await runClockWatchPass(client, { db, now: at(13) })
    assert.equal(db.rows[0].source, 'auto_stopped', label)
    assert.deepEqual(client.removed, [], label)
  }
})

test('a second pass that overlaps a running one is skipped', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: START }], {}, { gate })
  const client = fakeClient()
  const first = runClockWatchPass(client, { db, now: at(7) })
  const second = await runClockWatchPass(client, { db, now: at(7) })
  assert.equal(second.skipped, true)
  assert.equal(db.calls.findOpen.length, 1, 'the overlapping pass never read the database')
  release()
  await first
  assert.equal(client.sent.length, 1)

  const third = await runClockWatchPass(client, { db, now: at(8) })
  assert.notEqual(third.skipped, true, 'the guard is released once the pass finishes')
})

test('the guard is released even when a pass fails', async () => {
  const db = fakeWatchDb([])
  db.clockEntry.findOpen = async () => { throw new Error('db down') }
  await assert.rejects(() => runClockWatchPass(fakeClient(), { db, now: at(1) }))
  db.clockEntry.findOpen = async () => []
  const again = await runClockWatchPass(fakeClient(), { db, now: at(1) })
  assert.notEqual(again.skipped, true)
})

// ---- buttons -------------------------------------------------------------

test('Stop now closes the entry, removes the role and reports the session', async () => {
  const realNow = Date.now
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: new Date(realNow() - 3 * 3600000) }])
  const client = fakeClient()
  const it = fakeButton('clk_stop:e1', 'u1', client)
  await handleClockButton(it, { db })
  assert.ok(db.rows[0].clockOutAt)
  assert.equal(db.rows[0].source, undefined, 'a manual stop stays a timer entry')
  assert.equal(db.rows[0].minutes, 180)
  assert.deepEqual(client.removed, [['u1', 'role1']])
  assert.equal(it.edits.length, 1)
  assert.deepEqual(it.edits[0].components, [])
  assert.match(it.edits[0].content, /3h/)
})

test('Keep going changes nothing, and leaves the role alone', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: new Date(Date.now() - 3600000) }])
  const client = fakeClient()
  const it = fakeButton('clk_keep:e1', 'u1', client)
  await handleClockButton(it, { db })
  assert.equal(db.rows[0].clockOutAt, null)
  assert.deepEqual(client.removed, [])
  assert.match(it.edits[0].content, /Still running/)
  assert.deepEqual(it.edits[0].components, [])
})

test('a button pressed by somebody else does nothing', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: new Date() }])
  const client = fakeClient()
  const it = fakeButton('clk_stop:e1', 'someone-else', client)
  await handleClockButton(it, { db })
  assert.equal(db.rows[0].clockOutAt, null)
  assert.deepEqual(client.removed, [])
  assert.equal(it.edits.length, 1)
  assert.match(it.edits[0].content, /not yours|not your/i)
})

test('a button for a missing entry does nothing', async () => {
  const db = fakeWatchDb([])
  const it = fakeButton('clk_stop:nope', 'u1')
  await handleClockButton(it, { db })
  assert.equal(it.edits.length, 1)
  assert.match(it.edits[0].content, /not found|no longer/i)
})

test('a button on an already-closed entry says so and changes nothing', async () => {
  const closed = new Date('2026-09-22T01:00:00Z')
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: START, clockOutAt: closed, minutes: 60 }])
  const client = fakeClient()
  for (const id of ['clk_stop:e1', 'clk_keep:e1']) {
    const it = fakeButton(id, 'u1', client)
    await handleClockButton(it, { db })
    assert.equal(it.edits[0].content, 'That timer is already stopped.')
  }
  assert.equal(db.rows[0].clockOutAt, closed)
  assert.equal(db.rows[0].minutes, 60)
  assert.deepEqual(client.removed, [])
})

test('the buttons never assume a guild (they arrive from a DM)', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: new Date(Date.now() - 60000) }], { guildId: 'unknown-guild' })
  const it = fakeButton('clk_stop:e1', 'u1')
  assert.equal(it.guild, null)
  await handleClockButton(it, { db })
  assert.ok(db.rows[0].clockOutAt, 'still closes when the guild cannot be resolved')
})
