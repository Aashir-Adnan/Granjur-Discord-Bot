import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType } from 'discord.js'
import { textChannelsOf, desiredOrder, applyOrder } from './channelOrder.js'

const text = (id, parentId, rawPosition) => ({ id, type: ChannelType.GuildText, parentId, rawPosition })

function guildWith(channels) {
  const map = new Map(channels.map((c) => [c.id, c]))
  const sent = []
  return {
    _sent: sent,
    channels: {
      cache: { get: (id) => map.get(id) ?? null, values: () => map.values() },
      setPositions: async (list) => { sent.push(list); return undefined },
    },
  }
}

test('textChannelsOf takes only this category\'s text channels, sorted by rawPosition then id', () => {
  const guild = guildWith([
    { id: '30', type: ChannelType.GuildCategory, parentId: null, rawPosition: 0 },
    { id: '20', type: ChannelType.GuildVoice, parentId: 'cat', rawPosition: 0 },
    text('12', 'cat', 2),
    text('11', 'cat', 1),
    text('9', 'cat', 1),
    text('99', 'other', 0),
  ])
  // Same rawPosition falls back to the id, numerically as Discord sorts
  // snowflakes — '9' before '11', not the string order that puts '11' first.
  assert.deepEqual(textChannelsOf(guild, 'cat').map((c) => c.id), ['9', '11', '12'])
  assert.deepEqual(textChannelsOf(guild, null), [])
  assert.deepEqual(textChannelsOf(null, 'cat'), [])
})

test('textChannelsOf treats a missing rawPosition as 0 rather than dropping the channel', () => {
  const guild = guildWith([{ id: '5', type: ChannelType.GuildText, parentId: 'cat' }, text('4', 'cat', 1)])
  assert.deepEqual(textChannelsOf(guild, 'cat').map((c) => c.id), ['5', '4'])
})

test('desiredOrder: non-tickets first, then live tickets, the divider, then archived — relative order kept', () => {
  const channels = ['s1', 't1', 'a1', 'div', 's2', 't2', 'a2'].map((id) => ({ id }))
  const order = desiredOrder(channels, {
    dividerId: 'div',
    archivedIds: new Set(['a1', 'a2']),
    ticketIds: new Set(['t1', 't2', 'a1', 'a2']),
  })
  assert.deepEqual(order, ['s1', 's2', 't1', 't2', 'div', 'a1', 'a2'])
})

test('desiredOrder with no divider still splits live from archived, with no line between', () => {
  const channels = ['a1', 't1', 's1'].map((id) => ({ id }))
  const order = desiredOrder(channels, { dividerId: null, archivedIds: new Set(['a1']), ticketIds: new Set(['a1', 't1']) })
  assert.deepEqual(order, ['s1', 't1', 'a1'])
})

test('desiredOrder never invents a divider the category does not hold, and accepts bare ids', () => {
  const order = desiredOrder(['s1', 't1'], { dividerId: 'div', archivedIds: [], ticketIds: ['t1'] })
  assert.deepEqual(order, ['s1', 't1'])
})

test('desiredOrder defaults to "nothing is a ticket": every channel keeps its place', () => {
  assert.deepEqual(desiredOrder([{ id: 'a' }, { id: 'b' }]), ['a', 'b'])
  assert.deepEqual(desiredOrder(null), [])
})

test('applyOrder sends ONE setPositions numbered 0..n-1 when the order differs', async () => {
  const guild = guildWith([])
  const out = await applyOrder(guild, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['a', 'c', 'b'])
  assert.deepEqual(out, { changed: true })
  assert.equal(guild._sent.length, 1)
  assert.deepEqual(guild._sent[0], [
    { channel: 'a', position: 0 },
    { channel: 'c', position: 1 },
    { channel: 'b', position: 2 },
  ])
})

test('applyOrder sends nothing at all when the order already matches', async () => {
  const guild = guildWith([])
  const out = await applyOrder(guild, [{ id: 'a' }, { id: 'b' }], ['a', 'b'])
  assert.deepEqual(out, { changed: false })
  assert.deepEqual(guild._sent, [])
})

test('applyOrder lets a refusal through to the caller', async () => {
  const guild = guildWith([])
  guild.channels.setPositions = async () => { throw new Error('Missing Permissions') }
  await assert.rejects(() => applyOrder(guild, [{ id: 'a' }], ['a', 'b']), /Missing Permissions/)
})
