import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick, nextStage } from './meetingPipelineWorker.js'

function fakeDb(job) {
  const store = { ...job }
  return {
    meetingPipelineJob: {
      claimBatch: async () => [store],
      update: async (id, patch) => Object.assign(store, patch),
      findById: async () => store,
    },
    _store: store,
  }
}

test('nextStage walks the ladder and stops at done', () => {
  assert.equal(nextStage('created'), 'transcribing')
  assert.equal(nextStage('issue_syncing'), 'done')
  assert.equal(nextStage('done'), 'done')
})

test('successful stage advances stage and clears error', async () => {
  const db = fakeDb({ id: 'j1', stage: 'created', status: 'pending', attempts: 0, dataJson: {} })
  const stageRunners = { created: async () => ({ patch: { csaasMeetingId: 'm9' } }) }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  assert.equal(db._store.stage, 'transcribing')
  assert.equal(db._store.status, 'pending')
  assert.equal(db._store.csaasMeetingId, 'm9')
  assert.equal(db._store.lastError, null)
})

test('throwing stage increments attempts and backs off; fails after MAX', async () => {
  const db = fakeDb({ id: 'j1', stage: 'analyzing', status: 'pending', attempts: 5, dataJson: {} })
  const stageRunners = { analyzing: async () => { throw new Error('nope') } }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  assert.equal(db._store.status, 'failed')
  assert.match(db._store.lastError, /nope/)
})

test('stage that returns {block:true} sets status blocked', async () => {
  const db = fakeDb({ id: 'j1', stage: 'assigning', status: 'pending', attempts: 0, dataJson: {} })
  const stageRunners = { assigning: async () => ({ patch: {}, block: true, advance: true }) }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  assert.equal(db._store.stage, 'awaiting_review')
  assert.equal(db._store.status, 'blocked')
})

test('a hung stage runner times out and flows into the retry path', async () => {
  const prev = process.env.MEETING_STAGE_TIMEOUT_MS
  process.env.MEETING_STAGE_TIMEOUT_MS = '20'
  try {
    const db = fakeDb({ id: 'j1', stage: 'transcribing', status: 'pending', attempts: 0, dataJson: {} })
    const stageRunners = { transcribing: () => new Promise(() => {}) }
    await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
    assert.equal(db._store.attempts, 1)
    assert.equal(db._store.status, 'pending')
    assert.ok(db._store.nextAttemptAt instanceof Date)
    assert.match(db._store.lastError, /timed out/)
  } finally {
    if (prev === undefined) delete process.env.MEETING_STAGE_TIMEOUT_MS
    else process.env.MEETING_STAGE_TIMEOUT_MS = prev
  }
})
