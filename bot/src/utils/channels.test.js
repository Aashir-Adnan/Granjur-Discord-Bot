import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js'
import { lockTicketChannel, unlockTicketChannel } from './channels.js'

const bits = (...flags) => new PermissionsBitField(flags)

function channelWith(overwrites, { failOn = null } = {}) {
  const edits = []
  return {
    id: 'ch1',
    edits,
    permissionOverwrites: {
      cache: new Map(overwrites.map((o) => [o.id, o])),
      edit: async (id, patch) => {
        if (failOn === id) throw new Error('Missing Permissions')
        edits.push([id, patch])
      },
    },
  }
}

test('lock: every overwrite that allows sending is denied it; the rest are untouched', async () => {
  const ch = channelWith([
    { id: 'G1', allow: bits(), deny: bits(PermissionFlagsBits.ViewChannel) },
    { id: 'assignee', allow: bits(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages), deny: bits() },
    { id: 'role', allow: bits(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages), deny: bits() },
    { id: 'viewer', allow: bits(PermissionFlagsBits.ViewChannel), deny: bits() },
  ])
  const out = await lockTicketChannel(ch)
  assert.deepEqual(ch.edits, [['assignee', { SendMessages: false }], ['role', { SendMessages: false }]])
  assert.deepEqual(out, { edited: 2, failed: 0 })
})

async function quiet(fn) {
  const real = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = real }
}

test('lock: one failing overwrite is counted and the others are still edited', async () => {
  const ch = channelWith(
    [
      { id: 'a', allow: bits(PermissionFlagsBits.SendMessages), deny: bits() },
      { id: 'b', allow: bits(PermissionFlagsBits.SendMessages), deny: bits() },
    ],
    { failOn: 'a' }
  )
  const out = await quiet(() => lockTicketChannel(ch))
  assert.deepEqual(ch.edits, [['b', { SendMessages: false }]])
  assert.deepEqual(out, { edited: 1, failed: 1 })
})

test('unlock: only overwrites that can view AND were denied sending get it back — @everyone never does', async () => {
  const ch = channelWith([
    { id: 'G1', allow: bits(), deny: bits(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages) },
    { id: 'assignee', allow: bits(PermissionFlagsBits.ViewChannel), deny: bits(PermissionFlagsBits.SendMessages) },
    { id: 'viewer', allow: bits(PermissionFlagsBits.ViewChannel), deny: bits() },
  ])
  const out = await unlockTicketChannel(ch)
  assert.deepEqual(ch.edits, [['assignee', { SendMessages: true }]])
  assert.deepEqual(out, { edited: 1, failed: 0 })
})

test('lock and unlock tolerate a channel with no readable overwrites', async () => {
  assert.deepEqual(await lockTicketChannel({ id: 'x' }), { edited: 0, failed: 0 })
  assert.deepEqual(await unlockTicketChannel(null), { edited: 0, failed: 0 })
})
