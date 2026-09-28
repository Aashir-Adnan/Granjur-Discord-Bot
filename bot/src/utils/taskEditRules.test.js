import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateEdit, validateCreate, MAX_TEST_COUNT, EDIT_KEYS } from './taskEditRules.js'
import { BAD_DURATION } from './timeTracking.js'

const task = {
  id: 'T', guildConfigId: 'g1', type: 'feature', title: 'Git Sync', description: null, status: 'open',
  scope: 'backend', implementationStatus: 'not_started', projectId: 'P1', projectName: 'Framework',
  assigneeIds: ['u1'], taggedMemberIds: [], passedApiTests: null, passedQaTests: 0, passedAcceptanceCriteria: null,
  estimateMinutes: 120,
}
const ctx = {
  projectsById: new Map([['P1', { id: 'P1', name: 'Framework' }], ['P2', { id: 'P2', name: 'Badar HMS' }]]),
  memberIds: new Set(['u1', 'u2', 'u3']),
  tasksById: new Map([['B', { id: 'B', title: 'Blocker' }], ['C', { id: 'C', title: 'Chain' }]]),
  deps: [],
}
const edit = (changes, t = task, c = ctx) => validateEdit(t, changes, c)

test('the edit keys are exactly the spec fields', () => {
  assert.deepEqual(EDIT_KEYS, ['status', 'title', 'description', 'scope', 'implementationStatus', 'projectId',
    'holderIds', 'passedApiTests', 'passedQaTests', 'passedAcceptanceCriteria', 'estimate', 'blockerIds'])
})
test('a non-object or an unknown key is refused', () => {
  assert.equal(edit(null).error, 'changes must be an object.')
  assert.equal(edit(['status']).error, 'changes must be an object.')
  assert.equal(edit({ priority: 'high' }).error, 'priority cannot be changed.')
})
test('status: one of the six, unchanged is dropped', () => {
  assert.deepEqual(edit({ status: 'in_progress' }).updates, { status: 'in_progress' })
  assert.match(edit({ status: 'flying' }).error, /^status must be one of open, pending/)
  assert.deepEqual(edit({ status: 'open' }).updates, {})
})
test('title: trimmed, required, at most 200', () => {
  assert.deepEqual(edit({ title: '  New name  ' }).updates, { title: 'New name' })
  assert.equal(edit({ title: '   ' }).error, 'A task needs a title.')
  assert.equal(edit({ title: 42 }).error, 'A task needs a title.')
  assert.equal(edit({ title: 'x'.repeat(201) }).error, 'The title can be at most 200 characters.')
})
test('description: blank is null, null equals null, at most 2000', () => {
  assert.deepEqual(edit({ description: '' }).updates, {}, 'null in the DB and "" from a form are the same')
  assert.deepEqual(edit({ description: ' hi ' }).updates, { description: 'hi' })
  assert.deepEqual(edit({ description: '' }, { ...task, description: 'old' }).updates, { description: null })
  assert.equal(edit({ description: 'x'.repeat(2001) }).error, 'The description can be at most 2000 characters.')
})
test('scope: one of four or empty', () => {
  assert.deepEqual(edit({ scope: null }).updates, { scope: null })
  assert.deepEqual(edit({ scope: '' }).updates, { scope: null })
  assert.deepEqual(edit({ scope: 'qa' }).updates, { scope: 'qa' })
  assert.match(edit({ scope: 'Backend' }).error, /^scope must be one of backend, frontend, qa, design/)
})
test('implementationStatus: one of three', () => {
  assert.deepEqual(edit({ implementationStatus: 'done' }).updates, { implementationStatus: 'done' })
  assert.match(edit({ implementationStatus: 'shipped' }).error, /^implementationStatus must be one of/)
})
test('projectId: a known project writes id and name together; null detaches', () => {
  assert.deepEqual(edit({ projectId: 'P2' }).updates, { projectId: 'P2', projectName: 'Badar HMS' })
  assert.deepEqual(edit({ projectId: null }).updates, { projectId: null, projectName: null })
  assert.deepEqual(edit({ projectId: 'P1' }).updates, {})
  assert.equal(edit({ projectId: 'P9' }).error, 'No project matches that id.')
})
test('holderIds: members only, deduped, order-insensitive, at most 50', () => {
  assert.deepEqual(edit({ holderIds: ['u2', 'u1', 'u2'] }).updates, { assigneeIds: ['u2', 'u1'] })
  assert.deepEqual(edit({ holderIds: ['u1'] }).updates, {})
  assert.equal(edit({ holderIds: ['u9'] }).error, 'u9 is not a member of this Discord server.')
  assert.equal(edit({ holderIds: 'u1' }).error, 'holderIds must be a list of Discord ids.')
  const many = new Set(Array.from({ length: 51 }, (_, i) => `m${i}`))
  assert.equal(edit({ holderIds: [...many] }, task, { ...ctx, memberIds: many }).error, 'A task can have at most 50 people.')
})
test('a bug is compared against its tagged members and clearing it clears them too', () => {
  const bug = { ...task, type: 'bug', assigneeIds: [], taggedMemberIds: ['u1', 'u2'] }
  assert.deepEqual(edit({ holderIds: ['u2', 'u1'] }, bug).updates, {}, 'same people, nothing to write')
  assert.deepEqual(edit({ holderIds: ['u3'] }, bug).updates, { assigneeIds: ['u3'] })
  assert.deepEqual(edit({ holderIds: [] }, bug).updates, { assigneeIds: [], taggedMemberIds: [] },
    'otherwise holdersOf would fall back to the tagged members and they would reappear')
})
test('test counts: whole numbers 0 to 127, unchanged dropped', () => {
  assert.equal(MAX_TEST_COUNT, 127)
  assert.deepEqual(edit({ passedApiTests: 127, passedQaTests: 0 }).updates, { passedApiTests: 127 })
  for (const bad of [128, -1, 1.5, '3', null]) {
    assert.equal(edit({ passedApiTests: bad }).error, 'Test counts must be whole numbers from 0 to 127.')
  }
})
test('estimate: parsed like the hub, blank clears, unchanged dropped', () => {
  assert.deepEqual(edit({ estimate: '8h 30m' }).updates, { estimateMinutes: 510 })
  assert.deepEqual(edit({ estimate: '2h' }).updates, {})
  assert.deepEqual(edit({ estimate: '' }).updates, { estimateMinutes: null })
  assert.deepEqual(edit({ estimate: null }).updates, { estimateMinutes: null })
  assert.equal(edit({ estimate: 'soon' }).error, BAD_DURATION)
  assert.equal(edit({ estimate: '99999999999h' }).error, 'That estimate is too large to store.')
})
test('blockerIds: diffed into adds and removes', () => {
  assert.deepEqual(edit({ blockerIds: ['B'] }).blockers, { add: ['B'], remove: [] })
  const withB = { ...ctx, deps: [{ taskId: 'T', blockedByTaskId: 'B' }] }
  assert.deepEqual(edit({ blockerIds: [] }, task, withB).blockers, { add: [], remove: ['B'] })
  assert.deepEqual(edit({ blockerIds: ['B', 'C'] }, task, withB).blockers, { add: ['C'], remove: [] })
  assert.deepEqual(edit({ blockerIds: ['B'] }, task, withB).blockers, { add: [], remove: [] })
})
test('blockerIds: self, unknown and cycles are refused with nothing to apply', () => {
  assert.equal(edit({ blockerIds: ['T'] }).error, 'A task cannot be blocked by itself.')
  assert.equal(edit({ blockerIds: ['Z'] }).error, 'No task matches Z.')
  const cyc = edit({ blockerIds: ['B'] }, task, { ...ctx, deps: [{ taskId: 'B', blockedByTaskId: 'T' }] })
  assert.equal(cyc.error, 'Blocker already depends on Git Sync, so Git Sync cannot be blocked by Blocker.')
  assert.deepEqual(cyc.blockers, { add: [], remove: [] })
  assert.deepEqual(cyc.updates, {})
})
test('one bad field refuses the whole edit', () => {
  const r = edit({ title: 'Fine', passedQaTests: 500 })
  assert.equal(r.error, 'Test counts must be whole numbers from 0 to 127.')
  assert.deepEqual(r.updates, {})
})

