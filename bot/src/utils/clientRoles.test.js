import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_PROJECT_ROLES, isClientRole, managerIdsOf, managedProjectIds } from './clientRoles.js'

test('the client roles are client and client_manager, and nothing else', () => {
  assert.deepEqual(CLIENT_PROJECT_ROLES, ['client', 'client_manager'])
  assert.equal(isClientRole('client'), true)
  assert.equal(isClientRole('client_manager'), true)
  assert.equal(isClientRole('lead'), false)
  assert.equal(isClientRole(undefined), false, 'an unknown prior role is NOT a client role — the role revoke must fire')
})

test('managerIdsOf lists the managers on a roster, minus the person asking', () => {
  const rows = [{ discordId: 'm1', role: 'client_manager' }, { discordId: 'c1', role: 'client' }, { discordId: 'm2', role: 'client_manager' }]
  assert.deepEqual(managerIdsOf(rows), ['m1', 'm2'])
  assert.deepEqual(managerIdsOf(rows, 'm1'), ['m2'], 'a manager raising a request is already in the channel')
  assert.deepEqual(managerIdsOf(null), [])
})

test('managedProjectIds is the projects where the rows say client_manager', () => {
  assert.deepEqual(managedProjectIds([{ projectId: 'a', role: 'client_manager' }, { projectId: 'b', role: 'client' }]), ['a'])
})
