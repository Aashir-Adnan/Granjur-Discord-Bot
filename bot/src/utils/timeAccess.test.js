import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLeadershipFor, memberProjectIdsOf } from './timeAccess.js'

// Pure seams only: nothing here touches the real db export.
const guild = { roles: { cache: new Map() } }
const memberWith = (perms, roleIds = []) => ({
  permissions: { has: (p) => perms.includes(p) },
  roles: { cache: { some: (fn) => roleIds.map((id) => ({ id })).some(fn) } },
})

test('an administrator is leadership', () => {
  assert.equal(isLeadershipFor(guild, memberWith(['Administrator']), { dashboardRoleIds: [] }), true)
})

test('a plain member is not leadership', () => {
  assert.equal(isLeadershipFor(guild, memberWith([]), { dashboardRoleIds: [] }), false)
})

test('a member holding a configured dashboard role is leadership', () => {
  const cfg = { dashboardRoleIds: ['r1'] }
  assert.equal(isLeadershipFor(guild, memberWith([], ['r1']), cfg), true)
  assert.equal(isLeadershipFor(guild, memberWith([], ['r2']), cfg), false)
})

test('no member is not leadership', () => {
  assert.equal(isLeadershipFor(guild, null, { dashboardRoleIds: [] }), false)
})

test('memberProjectIdsOf lists the project ids of the person\'s memberships in this server', async () => {
  const seen = []
  const db = { projectMember: { findByMember: async (q) => { seen.push(q); return [{ projectId: 'p1' }, { projectId: 'p2' }] } } }
  assert.deepEqual(await memberProjectIdsOf(db, { id: 'g1' }, 'u1'), ['p1', 'p2'])
  assert.deepEqual(seen, [{ where: { guildConfigId: 'g1', discordId: 'u1' } }])
})

test('memberProjectIdsOf is empty when the read returns nothing', async () => {
  const db = { projectMember: { findByMember: async () => null } }
  assert.deepEqual(await memberProjectIdsOf(db, { id: 'g1' }, 'u1'), [])
})
