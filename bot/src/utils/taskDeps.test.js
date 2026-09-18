import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openBlockers, wouldCycle, blockerWarning, unblockNotice, isTerminal, TERMINAL_STATUSES, TASK_STATUSES } from './taskDeps.js'
import { TERMINAL_STATUSES as TERMINAL_STATUSES_FROM_NOTIFY } from '../services/taskUpdateNotify.js'

const tasks = {
  A: { id: 'A', title: 'Git Sync', status: 'open' },
  B: { id: 'B', title: 'Router fix', status: 'in_progress' },
  C: { id: 'C', title: 'Error handling', status: 'done' },
  D: { id: 'D', title: 'Components', status: 'open' },
}
const dep = (taskId, blockedByTaskId) => ({ taskId, blockedByTaskId })

test('isTerminal recognises exactly closed, done, resolved', () => {
  for (const s of ['closed', 'done', 'resolved']) assert.equal(isTerminal(s), true)
  for (const s of ['open', 'pending', 'in_progress', '', null, undefined]) assert.equal(isTerminal(s), false)
})

test('openBlockers lists blockers whose status is not terminal, in dependency order', () => {
  const deps = [dep('A', 'C'), dep('A', 'B'), dep('A', 'D')]
  assert.deepEqual(openBlockers('A', deps, tasks).map((t) => t.id), ['B', 'D'])
})

test('openBlockers ignores rows for other tasks and blockers that no longer exist', () => {
  const deps = [dep('D', 'B'), dep('A', 'ZZZ')]
  assert.deepEqual(openBlockers('A', deps, tasks), [])
})

test('wouldCycle: a task cannot block itself', () => {
  assert.equal(wouldCycle('A', 'A', []), true)
})

test('wouldCycle: direct reverse edge is a cycle', () => {
  // B is blocked by A already; making A blocked by B closes the loop.
  assert.equal(wouldCycle('A', 'B', [dep('B', 'A')]), true)
})

test('wouldCycle: two-hop cycle is caught', () => {
  // C blocked by B, B blocked by A; A blocked by C would loop.
  assert.equal(wouldCycle('A', 'C', [dep('C', 'B'), dep('B', 'A')]), true)
})

test('wouldCycle: an unrelated chain is fine', () => {
  assert.equal(wouldCycle('A', 'B', [dep('C', 'D')]), false)
})

test('blockerWarning names each open blocker with its status, empty when none', () => {
  assert.equal(blockerWarning([]), '')
  assert.equal(
    blockerWarning([tasks.B, tasks.D]),
    '⛔ Still blocked by: **Router fix** (in progress), **Components** (open)',
  )
})

test('unblockNotice says how many remain, or that the task is free', () => {
  assert.equal(unblockNotice(tasks.C, 2), '✅ Blocker **Error handling** is done. 2 blockers still open.')
  assert.equal(unblockNotice(tasks.C, 1), '✅ Blocker **Error handling** is done. 1 blocker still open.')
  assert.equal(unblockNotice(tasks.C, 0), '✅ Blocker **Error handling** is done. This task is no longer blocked.')
})

test('TERMINAL_STATUSES exported from taskUpdateNotify.js is the same object as from taskDeps.js', () => {
  assert.equal(TERMINAL_STATUSES_FROM_NOTIFY, TERMINAL_STATUSES)
})

test('TASK_STATUSES lists every status a task can hold, in board order', () => {
  assert.deepEqual(TASK_STATUSES, ['open', 'pending', 'in_progress', 'resolved', 'closed', 'done'])
})
