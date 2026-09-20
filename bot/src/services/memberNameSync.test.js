import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toNameUpdates, syncGuildMemberNames, syncOneMember, roleNamesOf, avatarUrlOf } from './memberNameSync.js'

const m = (id, displayName, username, bot = false) => ({ id, displayName, user: { username, bot } })

const withRoles = (member, names) => ({
  ...member,
  roles: { cache: new Map(names.map((n, i) => [String(i), { name: n }])) },
})

test('toNameUpdates: changed names update, unchanged are skipped, unknown members insert, bots ignored', () => {
  const discord = [m('1', 'Nauraiz', 'nauraiz_101104'), m('2', 'Afaq Khawar', 'afaqkhawar9299'), m('3', 'New Person', 'newp'), m('9', 'Helper', 'helper', true)]
  const rows = [
    { id: 'r1', discordId: '1', displayName: 'Nauraiz', username: 'nauraiz_101104' },
    { id: 'r2', discordId: '2', displayName: 'Afaq', username: null },
  ]
  const out = toNameUpdates(discord, rows)
  assert.deepEqual(out.updates, [{ id: 'r2', displayName: 'Afaq Khawar', username: 'afaqkhawar9299', roleNames: [], avatarUrl: null }])
  assert.deepEqual(out.inserts, [{ discordId: '3', displayName: 'New Person', username: 'newp', roleNames: [], avatarUrl: null }])
})

test('toNameUpdates: names are clipped to the column widths', () => {
  const out = toNameUpdates([m('1', 'x'.repeat(150), 'y'.repeat(80))], [])
  assert.equal(out.inserts[0].displayName.length, 100)
  assert.equal(out.inserts[0].username.length, 64)
})

test('syncGuildMemberNames writes updates and pending inserts through the seam', async () => {
  const calls = []
  let findManyWhere = null
  const db = {
    guildMember: {
      findMany: async ({ where }) => {
        findManyWhere = where
        return [{ id: 'r1', discordId: '1', displayName: 'Old', username: 'nauraiz_101104' }]
      },
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
  assert.equal(findManyWhere.all, true)
  assert.deepEqual(calls[0], ['update', { where: { id: 'r1' }, data: { displayName: 'Nauraiz', username: 'nauraiz_101104', roleNames: [], avatarUrl: null } }])
  assert.equal(calls[1][0], 'upsert')
  assert.equal(calls[1][1].create.status, 'pending')
  assert.equal(calls[1][1].create.displayName, 'Hassan Abid')
})

test('syncOneMember: a member whose stored name differs updates that row', async () => {
  const calls = []
  const db = {
    guildMember: {
      findUnique: async () => ({ id: 'r1', discordId: '1', displayName: 'Old', username: 'oldname' }),
      update: async (a) => { calls.push(['update', a]) },
      upsert: async (a) => { calls.push(['upsert', a]) },
    },
  }
  const member = m('1', 'Nauraiz', 'nauraiz_101104')
  member.guild = { id: 'guild1' }
  await syncOneMember(member, { db })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['update', { where: { id: 'r1' }, data: { displayName: 'Nauraiz', username: 'nauraiz_101104', roleNames: [], avatarUrl: null } }])
})

test('syncOneMember: a member with no row upserts a pending row', async () => {
  const calls = []
  const db = {
    guildMember: {
      findUnique: async () => null,
      update: async (a) => { calls.push(['update', a]) },
      upsert: async (a) => { calls.push(['upsert', a]) },
    },
  }
  const member = m('3', 'New Person', 'newp')
  member.guild = { id: 'guild1' }
  await syncOneMember(member, { db })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'upsert')
  assert.equal(calls[0][1].create.status, 'pending')
  assert.equal(calls[0][1].create.displayName, 'New Person')
  assert.equal(calls[0][1].create.username, 'newp')
})

test('syncOneMember: a bot member makes no db calls', async () => {
  const calls = []
  const db = {
    guildMember: {
      findUnique: async () => { calls.push('findUnique'); return null },
      update: async () => { calls.push('update') },
      upsert: async () => { calls.push('upsert') },
    },
  }
  const member = m('9', 'Helper', 'helper', true)
  member.guild = { id: 'guild1' }
  await syncOneMember(member, { db })
  assert.deepEqual(calls, [])
})

test('syncOneMember: findUnique rejecting resolves rather than throwing, and logs a warning', async () => {
  const originalWarn = console.warn
  const warnCalls = []
  console.warn = (...args) => { warnCalls.push(args) }
  try {
    const db = {
      guildMember: {
        findUnique: async () => { throw new Error('db down') },
        update: async () => {},
        upsert: async () => {},
      },
    }
    const member = m('1', 'Nauraiz', 'nauraiz_101104')
    member.guild = { id: 'guild1' }
    await assert.doesNotReject(syncOneMember(member, { db }))
    assert.equal(warnCalls.length, 1)
    assert.ok(String(warnCalls[0][0]).startsWith('[memberNameSync]'))
  } finally {
    console.warn = originalWarn
  }
})

