import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick, nextStage, notifyFailure, STAGE_ORDER } from './meetingPipelineWorker.js'

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
  assert.match(sent[0], /stopped at \*\*analyzing\*\*/)
  assert.match(sent[0], /\/meeting-retry mtg-7/)
})

test('notifyFailure never throws when no channel resolves', async () => {
  await notifyFailure({}, { stage: 'x', meetingId: 'm' }, new Error('e'), async () => null)
})

test('stage that returns {block:true} sets status blocked', async () => {
  const db = fakeDb({ id: 'j1', stage: 'assigning', status: 'pending', attempts: 0, dataJson: {} })
  const stageRunners = { assigning: async () => ({ patch: {}, block: true, advance: true }) }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  assert.equal(db._store.stage, 'reporting')
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

// ---- final fix wave (2026-10-01): fresh rows, one tick at a time, masked notice ----

test('a job whose stage moved between claimBatch and claim is not run from the old stage', async () => {
  // The snapshot says `created`; by the time this tick claims it, another tick
  // has already moved it to `analyzing`.
  const snapshot = { id: 'j1', stage: 'created', status: 'pending', attempts: 0, dataJson: {} }
  const row = { id: 'j1', stage: 'analyzing', status: 'working', attempts: 0, dataJson: { title: 'fresh' } }
  const updates = []
  const db = {
    meetingPipelineJob: {
      claimBatch: async () => [snapshot],
      claim: async () => true,
      findById: async () => ({ ...row }),
      update: async (id, patch) => { updates.push([id, patch]); Object.assign(row, patch) },
    },
  }
  const ran = []
  const stageRunners = {
    created: async () => { ran.push('created'); return {} },
    analyzing: async () => { ran.push('analyzing'); return {} },
  }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  assert.deepEqual(ran, [], 'skipped for this tick')
  assert.equal(row.stage, 'analyzing', 'the stage is not rewound')
  // Released, not left 'working' for the stale reaper.
  assert.deepEqual(updates, [['j1', { status: 'pending' }]])
})

test('a claimed job runs from the freshly read row, not the claimBatch snapshot', async () => {
  const snapshot = { id: 'j1', stage: 'reporting', status: 'pending', attempts: 0, dataJson: { title: 'old' } }
  const row = { id: 'j1', stage: 'reporting', status: 'working', attempts: 2, dataJson: { title: 'fresh', reported: true } }
  const db = {
    meetingPipelineJob: {
      claimBatch: async () => [snapshot],
      claim: async () => true,
      findById: async () => ({ ...row }),
      update: async (id, patch) => { Object.assign(row, patch) },
    },
  }
  let seen = null
  const stageRunners = { reporting: async ({ job }) => { seen = job; return {} } }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  assert.deepEqual(seen.dataJson, { title: 'fresh', reported: true })
  assert.equal(row.stage, 'awaiting_review')
})

test('a tick that starts while the previous one is still running returns at once', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let batches = 0
  const store = { id: 'j1', stage: 'created', status: 'pending', attempts: 0, dataJson: {} }
  const db = {
    meetingPipelineJob: {
      claimBatch: async () => { batches += 1; return [store] },
      claim: async () => true,
      findById: async () => store,
      update: async (id, patch) => Object.assign(store, patch),
    },
  }
  const stageRunners = { created: async () => { await gate; return {} } }
  const first = runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  await new Promise((r) => setImmediate(r))
  let returned
  try {
    const second = runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
    returned = await Promise.race([second.then(() => true), new Promise((r) => setTimeout(() => r(false), 100))])
  } finally {
    release()
    await first
  }
  assert.equal(returned, true, 'the second tick returned while the first was still running')
  assert.equal(batches, 1, 'the second tick did not read a batch')
  assert.equal(store.stage, 'transcribing')
  // Once the first tick has finished, the next one runs normally.
  await runTick({ db, stageRunners: { transcribing: async () => ({}) }, client: {}, now: () => new Date('2026-01-01') })
  assert.equal(batches, 2)
})

test('the failure notice names the stage and the retry command, never the raw error', async () => {
  const sent = []
  const fakeChannel = { id: 'c1', send: async (m) => { sent.push(m) } }
  const err = new Error('connect ECONNREFUSED http://10.0.0.5:3000/internal/report?key=abc')
  await notifyFailure({}, { stage: 'reporting', meetingId: 'mtg-9' }, err, async () => fakeChannel)
  assert.equal(sent.length, 1)
  assert.equal(
    sent[0],
    'The meeting pipeline stopped at **reporting** after several attempts. An admin can retry it with `/meeting-retry mtg-9`.',
  )
  assert.doesNotMatch(sent[0], /ECONNREFUSED|10\.0\.0\.5/)
})

test('STAGE_ORDER puts reporting between assigning and awaiting_review', () => {
  assert.deepEqual(STAGE_ORDER, [
    'created', 'transcribing', 'analyzing', 'generating_tasks', 'assigning',
    'reporting', 'awaiting_review', 'approved', 'mirrored', 'issue_syncing', 'done',
  ])
  assert.equal(nextStage('assigning'), 'reporting')
  assert.equal(nextStage('reporting'), 'awaiting_review')
})
