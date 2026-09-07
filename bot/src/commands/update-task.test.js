import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectChoices, NO_PROJECT } from './update-task.js'

const projects = [
  { id: 'p-fw', name: 'Framework' },
  { id: 'p-hms', name: 'Badar HMS' },
  { id: 'p-cs', name: 'CSAAS' },
]

test('"No project" is first and detaching carries the sentinel value', () => {
  const out = projectChoices(projects, '')
  assert.equal(out[0].value, NO_PROJECT)
  assert.match(out[0].name, /^No project/)
})

test('projects are listed by name, not database order', () => {
  const out = projectChoices(projects, '')
  assert.deepEqual(out.slice(1).map((c) => c.name), ['Badar HMS', 'CSAAS', 'Framework'])
})

test('typing filters case-insensitively and keeps the detach entry', () => {
  const out = projectChoices(projects, 'hms')
  assert.deepEqual(out.map((c) => c.value), [NO_PROJECT, 'p-hms'])
})

test('never more than 25 choices, and names never exceed 100 characters', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, name: `Project ${'n'.repeat(120)} ${i}` }))
  const out = projectChoices(many, '')
  assert.ok(out.length <= 25)
  for (const c of out) assert.ok(c.name.length <= 100)
})
