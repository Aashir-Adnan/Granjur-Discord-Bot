import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { reportLines, runDailyReportPass } from './dailyTimeReport.js'

async function quietly(fn) {
  const orig = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = orig }
}

// Bulk-fetch fake: guild.members.fetch({ user: ids }) -> Map<id, member>.
function fakeGuild(sent) {
  return {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: async ({ user }) => new Map(user.map((id) => [id, { id, displayName: `User ${id}` }])) },
    channels: {
      fetch: async () => ({ id: 'chan1', send: async (payload) => { sent.push(payload); return { id: 'msg1' } } }),
      create: async () => ({ id: 'chan1', send: async (payload) => { sent.push(payload); return { id: 'msg1' } } }),
    },
  }
}

// Stateful harness: `update` actually mutates the config `getConfig` reads
// back, like a real database would — needed to test the persisted-write
// failure paths without the two seams silently disagreeing with each other.
function harness({
  lastTimeReportOn = '2026-09-21',
  totals = [],
  members = [{ discordId: '1', displayName: 'Ali', status: 'approved' }],
  timezone = 'UTC',
  timeReportChannelId = 'chan1',
} = {}) {
  const sent = []
  const updates = []
  const guild = fakeGuild(sent)
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const state = { id: 'cfg1', timezone, lastTimeReportOn, timeReportChannelId }
  const db = {
    clockEntry: { sumByPersonRange: async () => totals },
    guildMember: { findMany: async (args) => { db.lastFindMany = args; return members } },
  }
  const getConfig = async () => ({ ...state })
  const update = async (guildId, data) => { updates.push({ guildId, data }); Object.assign(state, data) }
  return {
    client, db, getConfig, update, sent, updates, guild, state,
  }
}

// ---- the original seven (bulk-fetch shape only; behaviour unchanged) -----

test('posts the day that just ended and records it', async () => {
  const h = harness({ totals: [{ discordId: '1', minutes: 90 }] })
  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z'),
  })
  assert.equal(h.sent.length, 1)
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-22')
})

test('the roster read is uncapped — guildMemberFindMany defaults to 25', async () => {
  const h = harness()
  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z'),
  })
  assert.equal(h.db.lastFindMany.where.all, true)
  assert.equal(h.db.lastFindMany.where.status, 'approved')
})

test('does not post twice for the same day', async () => {
  const h = harness({ lastTimeReportOn: '2026-09-22' })
  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z'),
  })
  assert.equal(h.sent.length, 0)
})

test('the first ever pass records the day and posts nothing', async () => {
  const h = harness({ lastTimeReportOn: null })
  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T12:00:00Z'),
  })
  assert.equal(h.sent.length, 0)
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-21')
})

test('a long outage posts once, for the most recent due day only', async () => {
  const h = harness({ lastTimeReportOn: '2026-09-15' })
  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z'),
  })
  assert.equal(h.sent.length, 1)
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-22')
})

test('before the cutoff, yesterday is posted rather than a partial today', async () => {
  const h = harness({ lastTimeReportOn: '2026-09-20' })
  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T10:00:00Z'),
  })
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-21')
})

test('reportLines lists zeros and truncates with a truthful tail', () => {
  const ranked = [
    { discordId: '1', name: 'Ali', minutes: 120 },
    { discordId: '2', name: 'Zara', minutes: 0 },
    { discordId: '3', name: 'Bilal', minutes: 0 },
  ]
  assert.deepEqual(reportLines(ranked, 10), ['**Ali** — 2h', '**Zara** — 0m', '**Bilal** — 0m'])
  assert.deepEqual(reportLines(ranked, 2), ['**Ali** — 2h', '**Zara** — 0m', '…and 1 more'])
})

// ---- finding 1: in-flight guard --------------------------------------

