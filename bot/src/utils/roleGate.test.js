import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  memberPassesRoleGate,
  roleIdsAreStale,
  LEADERSHIP_ROLE_NAMES,
} from './roleGate.js'

const guildWith = (roles) => ({
  id: 'g1',
  roles: { cache: { has: (id) => roles.some((r) => r.id === id) } },
})

const memberWith = (roles, { admin = false } = {}) => ({
  permissions: { has: (p) => admin && p === 'Administrator' },
  roles: { cache: { some: (fn) => roles.some(fn) } },
})

const CEO = { id: 'r-ceo', name: 'CEO' }
const MGR = { id: 'r-mgr', name: 'Server Manager' }
const DEV = { id: 'r-dev', name: 'Junior Dev' }
const guild = guildWith([CEO, MGR, DEV])

test('a configured, live id lets its holder through', () => {
  const member = memberWith([MGR, DEV])
  assert.equal(memberPassesRoleGate(guild, member, ['r-ceo', 'r-mgr'], LEADERSHIP_ROLE_NAMES), true)
})

test('a live configured list still excludes everyone not on it', () => {
  // The names would match, but the ids are live, so the configuration stands.
  const member = memberWith([{ id: 'r-mgr-old', name: 'Server Manager' }])
  assert.equal(memberPassesRoleGate(guild, member, ['r-ceo'], LEADERSHIP_ROLE_NAMES), false)
})

test('stale ids fall back to role names — the recreated-roles lockout', () => {
  const member = memberWith([MGR, DEV])
  // Both configured ids belong to roles this guild no longer has.
  assert.equal(memberPassesRoleGate(guild, member, ['old-1', 'old-2'], LEADERSHIP_ROLE_NAMES), true)
})

test('stale ids do not let an unrelated role through', () => {
  const member = memberWith([DEV])
  assert.equal(memberPassesRoleGate(guild, member, ['old-1'], LEADERSHIP_ROLE_NAMES), false)
})

test('an empty list falls back to names too', () => {
  assert.equal(memberPassesRoleGate(guild, memberWith([CEO]), [], LEADERSHIP_ROLE_NAMES), true)
  assert.equal(memberPassesRoleGate(guild, memberWith([DEV]), [], LEADERSHIP_ROLE_NAMES), false)
})

test('an Administrator always passes, and a missing member never does', () => {
  assert.equal(memberPassesRoleGate(guild, memberWith([DEV], { admin: true }), ['r-ceo'], []), true)
  assert.equal(memberPassesRoleGate(guild, null, ['r-ceo'], LEADERSHIP_ROLE_NAMES), false)
})

test('roleIdsAreStale flags only a list where no id is live', () => {
  assert.equal(roleIdsAreStale(guild, ['old-1', 'old-2']), true)
  assert.equal(roleIdsAreStale(guild, ['old-1', 'r-ceo']), false)
  assert.equal(roleIdsAreStale(guild, []), false)
})
