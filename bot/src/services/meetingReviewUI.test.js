import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initReviewState,
  applyReviewAction,
  summarizeApproval,
  buildReviewMessage,
  PAGE_SIZE,
} from './meetingReviewUI.js'

const tasks = [
  { task_id: 'a', goal_of_task: 'A' },
  { task_id: 'b', goal_of_task: 'B' },
]
const assignments = [
  { task_id: 'a', assignee_ref: '11' },
  { task_id: 'b', assignee_ref: null },
]

test('initReviewState seeds from assignments', () => {
  const s = initReviewState(tasks, assignments)
  assert.equal(s.tasks.find((t) => t.taskId === 'a').assigneeRef, '11')
  assert.equal(s.tasks.find((t) => t.taskId === 'b').assigneeRef, null)
  assert.equal(s.page, 0)
})

test('actions are immutable and targeted', () => {
  let s = initReviewState(tasks, assignments)
  const orig = s
  s = applyReviewAction(s, { type: 'assignee', taskId: 'b', ref: '22' })
  s = applyReviewAction(s, { type: 'toggleGithub', taskId: 'a' })
  s = applyReviewAction(s, { type: 'rejectTask', taskId: 'b' })
  assert.equal(s.tasks.find((t) => t.taskId === 'b').assigneeRef, '22')
  assert.equal(s.tasks.find((t) => t.taskId === 'b').rejected, true)
  assert.equal(s.tasks.find((t) => t.taskId === 'a').github, true)
  // original untouched
  assert.equal(orig.tasks.find((t) => t.taskId === 'b').assigneeRef, null)
  assert.equal(orig.tasks.find((t) => t.taskId === 'a').github, false)
  assert.notEqual(s, orig)
  assert.notEqual(s.tasks, orig.tasks)
})

test('page action sets page', () => {
  let s = initReviewState(tasks, assignments)
  s = applyReviewAction(s, { type: 'page', page: 3 })
  assert.equal(s.page, 3)
})

test('summarizeApproval excludes rejected, counts github', () => {
  let s = initReviewState(tasks, assignments)
  s = applyReviewAction(s, { type: 'toggleGithub', taskId: 'a' })
  s = applyReviewAction(s, { type: 'rejectTask', taskId: 'b' })
  const sum = summarizeApproval(s, tasks)
  assert.equal(sum.approved.length, 1)
  assert.equal(sum.approved[0].task_id, 'a')
  assert.equal(sum.githubCount, 1)
  assert.equal(sum.rejectedCount, 1)
})

test('buildReviewMessage: 3 tasks -> 2 pages, <=5 rows, customIds carry jobId', () => {
  assert.equal(PAGE_SIZE, 2)
  const three = [
    { task_id: 't1', goal_of_task: 'G1', feature: 'F', sub_feature: 'S', code_residence: 'repo/x' },
    { task_id: 't2', goal_of_task: 'G2' },
    { task_id: 't3', goal_of_task: 'G3' },
  ]
  const asg = [
    { task_id: 't1', assignee_ref: '11', quote: 'do it' },
    { task_id: 't2', assignee_ref: null },
    { task_id: 't3', assignee_ref: null },
  ]
  const job = { id: 'JOB9', dataJson: { title: 'Sprint Planning', tasks: three, assignments: asg } }
  let state = initReviewState(three, asg)
  const roster = [{ ref: '11', displayName: 'Al', aliases: [] }]

  for (const page of [0, 1]) {
    const s = applyReviewAction(state, { type: 'page', page })
    const msg = buildReviewMessage({ job, notes: 'notes here', reportPath: '/vm/report.md', state: s, roster })
    assert.ok(Array.isArray(msg.embeds))
    assert.ok(Array.isArray(msg.components))
    assert.ok(msg.components.length <= 5, `page ${page} rows ${msg.components.length}`)
    const json = JSON.stringify(msg.components.map((c) => c.toJSON()))
    assert.ok(json.includes('JOB9'), `page ${page} missing jobId in customIds`)
    assert.ok(json.includes('mtg_approve:JOB9'))
    assert.ok(json.includes('mtg_page:JOB9:'))
  }
})

// --- regression: CSAAS sends task_id as a number in the task list and as a
// string in the assignment list; a Discord customId always carries a string.
// On 2026-09-04 every strict comparison missed, so a 0.92-confidence
// auto-assignment never reached the picker and clicking the picker did nothing.

const NUMERIC_TASKS = [
  { task_id: 2, goal_of_task: 'Fix the landing page APIs' },
  { task_id: 3, goal_of_task: 'Audit the encryption architecture' },
]
const STRING_ASSIGNMENTS = [
  { task_id: '2', assignee_ref: '1544234821419532349', confidence: 0.92 },
  { task_id: '3', assignee_ref: null, confidence: 0 },
]

test('a string-keyed assignment reaches a number-keyed task', () => {
  const state = initReviewState(NUMERIC_TASKS, STRING_ASSIGNMENTS)
  assert.equal(state.tasks[0].assigneeRef, '1544234821419532349')
  assert.equal(state.tasks[1].assigneeRef, null)
  // ids are normalised to strings so later comparisons cannot drift back
  assert.deepEqual(state.tasks.map((t) => t.taskId), ['2', '3'])
})

test('a customId string taskId still matches a numeric task', () => {
  const state = initReviewState(NUMERIC_TASKS, [])
  // '3' is what parseReviewCustomId slices out of `mtg_assignee:<job>:3`
  const assigned = applyReviewAction(state, { type: 'assignee', taskId: '3', ref: '99' })
  assert.equal(assigned.tasks[1].assigneeRef, '99')
  assert.equal(assigned.tasks[0].assigneeRef, null)

  const toggled = applyReviewAction(assigned, { type: 'toggleGithub', taskId: '2' })
  assert.equal(toggled.tasks[0].github, true)

  const dropped = applyReviewAction(toggled, { type: 'rejectTask', taskId: '2' })
  assert.equal(dropped.tasks[0].rejected, true)
  assert.equal(dropped.tasks[1].rejected, false)
})

test('summarizeApproval counts numeric-id tasks against string-id state', () => {
  let state = initReviewState(NUMERIC_TASKS, STRING_ASSIGNMENTS)
  state = applyReviewAction(state, { type: 'rejectTask', taskId: '3' })
  state = applyReviewAction(state, { type: 'toggleGithub', taskId: '2' })
  const out = summarizeApproval(state, NUMERIC_TASKS)
  assert.equal(out.approved.length, 1)
  assert.equal(out.approved[0].task_id, 2)
  assert.equal(out.rejectedCount, 1)
  assert.equal(out.githubCount, 1)
})
