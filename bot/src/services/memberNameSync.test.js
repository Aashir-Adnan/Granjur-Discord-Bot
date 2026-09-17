import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toNameUpdates, syncGuildMemberNames } from './memberNameSync.js'

const m = (id, displayName, username, bot = false) => ({ id, displayName, user: { username, bot } })

test('toNameUpdates: changed names update, unchanged are skipped, unknown members insert, bots ignored', () => {
  const discord = [m('1', 'Nauraiz', 'nauraiz_101104'), m('2', 'Afaq Khawar', 'afaqkhawar9299'), m('3', 'New Person', 'newp'), m('9', 'Helper', 'helper', true)]
  const rows = [
    { id: 'r1', discordId: '1', displayName: 'Nauraiz', username: 'nauraiz_101104' },
    { id: 'r2', discordId: '2', displayName: 'Afaq', username: null },
  ]
  const out = toNameUpdates(discord, rows)
  assert.deepEqual(out.updates, [{ id: 'r2', displayName: 'Afaq Khawar', username: 'afaqkhawar9299' }])
  assert.deepEqual(out.inserts, [{ discordId: '3', displayName: 'New Person', username: 'newp' }])
})

test('toNameUpdates: names are clipped to the column widths', () => {
  const out = toNameUpdates([m('1', 'x'.repeat(150), 'y'.repeat(80))], [])
  assert.equal(out.inserts[0].displayName.length, 100)
  assert.equal(out.inserts[0].username.length, 64)
})

test('syncGuildMemberNames writes updates and pending inserts through the seam', async () => {
  const calls = []
  const db = {
    guildMember: {
      findMany: async () => [{ id: 'r1', discordId: '1', displayName: 'Old', username: 'nauraiz_101104' }],
      update: async (a) => { calls.push(['update', a]) },
      upsert: async (a) => { calls.push(['upsert', a]) },
    },
  }
  const guild = {
    id: 'guild1',
    members: { fetch: async () => new Map([['1', m('1', 'Nauraiz', 'nauraiz_101104')], ['2', m('2', 'Hassan Abid', 'hasxanabid')]]) },
  }
  const cfg = { id: 'g1', guildId: 'guild1' }
  const n = await syncGuildMemberNames(guild, { db, cfg })
  assert.equal(n, 2)
  assert.deepEqual(calls[0], ['update', { where: { id: 'r1' }, data: { displayName: 'Nauraiz', username: 'nauraiz_101104' } }])
  assert.equal(calls[1][0], 'upsert')
  assert.equal(calls[1][1].create.status, 'pending')
  assert.equal(calls[1][1].create.displayName, 'Hassan Abid')
})
