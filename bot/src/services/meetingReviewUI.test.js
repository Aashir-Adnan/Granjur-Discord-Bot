import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initReviewState,
  applyReviewAction,
  summarizeApproval,
  buildReviewMessage,
  PAGE_SIZE,
  pageSizeFor,
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
  // GitHub starts on (sub-project 4), so the toggle turns it off.
  assert.equal(s.tasks.find((t) => t.taskId === 'a').github, false)
  // original untouched
  assert.equal(orig.tasks.find((t) => t.taskId === 'b').assigneeRef, null)
  assert.equal(orig.tasks.find((t) => t.taskId === 'a').github, true)
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
  // Both start with GitHub on; b is dropped, so only a counts.
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
    const msg = buildReviewMessage({ job, notes: 'notes here', state: s, roster })
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
  assert.equal(toggled.tasks[0].github, false)
  assert.equal(toggled.tasks[1].github, true)

  const dropped = applyReviewAction(toggled, { type: 'rejectTask', taskId: '2' })
  assert.equal(dropped.tasks[0].rejected, true)
  assert.equal(dropped.tasks[1].rejected, false)
})

test('summarizeApproval counts numeric-id tasks against string-id state', () => {
  let state = initReviewState(NUMERIC_TASKS, STRING_ASSIGNMENTS)
  state = applyReviewAction(state, { type: 'rejectTask', taskId: '3' })
  // GitHub is on by default: the one approved task counts.
  const out = summarizeApproval(state, NUMERIC_TASKS)
  assert.equal(out.approved.length, 1)
  assert.equal(out.approved[0].task_id, 2)
  assert.equal(out.rejectedCount, 1)
  assert.equal(out.githubCount, 1)
})

// --- roadmap sub-project 2 (2026-09-29): scope, modules and the project select

const settleFirstOnly = (t) => (t.task_id === 'a' ? { projectId: 'p1', projectName: 'Framework' } : null)
const PROJECTS = [{ id: 'p1', name: 'Framework' }, { id: 'p2', name: 'Badar HMS' }]
const rowsJson = (msg) => JSON.stringify(msg.components.map((c) => c.toJSON()))

test('initReviewState marks only unsettled tasks as needing a project', () => {
  const s = initReviewState(tasks, assignments, settleFirstOnly)
  const a = s.tasks.find((t) => t.taskId === 'a')
  const b = s.tasks.find((t) => t.taskId === 'b')
  assert.deepEqual([a.needsProject, a.projectId, a.projectLabel], [false, null, 'Framework'])
  assert.deepEqual([b.needsProject, b.projectId, b.projectLabel], [true, null, null])
})

test('initReviewState without a settle function asks about nothing (legacy callers)', () => {
  const s = initReviewState(tasks, assignments)
  assert.ok(s.tasks.every((t) => t.needsProject === false && t.projectId === null))
})

test('the project action sets or clears the pick, targeted and immutable', () => {
  const s0 = initReviewState(tasks, assignments, settleFirstOnly)
  const s1 = applyReviewAction(s0, { type: 'project', taskId: 'b', projectId: 'p2' })
  assert.equal(s1.tasks.find((t) => t.taskId === 'b').projectId, 'p2')
  assert.equal(s0.tasks.find((t) => t.taskId === 'b').projectId, null)
  const s2 = applyReviewAction(s1, { type: 'project', taskId: 'b', projectId: 'none' })
  assert.equal(s2.tasks.find((t) => t.taskId === 'b').projectId, null)
})

test('pageSizeFor is 1 while any task needs a project, even a rejected one', () => {
  assert.equal(PAGE_SIZE, 2)
  assert.equal(pageSizeFor(initReviewState(tasks, assignments)), 2)
  const s = initReviewState(tasks, assignments, settleFirstOnly)
  assert.equal(pageSizeFor(s), 1)
  assert.equal(pageSizeFor(applyReviewAction(s, { type: 'rejectTask', taskId: 'b' })), 1)
  assert.equal(pageSizeFor(undefined), 2)
})

test('an unclear task gets the project select; every page stays within 5 rows', () => {
  const three = [
    { task_id: 'a', goal_of_task: 'A' },
    { task_id: 'b', goal_of_task: 'B' },
    { task_id: 'c', goal_of_task: 'C' },
  ]
  const job = { id: 'JOB7', dataJson: { title: 'Sync', tasks: three, assignments: [], reviewProjects: PROJECTS } }
  const state = initReviewState(three, [], settleFirstOnly)
  // b and c are unclear, so one task per page: three pages.
  const first = buildReviewMessage({ job, notes: '', state, roster: [] })
  assert.match(first.embeds[0].data.description, /Page 1\/3/)
  for (const page of [0, 1, 2]) {
    const msg = buildReviewMessage({ job, notes: '', state: applyReviewAction(state, { type: 'page', page }), roster: [] })
    assert.ok(msg.components.length <= 5, `page ${page} rows ${msg.components.length}`)
  }
  const pageA = rowsJson(buildReviewMessage({ job, notes: '', state, roster: [] }))
  assert.ok(!pageA.includes('mtg_project:'), 'a settled task has no project select')
  const pageB = buildReviewMessage({ job, notes: '', state: applyReviewAction(state, { type: 'page', page: 1 }), roster: [] })
  const selectRow = pageB.components.map((c) => c.toJSON()).find((r) => r.components[0].custom_id === 'mtg_project:JOB7:b')
  assert.ok(selectRow, 'the project select for b')
  const select = selectRow.components[0]
  assert.equal(select.placeholder, 'Which project?')
  assert.deepEqual(select.options.map((o) => o.value), ['p1', 'p2', 'none'])
  assert.equal(select.options[2].label, 'No project')
})

