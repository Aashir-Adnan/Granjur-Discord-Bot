import { test } from 'node:test'
import assert from 'node:assert/strict'
import { idList, holdersOf, taskChoiceLabel } from './taskLabel.js'

test('idList tolerates arrays, JSON strings, and junk', () => {
  assert.deepEqual(idList(['1', '2']), ['1', '2'])
  assert.deepEqual(idList('["1","2"]'), ['1', '2'])
  assert.deepEqual(idList('[]'), [])
  assert.deepEqual(idList(null), [])
  assert.deepEqual(idList('not json'), [])
  assert.deepEqual(idList('{"a":1}'), [])
  assert.deepEqual(idList([null, '3', '']), ['3'])
})

test('holdersOf prefers assignees and falls back to tagged members', () => {
  assert.deepEqual(holdersOf({ assigneeIds: ['1'], taggedMemberIds: ['2'] }), ['1'])
  assert.deepEqual(holdersOf({ assigneeIds: [], taggedMemberIds: ['2'] }), ['2'])
  assert.deepEqual(holdersOf({}), [])
})

test('taskChoiceLabel names the task, its status and its holder', () => {
  const label = taskChoiceLabel(
    { title: 'Fix the landing page APIs', status: 'open', assigneeIds: ['11'] },
    { nameFor: (id) => (id === '11' ? 'Usama_Ijaz' : null) },
  )
  assert.equal(label, 'Fix the landing page APIs · open · Usama_Ijaz')
})

test('an unassigned task says so rather than going blank', () => {
  assert.equal(
    taskChoiceLabel({ title: 'Audit encryption', status: 'open' }),
    'Audit encryption · open · unassigned',
  )
})

test('an unresolvable id falls back to the id itself', () => {
  assert.match(taskChoiceLabel({ title: 'T', status: 'open', assigneeIds: ['99'] }), /· 99$/)
})

test('a long title is trimmed, never the status or the holder', () => {
  const label = taskChoiceLabel(
    {
      title: 'Audit the HMS encryption architecture end-to-end — identify every layer where AES encryption is applied',
      status: 'in_progress',
      assigneeIds: ['11'],
    },
    { nameFor: () => 'Nauraiz' },
  )
  assert.ok(label.length <= 100, `length ${label.length}`)
  assert.ok(label.endsWith(' · in_progress · Nauraiz'), label)
  assert.ok(label.startsWith('Audit the HMS encryption'), label)
})

test('a label is capped even when the holders alone overflow', () => {
  const label = taskChoiceLabel(
    { title: 'T', status: 'open', assigneeIds: Array.from({ length: 12 }, (_, i) => `name-${i}`) },
    { max: 60 },
  )
  assert.ok(label.length <= 60, `length ${label.length}`)
})

test('the project sits between the title and the status', () => {
  assert.equal(
    taskChoiceLabel({ title: 'Fix login', status: 'open', assigneeIds: ['1'] }, { nameFor: () => 'Ana', projectName: 'Badar HMS' }),
    'Fix login · Badar HMS · open · Ana',
  )
})

test('a long project name is shortened, and a long title still keeps status and holder', () => {
  const label = taskChoiceLabel(
    { title: 'T'.repeat(120), status: 'in_progress', assigneeIds: ['1'] },
    { nameFor: () => 'Nauraiz', projectName: 'A very long project name that goes on and on' },
  )
  assert.ok(label.length <= 100, `length ${label.length}`)
  assert.ok(label.endsWith(' · in_progress · Nauraiz'), label)
  assert.match(label, /· A very long project n… ·/)
})

test('the project is dropped first when there is no room for it', () => {
  const label = taskChoiceLabel(
    { title: 'T', status: 'open', assigneeIds: ['1'] },
    { nameFor: () => 'Ana', projectName: 'Badar HMS', max: 34 },
  )
  assert.ok(label.length <= 34, `length ${label.length}`)
  assert.doesNotMatch(label, /Badar/)
})