test('an overlapping pass is skipped rather than double-posting', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const h = harness({ totals: [{ discordId: '1', minutes: 30 }] })
  const originalSum = h.db.clockEntry.sumByPersonRange
  h.db.clockEntry.sumByPersonRange = async (...args) => { await gate; return originalSum(...args) }
  const now = new Date('2026-09-22T23:59:00Z')

  const first = runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now })
  const second = await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now })
  assert.equal(second.skipped, true)
  assert.equal(h.sent.length, 0, 'the overlapping pass did no work before the gate opens')

  release()
  await first
  assert.equal(h.sent.length, 1)
  assert.equal(h.state.lastTimeReportOn, '2026-09-22')

  // The guard is released once the first pass finishes; a genuinely new due
  // day (not just a retried tick) still posts.
  const third = await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-23T23:59:00Z'),
  })
  assert.notEqual(third?.skipped, true)
  assert.equal(h.sent.length, 2)
})

// ---- finding 2: a failed state write must not repost every tick ------

test('a failed persisted write does not repost on the next tick (in-memory backstop)', async () => {
  const h = harness({ totals: [{ discordId: '1', minutes: 15 }] })
  h.update = async (guildId, data) => {
    h.updates.push({ guildId, data })
    if (data.lastTimeReportOn) throw new Error('write conflict')
    Object.assign(h.state, data)
  }
  const now = new Date('2026-09-22T23:59:00Z')

  await quietly(() => runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now }))
  assert.equal(h.sent.length, 1)
  assert.equal(h.state.lastTimeReportOn, '2026-09-21', 'the persisted write failed, so the column is unchanged')

  await quietly(() => runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now }))
  assert.equal(h.sent.length, 1, 'the in-memory backstop stops a second send even though the column never updated')
})

// ---- finding 3: only Unknown Channel (10003) recreates the channel ----

test('a transient channel-fetch failure does not create a duplicate channel', async () => {
  const sent = []
  const created = []
  const guild = {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: async ({ user }) => new Map(user.map((id) => [id, { id, displayName: `User ${id}` }])) },
    channels: {
      fetch: async () => { const e = new Error('service unavailable'); e.code = 500; throw e },
      create: async (opts) => { created.push(opts); return { id: 'newchan', send: async (p) => { sent.push(p) } } },
    },
  }
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const db = {
    clockEntry: { sumByPersonRange: async () => [] },
    guildMember: { findMany: async () => [{ discordId: '1', displayName: 'Ali', status: 'approved' }] },
  }
  const state = { id: 'cfg1', timezone: 'UTC', lastTimeReportOn: '2026-09-21', timeReportChannelId: 'chan1' }
  const getConfig = async () => ({ ...state })
  const update = async (guildId, data) => { Object.assign(state, data) }

  await quietly(() => runDailyReportPass(client, { db, getConfig, update, now: new Date('2026-09-22T23:59:00Z') }))
  assert.equal(created.length, 0, 'a transient fetch failure must not spawn a new channel')
  assert.equal(sent.length, 0, 'no post goes out when the configured channel could not be confirmed')
  assert.equal(state.timeReportChannelId, 'chan1', 'the channel id is left untouched')
  assert.equal(state.lastTimeReportOn, '2026-09-21', 'not recorded as posted — this retries next tick')
})

