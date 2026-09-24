import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js'
import { RETIRE_AFTER_MS, retireTicketChannel, reviveTicketChannel, sweepRetiredTickets, startTicketRetireSweep } from './ticketRetire.js'

const bits = (...flags) => new PermissionsBitField(flags)
const NOW = new Date('2026-09-25T10:00:00Z')

function fakeDb({ retirable = [], updateFails = false } = {}) {
  const updates = []
  return {
    updates,
    task: {
      update: async (a) => {
        if (updateFails) throw new Error('db down')
        updates.push(a)
        return null
      },
      findRetirable: async ({ where, take }) => retirable.filter((t) => t.channelRetireAt <= where.before).slice(0, take ?? 100),
    },
  }
}

function fakeChannel(overwrites = [], { lockFails = false } = {}) {
  const edits = []
  return {
    id: 'ch1',
    edits,
    permissionOverwrites: {
      cache: new Map(overwrites.map((o) => [o.id, o])),
      edit: async (id, patch) => {
        if (lockFails) throw new Error('Missing Permissions')
        edits.push([id, patch])
      },
    },
  }
}

async function quiet(fn) {
  const real = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = real }
}

test('RETIRE_AFTER_MS is fourteen days', () => {
  assert.equal(RETIRE_AFTER_MS, 14 * 24 * 60 * 60 * 1000)
})

test('retire locks the channel and stamps the row fourteen days from now', async () => {
  const db = fakeDb()
  const channel = fakeChannel([{ id: 'a', allow: bits(PermissionFlagsBits.SendMessages), deny: bits() }])
  const out = await retireTicketChannel({ channel, task: { id: 'T1' }, db, now: () => NOW })
  assert.deepEqual(channel.edits, [['a', { SendMessages: false }]])
  assert.equal(out.retireAt.getTime(), NOW.getTime() + RETIRE_AFTER_MS)
  assert.deepEqual(db.updates, [{ where: { id: 'T1' }, data: { channelRetireAt: out.retireAt } }])
})

test('retire still stamps when the lock fails, and when there is no channel at all', async () => {
  const db = fakeDb()
  await quiet(() => retireTicketChannel({ channel: fakeChannel([{ id: 'a', allow: bits(PermissionFlagsBits.SendMessages), deny: bits() }], { lockFails: true }), task: { id: 'T1' }, db, now: () => NOW }))
  await retireTicketChannel({ channel: null, task: { id: 'T2' }, db, now: () => NOW })
  assert.deepEqual(db.updates.map((u) => u.where.id), ['T1', 'T2'])
})

test('revive unlocks the channel and clears the stamp', async () => {
  const db = fakeDb()
  const channel = fakeChannel([{ id: 'a', allow: bits(PermissionFlagsBits.ViewChannel), deny: bits(PermissionFlagsBits.SendMessages) }])
  await reviveTicketChannel({ channel, task: { id: 'T1' }, db })
  assert.deepEqual(channel.edits, [['a', { SendMessages: true }]])
  assert.deepEqual(db.updates, [{ where: { id: 'T1' }, data: { channelRetireAt: null } }])
})

function fakeClient(channels, { fetchError = null } = {}) {
  const deleted = []
  const map = new Map(channels.map((c) => [c.id, { ...c, delete: async () => { if (c.deleteFails) throw new Error('Missing Permissions'); deleted.push(c.id) } }]))
  return {
    deleted,
    channels: {
      cache: { get: (id) => map.get(id) ?? null },
      fetch: async (id) => {
        if (fetchError) throw fetchError
        const c = map.get(id)
        if (!c) { const e = new Error('Unknown Channel'); e.code = 10003; throw e }
        return c
      },
    },
  }
}

test('sweep deletes only channels past their stamp and clears both columns', async () => {
  const due = { id: 'T1', discordChannelId: 'c1', channelRetireAt: new Date(NOW.getTime() - 1000) }
  const later = { id: 'T2', discordChannelId: 'c2', channelRetireAt: new Date(NOW.getTime() + 1000) }
  const db = fakeDb({ retirable: [due, later] })
  const client = fakeClient([{ id: 'c1' }, { id: 'c2' }])
  const out = await sweepRetiredTickets({ client, db, now: () => NOW })
  assert.deepEqual(client.deleted, ['c1'])
  assert.deepEqual(db.updates, [{ where: { id: 'T1' }, data: { discordChannelId: null, channelRetireAt: null } }])
  assert.deepEqual(out, { deleted: 1, failed: 0 })
})

test('sweep: a channel Discord already deleted counts as deleted and the row is cleared', async () => {
  const due = { id: 'T1', discordChannelId: 'gone', channelRetireAt: new Date(0) }
  const db = fakeDb({ retirable: [due] })
  const client = fakeClient([])
  const out = await sweepRetiredTickets({ client, db, now: () => NOW })
  assert.deepEqual(db.updates, [{ where: { id: 'T1' }, data: { discordChannelId: null, channelRetireAt: null } }])
  assert.deepEqual(out, { deleted: 1, failed: 0 })
})

test('sweep: a delete that throws keeps the stamp so the next tick retries, and the others still run', async () => {
  const rows = [
    { id: 'T1', discordChannelId: 'c1', channelRetireAt: new Date(0) },
    { id: 'T2', discordChannelId: 'c2', channelRetireAt: new Date(0) },
  ]
  const db = fakeDb({ retirable: rows })
  const client = fakeClient([{ id: 'c1', deleteFails: true }, { id: 'c2' }])
  const out = await quiet(() => sweepRetiredTickets({ client, db, now: () => NOW }))
  assert.deepEqual(client.deleted, ['c2'])
  assert.deepEqual(db.updates.map((u) => u.where.id), ['T2'])
  assert.deepEqual(out, { deleted: 1, failed: 1 })
})

test('sweep: a failed read is a warning and an empty result, never a throw', async () => {
  const db = { task: { findRetirable: async () => { throw new Error('db down') } } }
  const out = await quiet(() => sweepRetiredTickets({ client: fakeClient([]), db, now: () => NOW }))
  assert.deepEqual(out, { deleted: 0, failed: 0 })
})

test('startTicketRetireSweep runs once immediately and returns a clearable timer', async () => {
  let runs = 0
  const db = { task: { findRetirable: async () => { runs += 1; return [] } } }
  const timer = startTicketRetireSweep(fakeClient([]), { db, intervalMs: 60_000 })
  clearInterval(timer)
  await new Promise((r) => setImmediate(r))
  assert.equal(runs, 1)
})