const cctx = {
  project: { id: 'P1', name: 'Framework', guildConfigId: 'g1' },
  memberIds: new Set(['u1', 'u2']),
  reposById: new Map([['R1', { id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }], ['R2', { id: 'R2', name: 'site', url: 'https://github.com/g/site' }]]),
}
const create = (input, c = cctx) => validateCreate(input, c)

test('a valid feature comes back normalised', () => {
  const r = create({ type: 'feature', title: ' Sync ', description: '', scope: 'backend', modules: [' auth ', 'auth', ''],
    holderIds: ['u2'], repositoryIds: ['R1', 'R2'], tracks: { apiTests: true, qaTests: 'yes' } })
  assert.equal(r.error, null)
  assert.deepEqual(r.fields, { type: 'feature', title: 'Sync', description: null, scope: 'backend', modules: ['auth'],
    holderIds: ['u2'], repositoryIds: ['R1', 'R2'], tracks: { apiTests: true, qaTests: false, acceptanceCriteria: false } })
})
test('create refusals', () => {
  assert.equal(create({ type: 'task', title: 'x' }).error, 'type must be feature or bug.')
  assert.equal(create({ type: 'feature', title: '' }).error, 'A task needs a title.')
  assert.equal(create({ type: 'feature', title: 'x' }, { ...cctx, project: null }).error, 'Pick a project for the task.')
  assert.equal(create({ type: 'bug', title: 'x', repositoryIds: ['R1', 'R2'] }).error, 'A bug can name one repository.')
  assert.equal(create({ type: 'bug', title: 'x', modules: ['auth'] }).error, 'Modules are for features only.')
  assert.equal(create({ type: 'feature', title: 'x', repositoryIds: ['R9'] }).error, 'No repository matches R9.')
  assert.equal(create({ type: 'feature', title: 'x', holderIds: ['u9'] }).error, 'u9 is not a member of this Discord server.')
  assert.equal(create({ type: 'feature', title: 'x', modules: ['m'.repeat(101)] }).error, 'A module name can be at most 100 characters.')
})
test('a bug with one repository and no lists is fine', () => {
  const r = create({ type: 'bug', title: 'Crash', repositoryIds: ['R1'] })
  assert.equal(r.error, null)
  assert.deepEqual(r.fields.repositoryIds, ['R1'])
  assert.deepEqual(r.fields.holderIds, [])
  assert.deepEqual(r.fields.modules, [])
})