test('Unknown Channel (10003) recreates the channel and persists the new id', async () => {
  const sent = []
  const created = []
  const newChannel = { id: 'chan2', send: async (p) => { sent.push(p); return { id: 'm1' } } }
  const guild = {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: async ({ user }) => new Map(user.map((id) => [id, { id, displayName: `User ${id}` }])) },
    channels: {
      fetch: async () => { const e = new Error('Unknown Channel'); e.code = 10003; throw e },
      create: async (opts) => { created.push(opts); return newChannel },
    },
  }
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const db = {
    clockEntry: { sumByPersonRange: async () => [] },
    guildMember: { findMany: async () => [{ discordId: '1', displayName: 'Ali', status: 'approved' }] },
  }
  const state = { id: 'cfg1', timezone: 'UTC', lastTimeReportOn: '2026-09-21', timeReportChannelId: 'chan1' }
  const getConfig = async () => ({ ...state })
  const update = async (guildId, data) => { Object.assign(state, data) }

  await runDailyReportPass(client, { db, getConfig, update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(created.length, 1)
  assert.equal(created[0].permissionOverwrites[0].id, 'everyone')
  assert.deepEqual(
    created[0].permissionOverwrites[0].allow,
    [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
    'ViewChannel without ReadMessageHistory is a channel everyone sees and nobody can read',
  )
  assert.deepEqual(created[0].permissionOverwrites[0].deny, [PermissionFlagsBits.SendMessages])
  assert.equal(sent.length, 1)
  assert.equal(state.timeReportChannelId, 'chan2', 'the new channel id is persisted')
})

test('no channel configured yet creates one, with the right name and overwrites', async () => {
  const sent = []
  const created = []
  const newChannel = { id: 'chan2', send: async (p) => { sent.push(p) } }
  const guild = {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: async ({ user }) => new Map(user.map((id) => [id, { id, displayName: `User ${id}` }])) },
    channels: {
      fetch: async () => { throw new Error('should not be called when nothing is configured') },
      create: async (opts) => { created.push(opts); return newChannel },
    },
  }
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const db = {
    clockEntry: { sumByPersonRange: async () => [] },
    guildMember: { findMany: async () => [{ discordId: '1', displayName: 'Ali', status: 'approved' }] },
  }
  const state = { id: 'cfg1', timezone: 'UTC', lastTimeReportOn: '2026-09-21', timeReportChannelId: null }
  const getConfig = async () => ({ ...state })
  const update = async (guildId, data) => { Object.assign(state, data) }

  await runDailyReportPass(client, { db, getConfig, update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(created.length, 1)
  assert.equal(created[0].name, 'time-reports')
  assert.equal(sent.length, 1)
  assert.equal(state.timeReportChannelId, 'chan2')
})

// ---- finding 4: a failed persist of a new channel id aborts the post --

test('a failed persist of a newly created channel id aborts the post', async () => {
  const sent = []
  const created = []
  const newChannel = { id: 'chan2', send: async (p) => { sent.push(p) } }
  const guild = {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: async ({ user }) => new Map(user.map((id) => [id, { id, displayName: `User ${id}` }])) },
    channels: {
      fetch: async () => { const e = new Error('Unknown Channel'); e.code = 10003; throw e },
      create: async (opts) => { created.push(opts); return newChannel },
    },
  }
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const db = {
    clockEntry: { sumByPersonRange: async () => [] },
    guildMember: { findMany: async () => [{ discordId: '1', displayName: 'Ali', status: 'approved' }] },
  }
  const state = { id: 'cfg1', timezone: 'UTC', lastTimeReportOn: '2026-09-21', timeReportChannelId: 'chan1' }
  const getConfig = async () => ({ ...state })
  const update = async (guildId, data) => {
    if (data.timeReportChannelId) throw new Error('write failed')
    Object.assign(state, data)
  }

  await quietly(() => runDailyReportPass(client, { db, getConfig, update, now: new Date('2026-09-22T23:59:00Z') }))
  assert.equal(created.length, 1, 'the channel was created')
  assert.equal(sent.length, 0, 'nothing was posted, since the new id could not be persisted')
  assert.equal(state.lastTimeReportOn, '2026-09-21', 'the day is not marked done either')

  // The reviewer's repro: with the persist still failing, every following
  // tick used to see the config still empty and create yet another channel —
  // 5 ticks, 5 channels, 0 posts. The in-memory "already created this run"
  // guard must stop that after the first one.
  const now = new Date('2026-09-22T23:59:00Z')
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await quietly(() => runDailyReportPass(client, { db, getConfig, update, now }))
  }
  assert.equal(created.length, 1, 'four more ticks created no further channels')
  assert.equal(sent.length, 0, 'the id is still unpersisted, so still nothing is posted')
  assert.equal(state.lastTimeReportOn, '2026-09-21', 'the day is still not marked done')
})

// ---- finding 5: bulk roster hydration -----------------------------------

test('a departed member (missing from a successful bulk fetch) is dropped from the report', async () => {
  const sent = []
  const guild = {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: {
      fetch: async ({ user }) => new Map(
        user.filter((id) => id !== '2').map((id) => [id, { id, displayName: `User ${id}` }]),
      ),
    },
    channels: { fetch: async () => ({ id: 'chan1', send: async (p) => { sent.push(p) } }) },
  }
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const db = {
    clockEntry: { sumByPersonRange: async () => [{ discordId: '1', minutes: 30 }, { discordId: '2', minutes: 60 }] },
    guildMember: {
      findMany: async () => [
        { discordId: '1', displayName: 'Ali', status: 'approved' },
        { discordId: '2', displayName: 'Left Person', status: 'approved' },
      ],
    },
  }
  const getConfig = async () => ({ id: 'cfg1', timezone: 'UTC', lastTimeReportOn: '2026-09-21', timeReportChannelId: 'chan1' })
  const update = async () => {}

  await runDailyReportPass(client, { db, getConfig, update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(sent.length, 1)
  const embed = sent[0].embeds[0].toJSON()
  assert.equal(embed.description.includes('Left Person'), false, 'a departed member is dropped, not listed at 0m')
  assert.match(embed.description, /User 1/)
})

test('a transient bulk member-fetch failure keeps everyone, using the roster\'s own name', async () => {
  const sent = []
  const guild = {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: async () => { const e = new Error('gateway timeout'); e.code = 'GuildMembersTimeout'; throw e } },
    channels: { fetch: async () => ({ id: 'chan1', send: async (p) => { sent.push(p) } }) },
  }
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const db = {
    clockEntry: { sumByPersonRange: async () => [{ discordId: '1', minutes: 30 }] },
    guildMember: { findMany: async () => [{ discordId: '1', displayName: 'Ali', status: 'approved' }] },
  }
  const getConfig = async () => ({ id: 'cfg1', timezone: 'UTC', lastTimeReportOn: '2026-09-21', timeReportChannelId: 'chan1' })
  const update = async () => {}

  await quietly(() => runDailyReportPass(client, { db, getConfig, update, now: new Date('2026-09-22T23:59:00Z') }))
  assert.equal(sent.length, 1, 'a transient fetch failure must not silently drop the whole roster')
  const embed = sent[0].embeds[0].toJSON()
  assert.match(embed.description, /Ali/)
})

// ---- finding 6: coverage the review found missing ------------------------

test('the embed actually contains the totals — description and team total', async () => {
  const sent = []
  const guild = {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: async ({ user }) => new Map(user.map((id) => [id, { id, displayName: 'Ali' }])) },
    channels: { fetch: async () => ({ id: 'chan1', send: async (p) => { sent.push(p) } }) },
  }
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const db = {
    clockEntry: { sumByPersonRange: async () => [{ discordId: '1', minutes: 90 }] },
    guildMember: { findMany: async () => [{ discordId: '1', displayName: 'Ali', status: 'approved' }] },
  }
  const getConfig = async () => ({ id: 'cfg1', timezone: 'UTC', lastTimeReportOn: '2026-09-21', timeReportChannelId: 'chan1' })
  const update = async () => {}

  await runDailyReportPass(client, { db, getConfig, update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(sent.length, 1)
  const embed = sent[0].embeds[0].toJSON()
  assert.match(embed.description, /\*\*Ali\*\* — 1h 30m/)
  assert.equal(embed.fields[0].name, 'Team total')
  assert.equal(embed.fields[0].value, '1h 30m')
})

// ---- finding 7: a timer still running at the cutoff must not read as a ---
// ---- silent, uncorrected 0m ----------------------------------------------

test('the embed footer discloses that still-running timers are not counted', async () => {
  const h = harness({ totals: [{ discordId: '1', minutes: 90 }] })
  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z'),
  })
  assert.equal(h.sent.length, 1)
  const embed = h.sent[0].embeds[0].toJSON()
  assert.equal(embed.footer?.text, 'Timers still running at 23:59 are not counted.')
})

test('lastTimeReportOn as a Date (what mysql2 actually returns for a DATE column) is read correctly', async () => {
  // Built from local y/m/d components, not parsed from an ISO/UTC string, so
  // this is deterministic regardless of the host's timezone (dateKey() reads
  // a Date back via its own local getters).
  const h = harness({ lastTimeReportOn: new Date(2026, 8, 22), totals: [] })
  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z'),
  })
  assert.equal(h.sent.length, 0, 'already posted today (stored as a Date) — not re-sent')
})

