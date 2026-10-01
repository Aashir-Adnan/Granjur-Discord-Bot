import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memberIdsNamed } from './memberSearch.js'

const guildWith = (members) => ({ members: { cache: new Map(members.map((m) => [m.id, m])) } })

test('matches display name or username, case-insensitively, by substring', () => {
  const guild = guildWith([
    { id: '1', displayName: 'Ali Raza', user: { username: 'aliraza' } },
    { id: '2', displayName: 'Umar', user: { username: 'umar_cs' } },
    { id: '3', displayName: 'Nauraiz', user: { username: 'ali_h' } },
  ])
  assert.deepEqual(memberIdsNamed(guild, 'ALI'), ['1', '3'])
  assert.deepEqual(memberIdsNamed(guild, 'umar_'), ['2'])
})

test('an empty term matches nobody, and the list is capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: String(i), displayName: `Dev ${i}` }))
  assert.deepEqual(memberIdsNamed(guildWith(many), ''), [])
  assert.deepEqual(memberIdsNamed(guildWith(many), '   '), [])
  assert.equal(memberIdsNamed(guildWith(many), 'dev').length, 10)
  assert.equal(memberIdsNamed(guildWith(many), 'dev', { max: 3 }).length, 3)
})

test('a guild without a member cache yields nothing rather than throwing', () => {
  assert.deepEqual(memberIdsNamed(null, 'x'), [])
  assert.deepEqual(memberIdsNamed({}, 'x'), [])
})
