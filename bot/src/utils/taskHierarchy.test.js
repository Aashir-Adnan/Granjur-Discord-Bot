import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isFinished, openChildren, subtaskProgress, finishBlockMessage, parentNextStatus, checklistText, childStats,
  TaskRuleError, AUTO_LABEL, MAX_SUBTASKS,
} from './taskHierarchy.js'

const kid = (id, status, extra = {}) => ({ id, title: `Sub ${id}`, status, ...extra })
const parent = (status) => ({ id: 'P', title: 'Parent', status })

test('finished means done, closed or resolved and nothing else', () => {
  for (const s of ['done', 'closed', 'resolved']) assert.equal(isFinished(s), true)
  for (const s of ['open', 'pending', 'in_progress', '', null, undefined]) assert.equal(isFinished(s), false)
})

test('progress counts finished subtasks', () => {
  assert.deepEqual(subtaskProgress([kid('a', 'done'), kid('b', 'open'), kid('c', 'closed')]), { done: 2, total: 3 })
  assert.deepEqual(subtaskProgress([]), { done: 0, total: 0 })
  assert.equal(openChildren([kid('a', 'done'), kid('b', 'pending')]).length, 1)
})

test('a parent cannot be finished while a subtask is open, and the message names them', () => {
  const kids = [kid('a', 'done'), kid('b', 'open'), kid('c', 'in_progress')]
  for (const s of ['done', 'closed', 'resolved']) {
    const msg = finishBlockMessage(parent('open'), kids, s)
    assert.match(msg, /can't be marked/)
    assert.match(msg, /2 subtasks are still open/)
    assert.match(msg, /Sub b/)
    assert.doesNotMatch(msg, /Sub a/)
  }
  assert.match(finishBlockMessage(parent('open'), [kid('b', 'open')], 'done'), /1 subtask is still open/)
})

test('only finishing is blocked: any other move, or finishing with all subtasks done, is allowed', () => {
  const open = [kid('a', 'open')]
  for (const s of ['open', 'pending', 'in_progress']) assert.equal(finishBlockMessage(parent('open'), open, s), null)
  assert.equal(finishBlockMessage(parent('open'), [kid('a', 'done'), kid('b', 'resolved')], 'done'), null)
  assert.equal(finishBlockMessage(parent('open'), [], 'done'), null)
})

test('the block message lists at most five and counts the rest', () => {
  const many = Array.from({ length: 8 }, (_, i) => kid(`k${i}`, 'open'))
  const msg = finishBlockMessage(parent('open'), many, 'done')
  assert.match(msg, /8 subtasks are still open/)
  assert.match(msg, /…and 3 more/)
  assert.equal((msg.match(/• /g) || []).length, 5)
})

test('the parent becomes done when the last subtask is finished', () => {
  assert.equal(parentNextStatus(parent('in_progress'), [kid('a', 'done'), kid('b', 'closed')]), 'done')
  assert.equal(parentNextStatus(parent('open'), [kid('a', 'resolved')]), 'done')
})

test('the parent stays put while a subtask is open, or when it has no subtasks', () => {
  assert.equal(parentNextStatus(parent('in_progress'), [kid('a', 'done'), kid('b', 'open')]), null)
  assert.equal(parentNextStatus(parent('open'), []), null)
  assert.equal(parentNextStatus(parent('done'), [kid('a', 'done')]), null)
})

test('a finished parent goes back to in progress when a subtask is open again or added', () => {
  for (const s of ['done', 'closed', 'resolved']) {
    assert.equal(parentNextStatus(parent(s), [kid('a', 'done'), kid('b', 'open')]), 'in_progress')
  }
})

test('the automatic labels name why, and the subtask cap matches a select menu', () => {
  assert.match(AUTO_LABEL.done, /all subtasks done/)
  assert.match(AUTO_LABEL.in_progress, /open again/)
  assert.equal(MAX_SUBTASKS, 25)
  const err = new TaskRuleError('nope')
  assert.equal(err.status, 409)
  assert.ok(err instanceof Error)
})

test('the checklist ticks finished subtasks and names who holds the open ones', () => {
  const text = checklistText(
    [kid('a', 'done', { assigneeIds: ['u1'] }), kid('b', 'open', { assigneeIds: '["u2","u3"]' }), kid('c', 'open')],
    (id) => ({ u1: 'Ana', u2: 'Ben' })[id] ?? null,
  )
  assert.equal(text, '☑ Sub a — Ana\n☐ Sub b — Ben, <@u3>\n☐ Sub c')
  assert.equal(checklistText([]), 'No subtasks yet')
})

test('the checklist is clipped to the field limit', () => {
  const many = Array.from({ length: 25 }, (_, i) => kid(`k${i}`, 'open', { title: 'T'.repeat(80) }))
  assert.ok(checklistText(many).length <= 1000)
})

test('childStats totals subtasks per parent', () => {
  const rows = [
    { id: 'P' }, kid('a', 'done', { parentTaskId: 'P' }), kid('b', 'open', { parentTaskId: 'P' }), kid('c', 'open', { parentTaskId: 'Q' }),
  ]
  assert.deepEqual([...childStats(rows)], [['P', { done: 1, total: 2 }], ['Q', { done: 0, total: 1 }]])
})
