// db and setState are both fakes: never real GitHub, never the real db (root
// .env is production — .claude/rules/tests-never-touch-production.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issueTransition, syncIssueState } from './taskIssueState.js'

function fakeDb(repo = { id: 'r1', url: 'https://github.com/o/r' }) {
  const calls = []
  return {
    calls,
    repository: { findFirst: async (a) => { calls.push(a); return repo } },
  }
}

test('issueTransition: done/closed/resolved close as completed', () => {
  assert.deepEqual(issueTransition('in_progress', 'done'), { state: 'closed', reason: 'completed' })
  assert.deepEqual(issueTransition('in_progress', 'closed'), { state: 'closed', reason: 'completed' })
  assert.deepEqual(issueTransition('pending', 'resolved'), { state: 'closed', reason: 'completed' })
})

test('issueTransition: abandoned closes as not_planned', () => {
  assert.deepEqual(issueTransition('pending', 'abandoned'), { state: 'closed', reason: 'not_planned' })
})

test('issueTransition: from a finished status back to a live one reopens', () => {
  assert.deepEqual(issueTransition('done', 'in_progress'), { state: 'open' })
  assert.deepEqual(issueTransition('closed', 'open'), { state: 'open' })
  assert.deepEqual(issueTransition('resolved', 'pending'), { state: 'open' })
  assert.deepEqual(issueTransition('abandoned', 'pending'), { state: 'open' })
})

test('issueTransition: same status, or both live, is a no-op', () => {
  assert.equal(issueTransition('open', 'open'), null)
  assert.equal(issueTransition('done', 'done'), null)
  assert.equal(issueTransition('open', 'in_progress'), null)
  assert.equal(issueTransition('pending', 'in_progress'), null)
})

test('issueTransition: between two finished statuses, the new target wins', () => {
  assert.deepEqual(issueTransition('resolved', 'abandoned'), { state: 'closed', reason: 'not_planned' })
  assert.deepEqual(issueTransition('abandoned', 'done'), { state: 'closed', reason: 'completed' })
})

test('syncIssueState: closes with completed on in_progress -> done', async () => {
  const task = { id: 'T1', status: 'in_progress', externalIssueNumber: 7, repositoryId: 'r1', guildConfigId: 'g1' }
  const db = fakeDb()
  const calls = []
  const setState = async (...a) => { calls.push(a) }
  const out = await syncIssueState({ db, task, updates: { status: 'done' }, setState })
  assert.equal(out.line, null)
  assert.deepEqual(calls, [['https://github.com/o/r', 7, { state: 'closed', reason: 'completed' }]])
  assert.deepEqual(db.calls, [{ where: { id: 'r1', guildConfigId: 'g1' } }])
})

test('syncIssueState: closes with not_planned on pending -> abandoned', async () => {
  const task = { id: 'T1', status: 'pending', externalIssueNumber: 3, repositoryId: 'r1', guildConfigId: 'g1' }
  const db = fakeDb()
  const calls = []
  const setState = async (...a) => { calls.push(a) }
  const out = await syncIssueState({ db, task, updates: { status: 'abandoned' }, setState })
  assert.equal(out.line, null)
  assert.deepEqual(calls, [['https://github.com/o/r', 3, { state: 'closed', reason: 'not_planned' }]])
})

test('syncIssueState: reopens on done -> in_progress', async () => {
  const task = { id: 'T1', status: 'done', externalIssueNumber: 3, repositoryId: 'r1', guildConfigId: 'g1' }
  const db = fakeDb()
  const calls = []
  const setState = async (...a) => { calls.push(a) }
  const out = await syncIssueState({ db, task, updates: { status: 'in_progress' }, setState })
  assert.equal(out.line, null)
  assert.deepEqual(calls, [['https://github.com/o/r', 3, { state: 'open' }]])
})

test('syncIssueState: no call when the status is unchanged', async () => {
  const task = { id: 'T1', status: 'done', externalIssueNumber: 3, repositoryId: 'r1', guildConfigId: 'g1' }
  const db = fakeDb()
  let called = false
  const setState = async () => { called = true }
  const out = await syncIssueState({ db, task, updates: { status: 'done' }, setState })
  assert.equal(out.line, null)
  assert.equal(called, false)
  assert.equal(db.calls.length, 0)
})

test('syncIssueState: no call when there is no issue', async () => {
  const task = { id: 'T1', status: 'in_progress', repositoryId: 'r1', guildConfigId: 'g1' }
  const db = fakeDb()
  let called = false
  const setState = async () => { called = true }
  const out = await syncIssueState({ db, task, updates: { status: 'done' }, setState })
  assert.equal(out.line, null)
  assert.equal(called, false)
  assert.equal(db.calls.length, 0)
})

test('syncIssueState: no call when the repo row is missing', async () => {
  const task = { id: 'T1', status: 'in_progress', externalIssueNumber: 3, repositoryId: 'gone', guildConfigId: 'g1' }
  const db = fakeDb(null)
  let called = false
  const setState = async () => { called = true }
  const out = await syncIssueState({ db, task, updates: { status: 'done' }, setState })
  assert.equal(out.line, null)
  assert.equal(called, false)
})

test('syncIssueState: the issue number is parsed from the url when not stored separately', async () => {
  const task = { id: 'T1', status: 'in_progress', externalIssueUrl: 'https://github.com/o/r/issues/42', repositoryId: 'r1', guildConfigId: 'g1' }
  const db = fakeDb()
  const calls = []
  const setState = async (...a) => { calls.push(a) }
  await syncIssueState({ db, task, updates: { status: 'done' }, setState })
  assert.deepEqual(calls, [['https://github.com/o/r', 42, { state: 'closed', reason: 'completed' }]])
})

test('syncIssueState: a throwing setState produces the exact failure line, and never throws', async () => {
  const task = { id: 'T1', status: 'in_progress', externalIssueNumber: 3, repositoryId: 'r1', guildConfigId: 'g1' }
  const db = fakeDb()
  const setState = async () => { throw new Error('No GitHub access to o/r') }
  const closing = await syncIssueState({ db, task, updates: { status: 'done' }, setState })
  assert.equal(closing.line, 'GitHub issue not closed — No GitHub access to o/r')

  const task2 = { id: 'T1', status: 'done', externalIssueNumber: 3, repositoryId: 'r1', guildConfigId: 'g1' }
  const reopening = await syncIssueState({ db, task: task2, updates: { status: 'in_progress' }, setState })
  assert.equal(reopening.line, 'GitHub issue not reopened — No GitHub access to o/r')
})
