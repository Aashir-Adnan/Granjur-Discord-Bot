import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectChoices, NO_PROJECT } from './explain.js'

const projects = [
  { id: 'p1', name: 'Framework' },
  { id: 'p2', name: 'Badar HMS' },
  { id: 'p3', name: 'CSAAS' },
]

test('"No project" is always first and carries the sentinel value', () => {
  const out = projectChoices(projects, '')
  assert.equal(out[0].value, NO_PROJECT)
  assert.match(out[0].name, /^No project/)
  // projects (above) are unsorted by insertion order (Framework, Badar HMS,
  // CSAAS) — the rest must come back sorted by name: Badar HMS, CSAAS, Framework.
  assert.deepEqual(out.slice(1).map((c) => c.value), ['p2', 'p3', 'p1'])
})

test('typing filters projects by name, case-insensitively, and keeps "No project"', () => {
  const out = projectChoices(projects, 'hms')
  assert.deepEqual(out.map((c) => c.value), [NO_PROJECT, 'p2'])
})

test('never more than 25 choices and names never over 100 characters', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, name: `Project ${'n'.repeat(120)} ${i}` }))
  const out = projectChoices(many, '')
  assert.ok(out.length <= 25)
  for (const c of out) assert.ok(c.name.length <= 100)
})
