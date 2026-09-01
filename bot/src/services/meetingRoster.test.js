import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aliasesFor, buildRoster } from './meetingRoster.js'

const fakeGuild = (names = {}) => ({
  members: {
    fetch: async (id) => {
      if (names[id] === null) throw new Error('unknown member')
      return { displayName: names[id] ?? `disp-${id}`, user: { username: `u${id}` } }
    },
  },
})

const fakeDb = (members, recs) => ({
  guildMember: { findMany: async () => members },
  meetingRecording: { findMany: async () => recs },
})

test('aliasesFor: displayName words + email local part, deduped, no blanks', () => {
  const a = aliasesFor({ displayName: 'Ali Raza', user: { username: 'alir' } }, 'ali.raza@granjur.com')
  assert.ok(a.includes('Ali'))
  assert.ok(a.includes('Ali Raza'))
  assert.ok(a.includes('ali.raza'))
  assert.ok(a.includes('alir'))
  assert.equal(new Set(a).size, a.length)
})

test('aliasesFor: single-char words dropped, no blanks, deduped', () => {
  const a = aliasesFor({ displayName: 'A B Charlie', user: { username: 'Charlie' } }, null)
  assert.ok(!a.includes('A'))
  assert.ok(!a.includes('B'))
  assert.ok(a.includes('Charlie'))
  assert.ok(a.every((x) => x && x.trim().length))
  assert.equal(new Set(a).size, a.length)
})

test('aliasesFor: falls back to globalName then username; tolerates empty member', () => {
  assert.deepEqual(aliasesFor({}, ''), [])
  const a = aliasesFor({ user: { globalName: 'Deep Thought', username: 'dt' } }, 'dt@x.com')
  assert.ok(a.includes('Deep Thought'))
  assert.ok(a.includes('Deep'))
  assert.ok(a.includes('dt'))
})

test('buildRoster: picks the present member when a recording matches', async () => {
  const members = [
    { discordId: '1', email: 'ali@granjur.com' },
    { discordId: '2', email: 'bob@granjur.com' },
  ]
  const roster = await buildRoster({
    guild: fakeGuild({ 1: 'Ali', 2: 'Bob' }),
    guildConfigId: 'g1',
    meetingId: 'm1',
    db: fakeDb(members, [{ memberId: '1' }]),
  })
  assert.equal(roster.length, 1)
  assert.equal(roster[0].ref, '1')
  assert.equal(roster[0].displayName, 'Ali')
  assert.ok(Array.isArray(roster[0].aliases) && roster[0].aliases.includes('Ali'))
})

test('buildRoster: falls back to all verified members when none matched', async () => {
  const members = [
    { discordId: '1', email: 'ali@granjur.com' },
    { discordId: '2', email: 'bob@granjur.com' },
  ]
  const roster = await buildRoster({
    guild: fakeGuild({ 1: 'Ali', 2: 'Bob' }),
    guildConfigId: 'g1',
    meetingId: 'm1',
    db: fakeDb(members, []),
  })
  assert.deepEqual(roster.map((r) => r.ref).sort(), ['1', '2'])
  for (const r of roster) {
    assert.ok(r.ref && r.displayName && Array.isArray(r.aliases))
  }
})

test('buildRoster: displayName falls back to email local-part when member left the guild', async () => {
  const roster = await buildRoster({
    guild: fakeGuild({ 1: null }),
    guildConfigId: 'g1',
    meetingId: 'm1',
    db: fakeDb([{ discordId: '1', email: 'ali.raza@granjur.com' }], [{ memberId: '1' }]),
  })
  assert.equal(roster[0].displayName, 'ali.raza')
})
