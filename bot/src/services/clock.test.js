import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClockError, clockIn, clockOut, clockStatus, clockedInNow } from './clock.js'

// Every test passes a fake db and a fake guild. Nothing here reaches the real
// database or Discord.

const NOW = new Date('2026-09-30T12:00:00Z')
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000)

const HELD = { id: 'H', title: 'My feature', status: 'open', assigneeIds: ['u1'], projectId: 'p1' }
const TEAM = { id: 'P', title: 'Teammate task', status: 'open', assigneeIds: ['u2'], projectId: 'p1' }
const FAR = { id: 'F', title: 'Another project', status: 'open', assigneeIds: ['u2'], projectId: 'p9' }

function fakeDb({ entries = [], tasks = [HELD, TEAM], projects = [{ id: 'p1', name: 'Alpha' }], members = [], memberProjects = ['p1'] } = {}) {
  const rows = [...entries]
  const calls = []
  return {
    rows, calls,
    clockEntry: {
      findActive: async (guildId, discordId) => rows.find((r) => !r.clockOutAt && r.discordId === discordId) ?? null,
      create: async ({ data }) => { const row = { id: `e${rows.length + 1}`, ...data }; rows.push(row); calls.push(['create', row]); return row },
      update: async (id, data) => { const row = rows.find((r) => r.id === id); Object.assign(row, data); calls.push(['update', id, data]); return row },
      findMany: async ({ where }) => rows.filter((r) => r.guildConfigId === where.guildConfigId && (!where.openOnly || !r.clockOutAt)),
      sumByTask: async ({ taskIds }) => {
        const total = rows.filter((r) => r.minutes != null && taskIds.includes(r.taskId)).reduce((n, r) => n + r.minutes, 0)
        return [{ taskId: taskIds[0], discordId: 'x', minutes: total }]
      },
    },
    task: { findFirst: async ({ where }) => tasks.find((t) => t.id === where.id) ?? null },
    project: { findMany: async () => projects },
    projectMember: { findByMember: async () => memberProjects.map((projectId) => ({ projectId })) },
    guildMember: { findMany: async () => members },
  }
}

function fakeGuild({ admin = false, addFails = false, noMember = false } = {}) {
  const roleCalls = []
  const member = {
    permissions: { has: (p) => admin && p === 'Administrator' },
    roles: {
      cache: { some: () => false },
      add: async (r) => { roleCalls.push(['add', r]); if (addFails) throw new Error('no perms') },
      remove: async (r) => { roleCalls.push(['remove', r]) },
    },
  }
  return { id: 'guild1', roleCalls, members: { fetch: async () => (noMember ? null : member) } }
}

const cfg = { id: 'g1', clockedInRoleId: 'R1', timezone: 'UTC' }
const base = (db, guild, extra = {}) => ({ db, cfg, guild, discordId: 'u1', now: NOW, ...extra })

test('clockIn on general work from nothing starts an entry and adds the role once', async () => {
  const db = fakeDb(); const guild = fakeGuild()
  const res = await clockIn(base(db, guild, { taskId: null }))
  assert.equal(res.outcome, 'started')
  assert.equal(res.task, null)
  assert.equal(res.stopped, null)
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].taskId, null)
  assert.equal(db.rows[0].source, 'timer')
  assert.deepEqual(guild.roleCalls, [['add', 'R1']])
})

test('clockIn on a clockable task starts an entry carrying the task id', async () => {
  const db = fakeDb(); const guild = fakeGuild()
  const res = await clockIn(base(db, guild, { taskId: 'H' }))
  assert.equal(res.outcome, 'started')
  assert.equal(res.task.id, 'H')
  assert.equal(db.rows[0].taskId, 'H')
})

test('clockIn refuses a task outside the member\'s projects, and a missing task, writing nothing', async () => {
  const db = fakeDb({ tasks: [FAR] }); const guild = fakeGuild()
  for (const taskId of ['F', 'nope']) {
    await assert.rejects(
      clockIn(base(db, guild, { taskId })),
      (e) => e instanceof ClockError && e.message === 'That task is not available to clock in on.',
    )
  }
  assert.deepEqual(db.calls, [])
  assert.deepEqual(guild.roleCalls, [])
})

test('clockIn on the task already running changes nothing', async () => {
  const db = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: minsAgo(40), clockOutAt: null }] })
  const guild = fakeGuild()
  const res = await clockIn(base(db, guild, { taskId: 'H' }))
  assert.equal(res.outcome, 'unchanged')
  assert.equal(res.runningMinutes, 40)
  assert.equal(res.task.id, 'H')
  assert.deepEqual(db.calls, [])
  assert.deepEqual(guild.roleCalls, [])
})

