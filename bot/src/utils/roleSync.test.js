import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MANAGED_ROLES, roleDiff, roleSelectOptions } from './roleSync.js'

test('the managed list is the same one /approve offers', () => {
  // /set-roles and /approve must agree, or a role assignable at onboarding
  // becomes un-removable afterwards.
  assert.ok(MANAGED_ROLES.includes('Senior Dev'))
  assert.ok(MANAGED_ROLES.includes('Server Manager'))
  assert.ok(MANAGED_ROLES.includes('CEO'))
  assert.equal(MANAGED_ROLES.length, 15)
})

test('roleDiff adds what was checked and removes what was unchecked', () => {
  const d = roleDiff(['Junior Dev'], ['Senior Dev', 'Frontend'])
  assert.deepEqual(d.add, ['Senior Dev', 'Frontend'])
  assert.deepEqual(d.remove, ['Junior Dev'])
})

test('roleDiff never touches a role outside the managed list', () => {
  // This is the whole safety property. "Verified" grants channel visibility and
  // "Holding" gates onboarding; if an unchecked box could strip them, saving an
  // unrelated role change would lock the member out of every channel.
  const d = roleDiff(['Verified', 'Holding', 'Clocked In', 'Junior Dev'], ['Senior Dev'])
  assert.deepEqual(d.remove, ['Junior Dev'], 'only managed roles are ever removed')
  assert.deepEqual(d.add, ['Senior Dev'])
})

test('an unchanged selection is a no-op', () => {
  const d = roleDiff(['Senior Dev', 'Verified'], ['Senior Dev'])
  assert.deepEqual(d.add, [])
  assert.deepEqual(d.remove, [])
})

test('clearing every box removes only the managed roles', () => {
  const d = roleDiff(['Senior Dev', 'Frontend', 'Verified'], [])
  assert.deepEqual(d.add, [])
  assert.deepEqual(d.remove, ['Senior Dev', 'Frontend'])
})

test('comparison is case-insensitive, because Discord role names drift in case', () => {
  const d = roleDiff(['senior dev'], ['Senior Dev'])
  assert.deepEqual(d.add, [])
  assert.deepEqual(d.remove, [])
})

test('roleSelectOptions pre-ticks what the member already holds', () => {
  const opts = roleSelectOptions(['Senior Dev', 'Verified'])
  assert.equal(opts.length, MANAGED_ROLES.length)
  const senior = opts.find((o) => o.value === 'Senior Dev')
  const junior = opts.find((o) => o.value === 'Junior Dev')
  assert.equal(senior.default, true)
  assert.equal(junior.default, false)
  // Verified is not managed, so it must not appear as a choice at all
  assert.equal(opts.find((o) => o.value === 'Verified'), undefined)
})

test('roleSelectOptions stays inside Discord’s 25-option ceiling', () => {
  assert.ok(roleSelectOptions([]).length <= 25)
})