test('an invalid guild timezone falls back to UTC rather than throwing', async () => {
  const h = harness({ totals: [{ discordId: '1', minutes: 45 }], timezone: 'Not/AZone' })
  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z'),
  })
  assert.equal(h.sent.length, 1)
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-22')
})

test('a non-UTC guild timezone determines the cutoff, not the bot host clock', async () => {
  const h = harness({ totals: [{ discordId: '1', minutes: 10 }], timezone: 'Asia/Karachi' })
  // 19:00 UTC = 00:00 the 23rd in Asia/Karachi (UTC+5, no DST) — just past the
  // 22nd's 23:59 cutoff there, while in UTC itself the 22nd's cutoff has not
  // yet arrived. Only a genuinely guild-tz-aware cutoff posts here.
  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T19:00:00Z'),
  })
  assert.equal(h.sent.length, 1)
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-22')
})

test('one guild failing does not stop another guild from posting', async () => {
  const sentA = []
  const sentB = []
  const guildA = fakeGuild(sentA)
  guildA.id = 'gA'
  const guildB = fakeGuild(sentB)
  guildB.id = 'gB'
  const client = { guilds: { cache: new Map([['gA', guildA], ['gB', guildB]]) } }
  const db = {
    clockEntry: {
      sumByPersonRange: async ({ guildConfigId }) => {
        if (guildConfigId === 'cfgA') throw new Error('db exploded for guild A')
        return []
      },
    },
    guildMember: { findMany: async () => [{ discordId: '1', displayName: 'Ali', status: 'approved' }] },
  }
  const getConfig = async (guildId) => ({
    id: guildId === 'gA' ? 'cfgA' : 'cfgB',
    timezone: 'UTC',
    lastTimeReportOn: '2026-09-21',
    timeReportChannelId: 'chan1',
  })
  const update = async () => {}

  await quietly(() => runDailyReportPass(client, { db, getConfig, update, now: new Date('2026-09-22T23:59:00Z') }))
  assert.equal(sentA.length, 0, 'guild A failed partway through and posted nothing')
  assert.equal(sentB.length, 1, 'guild B still gets its report despite guild A failing')
})