test('clockIn on another task closes the open entry, starts a new one and leaves the role alone', async () => {
  const db = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: 'P', clockInAt: minsAgo(70), clockOutAt: null }] })
  const guild = fakeGuild()
  const res = await clockIn(base(db, guild, { taskId: 'H' }))
  assert.equal(res.outcome, 'switched')
  assert.deepEqual(res.stopped, { title: 'Teammate task', minutes: 70 })
  assert.equal(db.rows[0].minutes, 70)
  assert.ok(db.rows[0].clockOutAt)
  assert.equal(db.rows.length, 2)
  assert.equal(db.rows[1].taskId, 'H')
  assert.deepEqual(guild.roleCalls, [])
})

test('clockIn switching away from general work names it "general work"', async () => {
  const db = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: null, clockInAt: minsAgo(5), clockOutAt: null }] })
  const res = await clockIn(base(db, fakeGuild(), { taskId: 'H' }))
  assert.equal(res.outcome, 'switched')
  assert.equal(res.stopped.title, 'general work')
})

test('clockIn still succeeds when the role add rejects or the member cannot be fetched', async () => {
  const a = fakeDb()
  const r1 = await clockIn(base(a, fakeGuild({ addFails: true }), { taskId: null }))
  assert.equal(r1.outcome, 'started')
  assert.equal(a.rows.length, 1)
  const b = fakeDb()
  const r2 = await clockIn(base(b, fakeGuild({ noMember: true }), { taskId: null }))
  assert.equal(r2.outcome, 'started')
  assert.equal(b.rows.length, 1)
})

test('clockIn uses the member it is given and does not fetch', async () => {
  const db = fakeDb(); const guild = fakeGuild()
  guild.members.fetch = async () => { throw new Error('must not fetch') }
  const given = { permissions: { has: () => false }, roles: { cache: { some: () => false }, add: async () => {} } }
  const res = await clockIn(base(db, guild, { taskId: 'H', member: given }))
  assert.equal(res.outcome, 'started')
})

test('clockIn without a member treats a missing member as not leadership', async () => {
  const db = fakeDb({ tasks: [FAR], memberProjects: [] })
  await assert.rejects(clockIn(base(db, fakeGuild({ noMember: true }), { taskId: 'F' })), ClockError)
  const admin = await clockIn(base(db, fakeGuild({ admin: true }), { taskId: 'F' }))
  assert.equal(admin.outcome, 'started')
})

test('clockOut closes the entry, removes the role and reports the task total', async () => {
  const db = fakeDb({ entries: [
    { id: 'e0', discordId: 'u1', taskId: 'H', clockInAt: minsAgo(200), clockOutAt: minsAgo(140), minutes: 60 },
    { id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: minsAgo(30), clockOutAt: null },
  ] })
  const guild = fakeGuild()
  const res = await clockOut({ db, cfg, guild, discordId: 'u1', note: null, now: NOW })
  assert.equal(res.minutes, 30)
  assert.equal(res.task.id, 'H')
  assert.equal(res.taskTotalMinutes, 90)
  assert.equal(db.rows[1].minutes, 30)
  assert.deepEqual(guild.roleCalls, [['remove', 'R1']])
})

test('clockOut of general work has no task and no total', async () => {
  const db = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: null, clockInAt: minsAgo(20), clockOutAt: null }] })
  const res = await clockOut({ db, cfg, guild: fakeGuild(), discordId: 'u1', now: NOW })
  assert.equal(res.minutes, 20)
  assert.equal(res.task, null)
  assert.equal(res.taskTotalMinutes, null)
})

test('clockOut gives a null total when the sum fails', async () => {
  const db = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: minsAgo(20), clockOutAt: null }] })
  db.clockEntry.sumByTask = async () => { throw new Error('db down') }
  const res = await clockOut({ db, cfg, guild: fakeGuild(), discordId: 'u1', now: NOW })
  assert.equal(res.taskTotalMinutes, null)
  assert.equal(res.minutes, 20)
})

test('clockOut note is trimmed, capped at 500 and dropped when blank', async () => {
  const run = async (note) => {
    const db = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: null, clockInAt: minsAgo(5), clockOutAt: null }] })
    await clockOut({ db, cfg, guild: fakeGuild(), discordId: 'u1', note, now: NOW })
    return db.rows[0]
  }
  assert.equal((await run('  done  ')).note, 'done')
  assert.equal((await run('x'.repeat(600))).note.length, 500)
  assert.equal('note' in (await run('   ')), false)
  assert.equal('note' in (await run(undefined)), false)
})

