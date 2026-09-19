import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCOPE_CHOICES, SCOPE_VALUES, isValidScope, scopeLabel } from './taskScope.js'

test('there are exactly four choices, matching the four values', () => {
  assert.equal(SCOPE_CHOICES.length, 4)
  assert.deepEqual(SCOPE_VALUES, ['backend', 'frontend', 'qa', 'design'])
})

test('isValidScope accepts only the four fixed values', () => {
  assert.equal(isValidScope('backend'), true)
  assert.equal(isValidScope('design'), true)
  assert.equal(isValidScope('Backend'), false) // case-sensitive: values, not labels
  assert.equal(isValidScope('GitSync'), false) // an old free-text value
  assert.equal(isValidScope(''), false)
  assert.equal(isValidScope(null), false)
  assert.equal(isValidScope(undefined), false)
})

test('scopeLabel maps a stored value to its display name', () => {
  assert.equal(scopeLabel('backend'), 'Backend')
  assert.equal(scopeLabel('qa'), 'QA')
})

test('scopeLabel passes an old free-text value through unchanged, so legacy tasks keep their label', () => {
  assert.equal(scopeLabel('GitSync'), 'GitSync')
  assert.equal(scopeLabel('Task Hierarchy'), 'Task Hierarchy')
})

test('scopeLabel returns null for a task that has never had a scope', () => {
  assert.equal(scopeLabel(null), null)
  assert.equal(scopeLabel(undefined), null)
})
