import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectChoices, NO_PROJECT, nextAssignees, applyDependencyChange } from './update-task.js'

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

test('nextAssignees: replace wins, then add and remove apply, no duplicates', () => {
  assert.deepEqual(nextAssignees(['1', '2'], { add: '3' }), ['1', '2', '3'])
  assert.deepEqual(nextAssignees(['1', '2'], { remove: '1' }), ['2'])
  assert.deepEqual(nextAssignees(['1', '2'], { add: '2' }), ['1', '2'])
  assert.deepEqual(nextAssignees(['1', '2'], { remove: '9' }), ['1', '2'])
  assert.deepEqual(nextAssignees(['1'], { replace: ['5', '6'], add: '7', remove: '5' }), ['6', '7'])
  assert.equal(nextAssignees(['1'], {}), null) // nothing asked → no update
})

function fakeDb({ tasks = [], deps = [] } = {}) {
  const calls = []
  return {
    calls,
    task: { findByIds: async ({ where }) => tasks.filter((t) => where.ids.includes(t.id)) },
    taskDependency: {
      findManyForGuild: async () => deps,
      findByTask: async ({ where }) => deps.filter((d) => d.taskId === where.taskId),
      add: async ({ data }) => { calls.push(['add', data]); return data },
      remove: async ({ where }) => { calls.push(['remove', where]); return { removed: 1 } },
    },
  }
}

test('applyDependencyChange refuses self-block and cycles, never writing', async () => {
  const cfg = { id: 'g1' }
  const task = { id: 'A', title: 'Git Sync', status: 'open' }
  const db = fakeDb({ tasks: [task, { id: 'B', title: 'Router fix', status: 'open' }], deps: [{ taskId: 'B', blockedByTaskId: 'A' }] })
  const self = await applyDependencyChange({ db, cfg, task, blockedById: 'A' })
  assert.match(self.error, /itself/)
  const cyc = await applyDependencyChange({ db, cfg, task, blockedById: 'B' })
  assert.equal(cyc.error, '**Router fix** already depends on **Git Sync**, so **Git Sync** cannot be blocked by **Router fix**.')
  assert.equal(db.calls.length, 0)
})

test('applyDependencyChange refuses an unknown blocker', async () => {
  const db = fakeDb({ tasks: [{ id: 'A', title: 'Git Sync', status: 'open' }] })
  const out = await applyDependencyChange({ db, cfg: { id: 'g1' }, task: { id: 'A', title: 'Git Sync' }, blockedById: 'nope' })
  assert.match(out.error, /No task matches/)
})

test('applyDependencyChange writes a blocker and an unblock, reporting both', async () => {
  const task = { id: 'A', title: 'Git Sync', status: 'open' }
  const db = fakeDb({ tasks: [task, { id: 'B', title: 'Router fix', status: 'open' }, { id: 'C', title: 'Old', status: 'open' }], deps: [{ taskId: 'A', blockedByTaskId: 'C' }] })
  const out = await applyDependencyChange({ db, cfg: { id: 'g1' }, task, blockedById: 'B', unblockId: 'C', actorId: 'u1' })
  assert.equal(out.error, null)
  assert.deepEqual(db.calls[0], ['add', { guildConfigId: 'g1', taskId: 'A', blockedByTaskId: 'B', createdBy: 'u1' }])
  assert.deepEqual(db.calls[1], ['remove', { taskId: 'A', blockedByTaskId: 'C' }])
  assert.deepEqual(out.lines, ['**Blocked by:** Router fix', '**Unblocked:** Old'])
})

test('projectChoices can omit the detach entry', () => {
  const out = projectChoices(projects, '', { withDetach: false })
  assert.ok(out.every((c) => c.value !== NO_PROJECT))
  assert.equal(out.length, 3)
})
