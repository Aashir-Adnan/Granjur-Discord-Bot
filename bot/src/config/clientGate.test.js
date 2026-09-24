import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canUseCommand, getClientCommands, memberIsClient } from './commands.js'

// A member as canUseCommand sees one: roles as a Collection-like Map with
// `.some` and `.has`, permissions with `.has`, and a guild with an owner.
function member({ roles = [], owner = false, perms = [] } = {}) {
  const cache = new Map(roles.map((r) => [r.id, r]))
  cache.some = (fn) => [...cache.values()].some(fn)
  return {
    id: owner ? 'owner' : 'u1',
    guild: { ownerId: 'owner' },
    permissions: { has: (p) => perms.includes(p) },
    roles: { cache },
  }
}

const CLIENT = { id: 'r-client', name: 'Client' }
const VERIFIED = { id: 'r-verified', name: 'Verified' }

test('clientCommands is exactly the five the spec lists', () => {
  assert.deepEqual(getClientCommands(), ['verify', 'report-issue', 'request-feature', 'my-requests', 'request-report'])
})

test('a client may run only the client commands — an empty role list is not "anyone" for them', () => {
  const m = member({ roles: [CLIENT] })
  assert.equal(canUseCommand(m, 'my-requests'), true)
  assert.equal(canUseCommand(m, 'report-issue'), true)
  assert.equal(canUseCommand(m, 'close-feature'), false, 'close-feature has an empty role list')
  assert.equal(canUseCommand(m, 'time-report'), false)
  assert.equal(canUseCommand(m, 'no-such-command'), false, 'absent from the map is still denied')
})

test('a staff member is unaffected by the client rule', () => {
  const m = member({ roles: [VERIFIED] })
  assert.equal(canUseCommand(m, 'close-feature'), true)
  assert.equal(canUseCommand(m, 'my-requests'), false, 'client commands are gated on Client')
})

test('client by stored id, renamed role, still denied', () => {
  const renamed = { id: 'r-client', name: 'Customer' }
  const m = member({ roles: [renamed, VERIFIED] })
  assert.equal(memberIsClient(m, 'r-client'), true)
  assert.equal(canUseCommand(m, 'close-feature', { clientRoleId: 'r-client' }), false)
  // Without the id the name is all there is, and it no longer matches.
  assert.equal(memberIsClient(m), false)
})

test('the guild owner and Manage Server keep their bypass', () => {
  assert.equal(canUseCommand(member({ owner: true, roles: [CLIENT] }), 'init'), true)
  assert.equal(canUseCommand(member({ perms: ['ManageGuild'], roles: [CLIENT] }), 'init'), true)
})