// ---- the readable-channel repair ----------------------------------------

// A permission overwrite as discord.js hands it back: allow is a bitfield
// with .has(), not an array.
function overwrite(bits) {
  return { allow: { has: (bit) => bits.includes(bit) } }
}

function readableHarness({ bits, edits }) {
  const sent = []
  const channel = {
    id: 'chan1',
    send: async (payload) => { sent.push(payload); return { id: 'msg1' } },
    permissionOverwrites: {
      cache: new Map(bits ? [['everyone', overwrite(bits)]] : []),
      edit: async (id, perms) => { edits.push({ id, perms }) },
    },
  }
  const guild = {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: async ({ user }) => new Map(user.map((id) => [id, { id, displayName: `User ${id}` }])) },
    channels: { fetch: async () => channel, create: async () => { throw new Error('must not create') } },
  }
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const db = {
    clockEntry: { sumByPersonRange: async () => [] },
    guildMember: { findMany: async () => [{ discordId: '1', displayName: 'Ali', status: 'approved' }] },
  }
  const state = { id: 'cfg1', timezone: 'UTC', lastTimeReportOn: '2026-09-21', timeReportChannelId: 'chan1' }
  const getConfig = async () => ({ ...state })
  const update = async (guildId, data) => { Object.assign(state, data) }
  return { client, db, getConfig, update, sent, state }
}

