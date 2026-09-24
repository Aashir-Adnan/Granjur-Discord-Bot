import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approveMember } from './approval.js'

function harness({ kind = 'staff', roles = ['Verified', 'Holding', 'Senior Dev'] } = {}) {
  const added = []
  const removed = []
  const updates = []
  const guild = {
    id: 'g1',
    roles: { cache: new Map(roles.map((n, i) => [`r${i}`, { id: `r${i}`, name: n }])) },
  }
  const member = { roles: { add: async (r) => { added.push(r?.id ?? r) }, remove: async (r) => { removed.push(r?.id ?? r) } } }
  const db = { guildMember: { update: async (args) => { updates.push(args); return {} } } }
  const cfg = { id: 'cfg1', holdingRoleId: 'r1', verifiedRoleId: 'r0', clientRoleId: null }
  const ensureClient = async () => ({ role: { id: 'r-client', name: 'Client' }, text: { id: 'chan-support' } })
  return { guild, member, db, cfg, added, removed, updates, ensureClient, dbMember: { id: 'm1', roleIds: [], kind } }
}

test('client approval adds Client, removes Holding, never adds Verified, writes kind=client', async () => {
  const h = harness({ kind: 'client' })
  const out = await approveMember({ ...h, asClient: true, update: async () => {} })
  assert.deepEqual(h.added, ['r-client'])
  assert.deepEqual(h.removed, ['r1'])
  assert.ok(!h.added.includes('r0'), 'Verified must never be added to a client')
  assert.equal(h.updates[0].data.status, 'approved')
  assert.equal(h.updates[0].data.kind, 'client')
  assert.equal(out.supportChannelId, 'chan-support')
  assert.deepEqual(out.assigned, ['Client'])
})

test('staff approval is unchanged and writes kind=staff, never Client', async () => {
  const h = harness()
  const out = await approveMember({ ...h, roleNames: ['Senior Dev'], update: async () => {} })
  assert.deepEqual(h.added, ['r2', 'r0'], 'the picked role, then Verified')
  assert.deepEqual(h.removed, ['r1'])
  assert.equal(h.updates[0].data.kind, 'staff')
  assert.deepEqual(h.updates[0].data.roleIds, ['Senior Dev'])
  assert.deepEqual(out.assigned, ['Senior Dev'])
  assert.equal(out.asClient, false)
})
