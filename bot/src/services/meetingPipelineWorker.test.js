import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick, nextStage, notifyFailure } from './meetingPipelineWorker.js'

function fakeDb(job, { claim } = {}) {
  const store = { ...job }
  return {
    meetingPipelineJob: {
      claimBatch: async () => [store],
      claim: claim || (async () => true),
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

test('runTick skips a job whose claim fails (another worker took it)', async () => {
  const db = fakeDb(
    { id: 'j1', stage: 'created', status: 'pending', attempts: 0, dataJson: {} },
    { claim: async () => false },
  )
  let ran = false
  const stageRunners = { created: async () => { ran = true; return { patch: {} } } }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  assert.equal(ran, false)
  assert.equal(db._store.stage, 'created')
})

test('runTick runs the stage when the claim succeeds', async () => {
  let claimedId = null
  const db = fakeDb(
    { id: 'j1', stage: 'created', status: 'pending', attempts: 0, dataJson: {} },
    { claim: async (id) => { claimedId = id; return true } },
  )
  const stageRunners = { created: async () => ({ patch: { csaasMeetingId: 'm9' } }) }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  assert.equal(claimedId, 'j1')
  assert.equal(db._store.stage, 'transcribing')
})

test('throwing stage increments attempts and backs off; fails after MAX', async () => {
  const db = fakeDb({ id: 'j1', stage: 'analyzing', status: 'pending', attempts: 5, dataJson: {} })
  const stageRunners = { analyzing: async () => { throw new Error('nope') } }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01'), notify: async () => {} })
  assert.equal(db._store.status, 'failed')
  assert.match(db._store.lastError, /nope/)
})

test('job that fails after MAX attempts sends one channel alert', async () => {
  const db = fakeDb({ id: 'j1', meetingId: 'mtg-7', stage: 'analyzing', status: 'pending', attempts: 5, dataJson: {} })
  const stageRunners = { analyzing: async () => { throw new Error('boom') } }
  const notifyCalls = []
  const client = { tag: 'c' }
  await runTick({
    db, stageRunners, client, now: () => new Date('2026-01-01'),
    notify: async (...args) => { notifyCalls.push(args) },
  })
  assert.equal(db._store.status, 'failed')
  assert.equal(notifyCalls.length, 1)
  assert.equal(notifyCalls[0][0], client)
  assert.equal(notifyCalls[0][1].id, 'j1')
  assert.match(notifyCalls[0][2].message, /boom/)

  // Message formatting: exercise notifyFailure directly with an injected resolver.
  const sent = []
  const fakeChannel = { id: 'c1', send: async (m) => { sent.push(m) } }
  await notifyFailure({}, db._store, new Error('boom'), async () => fakeChannel)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /failed at \*\*analyzing\*\*/)
  assert.match(sent[0], /\/meeting-retry mtg-7/)
})

test('notifyFailure never throws when no channel resolves', async () => {
  await notifyFailure({}, { stage: 'x', meetingId: 'm' }, new Error('e'), async () => null)
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