test('a configured channel @everyone cannot read is opened up, once', async () => {
  const edits = []
  // The channel as production actually has it: ViewChannel only.
  const h = readableHarness({ bits: [PermissionFlagsBits.ViewChannel], edits })

  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z'),
  })
  assert.equal(edits.length, 1, 'the unreadable channel is repaired')
  assert.equal(edits[0].id, 'everyone')
  assert.deepEqual(edits[0].perms, { ViewChannel: true, ReadMessageHistory: true })
  assert.equal(h.sent.length, 1, 'and the report still goes out')

  // Next day, same process: the repair is not re-applied every tick.
  h.state.lastTimeReportOn = '2026-09-22'
  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-23T23:59:00Z'),
  })
  assert.equal(edits.length, 1, 'once per process run, not once per tick')
  assert.equal(h.sent.length, 2)
})

test('the repair happens on a day that is already posted', async () => {
  // Production's exact state: today's report already went out into a channel
  // nobody could read. If the repair only ran on the post path, the fix would
  // not land until 23:59 tomorrow.
  const edits = []
  const h = readableHarness({ bits: [PermissionFlagsBits.ViewChannel], edits })
  h.state.lastTimeReportOn = '2026-09-22'

  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-23T09:00:00Z'),
  })
  assert.equal(h.sent.length, 0, 'the day is already done — nothing new is posted')
  assert.equal(edits.length, 1, 'but the channel is opened up straight away')
  assert.deepEqual(edits[0].perms, { ViewChannel: true, ReadMessageHistory: true })
})

test('a channel @everyone can already read is left alone', async () => {
  const edits = []
  const h = readableHarness({
    bits: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
    edits,
  })

  await runDailyReportPass(h.client, {
    db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z'),
  })
  assert.equal(edits.length, 0, 'nothing to repair, so no permission write')
  assert.equal(h.sent.length, 1)
})

test('a failed permission repair warns but still posts', async () => {
  // Built inline rather than via the harness: here the edit itself throws.
  const sent = []
  const channel = {
    id: 'chan1',
    send: async (payload) => { sent.push(payload) },
    permissionOverwrites: {
      cache: new Map([['everyone', overwrite([PermissionFlagsBits.ViewChannel])]]),
      edit: async () => { throw new Error('Missing Permissions') },
    },
  }
  const guild = {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: async ({ user }) => new Map(user.map((id) => [id, { id, displayName: `User ${id}` }])) },
    channels: { fetch: async () => channel, create: async () => { throw new Error('must not create') } },
  }
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const db = {
    clockEntry: { sumByPersonRange: async () => [] },
    guildMember: { findMany: async () => [{ discordId: '1', displayName: 'Ali', status: 'approved' }] },
  }
  const state = { id: 'cfg1', timezone: 'UTC', lastTimeReportOn: '2026-09-21', timeReportChannelId: 'chan1' }
  const getConfig = async () => ({ ...state })
  const update = async (guildId, data) => { Object.assign(state, data) }

  await quietly(() => runDailyReportPass(client, { db, getConfig, update, now: new Date('2026-09-22T23:59:00Z') }))
  assert.equal(sent.length, 1, 'an unreadable report still beats no report')
  assert.equal(state.lastTimeReportOn, '2026-09-22')
})