test('the project select marks the current pick and never offers more than 25 options', () => {
  const one = [{ task_id: 'b', goal_of_task: 'B' }]
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `id${i}`, name: `P${i}` }))
  const job = { id: 'J', dataJson: { tasks: one, assignments: [], reviewProjects: many } }
  let state = initReviewState(one, [], () => null)
  state = applyReviewAction(state, { type: 'project', taskId: 'b', projectId: 'id3' })
  const select = buildReviewMessage({ job, notes: '', state, roster: [] })
    .components.map((c) => c.toJSON()).find((r) => r.components[0].custom_id === 'mtg_project:J:b').components[0]
  assert.equal(select.options.length, 25)
  assert.equal(select.options.find((o) => o.value === 'id3').default, true)
})

test('the task embed shows Scope, Modules and Project', () => {
  const two = [
    { task_id: 'a', goal_of_task: 'A', platform: 'node', feature: 'GitSync', sub_feature: 'Webhooks' },
    { task_id: 'b', goal_of_task: 'B', scope: 'design' },
  ]
  const job = { id: 'J', dataJson: { tasks: two, assignments: [], reviewProjects: PROJECTS } }
  let state = initReviewState(two, [], settleFirstOnly)
  const pageA = buildReviewMessage({ job, notes: '', state, roster: [] }).embeds[1].data.description
  assert.match(pageA, /\*\*Scope:\*\* Backend/)
  assert.match(pageA, /\*\*Modules:\*\* GitSync, Webhooks/)
  assert.match(pageA, /\*\*Project:\*\* Framework/)
  state = applyReviewAction(state, { type: 'page', page: 1 })
  let pageB = buildReviewMessage({ job, notes: '', state, roster: [] }).embeds[1].data.description
  assert.match(pageB, /\*\*Scope:\*\* Design/)
  assert.ok(!/Modules:/.test(pageB))
  assert.match(pageB, /\*\*Project:\*\* not set, pick one below/)
  state = applyReviewAction(state, { type: 'project', taskId: 'b', projectId: 'p2' })
  pageB = buildReviewMessage({ job, notes: '', state, roster: [] }).embeds[1].data.description
  assert.match(pageB, /\*\*Project:\*\* Badar HMS/)
})

test('a task with no usable scope says so; a legacy state shows no project line', () => {
  const one = [{ task_id: 'x', goal_of_task: 'X', feature: 'Free text' }]
  const job = { id: 'J', dataJson: { tasks: one, assignments: [] } }
  const desc = buildReviewMessage({ job, notes: '', state: initReviewState(one, []), roster: [] }).embeds[1].data.description
  assert.match(desc, /\*\*Scope:\*\* none/)
  assert.ok(!/Project:/.test(desc))
})

// --- roadmap sub-project 4 (2026-09-30): GitHub issues are on by default

test('initReviewState starts every task with GitHub on', () => {
  const s = initReviewState(tasks, assignments)
  assert.ok(s.tasks.every((t) => t.github === true))
  const off = applyReviewAction(s, { type: 'toggleGithub', taskId: 'b' })
  assert.equal(off.tasks.find((t) => t.taskId === 'b').github, false)
  assert.equal(off.tasks.find((t) => t.taskId === 'a').github, true)
})

test('the review message shows GitHub on, including for a task missing from the state', () => {
  const job = { id: 'J', dataJson: { tasks, assignments } }
  for (const state of [initReviewState(tasks, assignments), { tasks: [], page: 0 }]) {
    const msg = buildReviewMessage({ job, notes: '', state, roster: [] })
    const buttons = msg.components.map((c) => c.toJSON()).flatMap((r) => r.components)
    const gh = buttons.filter((b) => String(b.custom_id).startsWith('mtg_gh:'))
    assert.equal(gh.length, 2)
    assert.ok(gh.every((b) => b.label === 'GitHub: on'))
    assert.match(msg.embeds[1].data.description, /\*\*GitHub issue:\*\* yes/)
  }
})

test('buildReviewMessage points at the attached notes when notesAttached, with no report-path line', () => {
  const job = { id: 'J', dataJson: { title: 'Sync', tasks, assignments } }
  const state = initReviewState(tasks, assignments)
  const on = buildReviewMessage({ job, notes: 'the notes', notesAttached: true, state, roster: [] })
  const off = buildReviewMessage({ job, notes: 'the notes', notesAttached: false, state, roster: [] })
  const desc = (m) => m.embeds[0].data.description
  assert.match(desc(on), /the notes\n+Full notes are attached above\./)
  assert.doesNotMatch(desc(off), /attached above/)
  assert.doesNotMatch(desc(on), /Full report|on the VM/)
  assert.doesNotMatch(desc(off), /Full report|on the VM/)
})