test('roleNamesOf: sorted, no @everyone, capped at 25 names of 100 chars', () => {
  const member = withRoles(m('1', 'N', 'n'), ['Frontend', '@everyone', 'Senior Dev', 'x'.repeat(150)])
  assert.deepEqual(roleNamesOf(member), ['Frontend', 'Senior Dev', 'x'.repeat(100)])
  const many = withRoles(m('1', 'N', 'n'), Array.from({ length: 30 }, (_, i) => `R${String(i).padStart(2, '0')}`))
  assert.equal(roleNamesOf(many).length, 25)
})

test('toNameUpdates: a changed role list is an update even when names are unchanged', () => {
  const discord = [withRoles(m('1', 'Nauraiz', 'nauraiz_101104'), ['Senior Dev'])]
  const rows = [{ id: 'r1', discordId: '1', displayName: 'Nauraiz', username: 'nauraiz_101104', roleNames: '["Frontend"]' }]
  const out = toNameUpdates(discord, rows)
  assert.deepEqual(out.updates, [{ id: 'r1', displayName: 'Nauraiz', username: 'nauraiz_101104', roleNames: ['Senior Dev'], avatarUrl: null }])
})

test('toNameUpdates: an identical role list (stored as JSON text) is not an update', () => {
  const discord = [withRoles(m('1', 'Nauraiz', 'nauraiz_101104'), ['Frontend', 'Senior Dev'])]
  const rows = [{ id: 'r1', discordId: '1', displayName: 'Nauraiz', username: 'nauraiz_101104', roleNames: '["Frontend","Senior Dev"]' }]
  assert.deepEqual(toNameUpdates(discord, rows).updates, [])
})

const CDN = 'https://cdn.discordapp.com/avatars/1/abc.png?size=64'
const withAvatar = (member, url) => ({ ...member, displayAvatarURL: () => url })

test('avatarUrlOf: accepts a Discord CDN url and refuses anything else', () => {
  assert.equal(avatarUrlOf(withAvatar(m('1', 'N', 'n'), CDN)), CDN)
  assert.equal(avatarUrlOf(withAvatar(m('1', 'N', 'n'), 'https://evil.example/a.png')), null)
  assert.equal(avatarUrlOf(withAvatar(m('1', 'N', 'n'), 'http://cdn.discordapp.com/a.png')), null)
  assert.equal(avatarUrlOf(m('1', 'N', 'n')), null) // no displayAvatarURL at all
  assert.equal(avatarUrlOf(null), null)
})

test('avatarUrlOf: asks for a small static png', () => {
  let asked = null
  avatarUrlOf({ displayAvatarURL: (o) => { asked = o; return CDN } })
  assert.deepEqual(asked, { extension: 'png', size: 64 })
})

test('toNameUpdates: a changed avatar is an update even when names and roles are unchanged', () => {
  const discord = [withAvatar(m('1', 'Nauraiz', 'nauraiz_101104'), CDN)]
  const rows = [{ id: 'r1', discordId: '1', displayName: 'Nauraiz', username: 'nauraiz_101104', roleNames: '[]', avatarUrl: 'https://cdn.discordapp.com/avatars/1/old.png?size=64' }]
  assert.deepEqual(toNameUpdates(discord, rows).updates, [{ id: 'r1', displayName: 'Nauraiz', username: 'nauraiz_101104', roleNames: [], avatarUrl: CDN }])
})

test('toNameUpdates: an unchanged avatar is not an update', () => {
  const discord = [withAvatar(m('1', 'Nauraiz', 'nauraiz_101104'), CDN)]
  const rows = [{ id: 'r1', discordId: '1', displayName: 'Nauraiz', username: 'nauraiz_101104', roleNames: '[]', avatarUrl: CDN }]
  assert.deepEqual(toNameUpdates(discord, rows).updates, [])
})

test('toNameUpdates: an avatar that cannot be read never blanks a stored one', () => {
  const discord = [m('1', 'Renamed', 'nauraiz_101104')]
  const rows = [{ id: 'r1', discordId: '1', displayName: 'Old', username: 'nauraiz_101104', roleNames: '[]', avatarUrl: CDN }]
  assert.equal(toNameUpdates(discord, rows).updates[0].avatarUrl, CDN)
})

test('toNameUpdates: a new member carries their avatar into the insert', () => {
  const out = toNameUpdates([withAvatar(m('3', 'New', 'newp'), CDN)], [])
  assert.equal(out.inserts[0].avatarUrl, CDN)
})
