import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityChanges, recordTaskActivity } from './taskActivity.js'
import { taskActivityInsertSql } from '../Database/index.js'

const before = {
  id: 't1', guildConfigId: 'g1', title: 'Old', description: 'd', status: 'open', scope: null,
  assigneeIds: ['1'], projectId: 'p1', projectName: 'Framework', passedQaTests: 2,
}

test('activityChanges lists only fields that really differ', () => {
  assert.deepEqual(activityChanges(before, { status: 'open', scope: null }), [])
  assert.deepEqual(activityChanges(before, { status: 'done', scope: 'qa' }), [
    { field: 'status', from: 'open', to: 'done' },
    { field: 'scope', from: null, to: 'qa' },
  ])
})

test('a title or description change is recorded without its text', () => {
  const out = activityChanges(before, { title: 'New', description: 'secret body' })
  assert.deepEqual(out, [{ field: 'title' }, { field: 'description' }])
  assert.doesNotMatch(JSON.stringify(out), /secret|New/)
})

test('assignees record who was added and who was removed', () => {
  assert.deepEqual(activityChanges(before, { assigneeIds: ['2', '3'] }), [
    { field: 'assignees', added: ['2', '3'], removed: ['1'] },
  ])
  assert.deepEqual(activityChanges(before, { assigneeIds: ['1'] }), [])
})

test('a project move records the project names; no move records nothing', () => {
  assert.deepEqual(activityChanges(before, { projectId: 'p2', projectName: 'CSAAS' }), [
    { field: 'project', from: 'Framework', to: 'CSAAS' },
  ])
  assert.deepEqual(activityChanges(before, { projectId: 'p1', projectName: 'Framework' }), [])
})

test('test counts compare by value, so 2 -> "2" is not a change', () => {
  assert.deepEqual(activityChanges(before, { passedQaTests: '2' }), [])
  assert.deepEqual(activityChanges(before, { passedQaTests: 5 }), [{ field: 'passedQaTests', from: 2, to: 5 }])
})

function fakeDb({ fail = false } = {}) {
  const rows = []
  return {
    rows,
    taskActivity: { add: async (a) => { if (fail) throw new Error('db down'); rows.push(a.data) } },
  }
}

test('recordTaskActivity writes one row with the actor, and skips an empty change list', async () => {
  const db = fakeDb()
  assert.equal(await recordTaskActivity({ db, task: before, changes: [], actor: { discordId: 'u1' } }), false)
  assert.equal(db.rows.length, 0)
  const ok = await recordTaskActivity({ db, task: before, changes: [{ field: 'status', from: 'open', to: 'done' }], actor: { discordId: 'u1', label: 'Ana' } })
  assert.equal(ok, true)
  assert.deepEqual(db.rows[0], {
    guildConfigId: 'g1', taskId: 't1', actorDiscordId: 'u1', actorLabel: 'Ana',
    changes: [{ field: 'status', from: 'open', to: 'done' }],
  })
})

test('recordTaskActivity never throws when the write fails', async () => {
  const orig = console.error
  console.error = () => {}
  try {
    assert.equal(await recordTaskActivity({ db: fakeDb({ fail: true }), task: before, changes: [{ field: 'title' }] }), false)
  } finally { console.error = orig }
})

test('taskactivity insert: placeholders equal params and follow the column order', () => {
  const { sql, params } = taskActivityInsertSql({
    id: 'a1', guildConfigId: 'g1', taskId: 't1', actorDiscordId: 'u1', actorLabel: 'Ana', changes: [{ field: 'title' }],
  })
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.deepEqual(cols, ['id', 'guildConfigId', 'taskId', 'actorDiscordId', 'actorLabel', 'changes'])
  assert.deepEqual(params, ['a1', 'g1', 't1', 'u1', 'Ana', '[{"field":"title"}]'])
  assert.equal((sql.match(/\?/g) || []).length, params.length)
  assert.match(sql, /INSERT INTO `taskactivity`/)
})

test('taskactivity insert: an unknown actor is null, and changes default to an empty list', () => {
  const { params } = taskActivityInsertSql({ id: 'a2', guildConfigId: 'g1', taskId: 't1' })
  assert.deepEqual(params, ['a2', 'g1', 't1', null, null, '[]'])
})