test('clockOut with nothing open throws You are not clocked in.', async () => {
  const db = fakeDb()
  await assert.rejects(
    clockOut({ db, cfg, guild: fakeGuild(), discordId: 'u1', now: NOW }),
    (e) => e instanceof ClockError && e.message === 'You are not clocked in.',
  )
  assert.deepEqual(db.calls, [])
})

test('clockStatus: none, general work, and a task with its project', async () => {
  assert.deepEqual(await clockStatus({ db: fakeDb(), cfg, guild: fakeGuild(), discordId: 'u1', now: NOW }), { active: false })

  const general = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: null, clockInAt: minsAgo(2), clockOutAt: null }] })
  const g = await clockStatus({ db: general, cfg, guild: fakeGuild(), discordId: 'u1', now: NOW })
  assert.equal(g.active, true)
  assert.equal(g.entryId, 'e1')
  assert.equal(g.taskId, null)
  assert.equal(g.taskTitle, 'General work')
  assert.equal(g.projectName, null)
  assert.equal(g.elapsedSeconds, 120)

  const task = fakeDb({ entries: [{ id: 'e2', discordId: 'u1', taskId: 'H', clockInAt: minsAgo(1), clockOutAt: null }] })
  const t = await clockStatus({ db: task, cfg, guild: fakeGuild(), discordId: 'u1', now: NOW })
  assert.equal(t.taskTitle, 'My feature')
  assert.equal(t.projectName, 'Alpha')
  assert.equal(t.elapsedSeconds, 60)
})

test('clockStatus never reports negative elapsed time', async () => {
  const db = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: null, clockInAt: new Date(NOW.getTime() + 5000), clockOutAt: null }] })
  const s = await clockStatus({ db, cfg, guild: fakeGuild(), discordId: 'u1', now: NOW })
  assert.equal(s.elapsedSeconds, 0)
})

test('clockedInNow lists open entries longest-running first with names, falling back to the id', async () => {
  const db = fakeDb({
    entries: [
      { id: 'e1', guildConfigId: 'g1', discordId: 'u1', taskId: 'H', clockInAt: minsAgo(10), clockOutAt: null },
      { id: 'e2', guildConfigId: 'g1', discordId: 'u2', taskId: null, clockInAt: minsAgo(50), clockOutAt: null },
      { id: 'e3', guildConfigId: 'g1', discordId: 'u3', taskId: 'H', clockInAt: minsAgo(90), clockOutAt: minsAgo(80), minutes: 10 },
    ],
    members: [{ discordId: 'u1', displayName: 'Ann', avatarUrl: 'http://a/u1.png' }],
  })
  const out = await clockedInNow({ db, cfg, now: NOW })
  assert.deepEqual(out.map((r) => r.discordId), ['u2', 'u1'])
  assert.equal(out[0].name, 'u2')
  assert.equal(out[0].avatarUrl, null)
  assert.equal(out[0].taskTitle, 'General work')
  assert.equal(out[0].elapsedSeconds, 3000)
  assert.equal(out[1].name, 'Ann')
  assert.equal(out[1].avatarUrl, 'http://a/u1.png')
  assert.equal(out[1].taskTitle, 'My feature')
  assert.equal(out[1].projectId, 'p1')
  assert.equal(out[1].projectName, 'Alpha')
})

// --- a soft-deleted project -----------------------------------------------

const GONE = { id: 'p1', name: 'Alpha', deletedAt: new Date('2026-09-30T09:00:00Z') }
/** fakeDb whose project list hides a deleted project unless the read opts in, as the real one does. */
function hidingDb(opts = {}) {
  const db = fakeDb({ projects: [GONE], ...opts })
  db.project.findMany = async ({ where }) => [GONE].filter((p) => where.includeDeleted === true || !p.deletedAt)
  return db
}

test('clockIn on a task in a deleted project is refused with the sentence, and nothing starts', async () => {
  const db = hidingDb(); const guild = fakeGuild({ admin: true })
  await assert.rejects(() => clockIn(base(db, guild, { taskId: 'H' })), (e) => e instanceof ClockError && e.message === 'This project is deleted.')
  assert.deepEqual(db.calls, [])
  assert.deepEqual(guild.roleCalls, [])
})

test("a running timer on a deleted project's task still names its project", async () => {
  const db = hidingDb({ entries: [{ id: 'e1', guildConfigId: 'g1', discordId: 'u1', taskId: 'H', clockInAt: minsAgo(10), clockOutAt: null }] })
  const status = await clockStatus({ db, cfg, guild: fakeGuild(), discordId: 'u1', now: NOW })
  assert.equal(status.projectName, 'Alpha')
  const [row] = await clockedInNow({ db, cfg, now: NOW })
  assert.equal(row.projectName, 'Alpha')
})
