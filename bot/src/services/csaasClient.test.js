import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.CSAAS_API_URL = 'http://csaas.test/api'
process.env.CSAAS_ACTOR_URDD = '999'

let calls
// Wrap any payload.return body in the CSAAS envelope the real API sends.
function envelope(ret) {
  const json = { status: 200, payload: { return: ret } }
  return {
    ok: true,
    status: 200,
    async json() { return json },
    async text() { return JSON.stringify(json) },
  }
}
function stubFetch(ret) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return envelope(typeof ret === 'function' ? ret(url, opts) : ret)
  }
}

beforeEach(() => {
  calls = []
  stubFetch((url, opts) => ({ meeting_id: 'm1', echoedBody: JSON.parse(opts.body) }))
})

const { createMeeting, fetchNotes, issueSync, explain, CsaasError, isConfigured } =
  await import('./csaasClient.js')

test('isConfigured reflects env', () => {
  assert.equal(isConfigured(), true)
})

test('createMeeting unwraps payload.return and injects actionPerformerURDD', async () => {
  const out = await createMeeting({ title: 'T', participants: ['Ali'] })
  assert.equal(out.meeting_id, 'm1')
  assert.equal(calls[0].url, 'http://csaas.test/api/meeting/workflow/create')
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(body.actionPerformerURDD, '999')
  assert.equal(body.title, 'T')
})

// ── Contract tests: fake fetch returns the REAL CSAAS envelope shape ──────────

test('createMeeting normalizes the real { meeting: { meeting_id } } shape', async () => {
  // CSAAS meetingWorkflow.js createMeeting -> return { meeting: <meetings row>, scope_repo_ids }
  stubFetch({ meeting: { meeting_id: 42, title: 'T', status: 'pending' }, scope_repo_ids: [3] })
  const out = await createMeeting({ title: 'T' })
  assert.deepEqual(out, { meeting_id: 42 })
})

test('fetchNotes normalizes the real { notes: <row>, latestHtml } shape', async () => {
  // CSAAS fetchNotes -> return { notes: <meeting_notes row>, latestHtml: <string|null> }
  stubFetch({
    notes: { notes_id: 1, meeting_id: 5, raw_notes: 'RAW', edited_notes: 'EDITED', version: 3 },
    latestHtml: '<h1>report</h1>',
  })
  const out = await fetchNotes(5)
  assert.deepEqual(out, { notes: 'EDITED', html: '<h1>report</h1>' })
})

test('fetchNotes falls back to raw_notes and tolerates null row', async () => {
  stubFetch({ notes: { raw_notes: 'RAW', edited_notes: null }, latestHtml: null })
  assert.deepEqual(await fetchNotes(5), { notes: 'RAW', html: null })
  stubFetch({ notes: null, latestHtml: null })
  assert.deepEqual(await fetchNotes(5), { notes: '', html: null })
})

test('issueSync normalizes the real { results, dry_run } shape', async () => {
  // CSAAS issueSync -> return { results: [ {task_id, goal, issue_number, issue_url} | {skipped} | {error} ], dry_run }
  stubFetch({
    results: [
      { task_id: 7, goal: 'g', issue_number: 12, issue_url: 'https://github.com/o/r/issues/12' },
      { task_id: 8, goal: 'g2', skipped: true, duplicate_of: 3 },
      { task_id: 9, goal: 'g3', error: 'boom' },
    ],
    dry_run: false,
  })
  const out = await issueSync('m', { owner: 'o', repo: 'r', taskIds: [7, 8, 9] })
  assert.deepEqual(out.issues, [
    { task_id: 7, url: 'https://github.com/o/r/issues/12', number: 12, skipped: false, error: null },
    { task_id: 8, url: null, number: null, skipped: true, error: null },
    { task_id: 9, url: null, number: null, skipped: false, error: 'boom' },
  ])
})

test('non-200 envelope throws CsaasError', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    async json() { return { status: 500, message: 'boom' } },
    async text() { return JSON.stringify({ status: 500, message: 'boom' }) },
  })
  await assert.rejects(() => createMeeting({ title: 'x' }), (e) => e instanceof CsaasError && /boom/.test(e.message))
})

test('an aborted/timed-out fetch becomes a CsaasError', async () => {
  globalThis.fetch = async () => {
    const err = new Error('The operation was aborted')
    err.name = 'TimeoutError'
    throw err
  }
  await assert.rejects(
    () => createMeeting({ title: 'x' }),
    (e) => e instanceof CsaasError && /timed out/i.test(e.message),
  )
})

test('explain posts question + project and unwraps the answer', async () => {
  let captured
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts }
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        status: 200,
        payload: { return: { answer: 'A', references: [{ path: 'init.md', heading: '', quote: '' }], scope: 'All documentation', model: 'm', durationMs: 12 } },
      }),
    }
  }
  const out = await explain({ question: 'q?', project: null })
  assert.equal(out.answer, 'A')
  assert.equal(out.scope, 'All documentation')
  assert.match(captured.url, /\/meeting\/workflow\/explain$/)
  const body = JSON.parse(captured.opts.body)
  assert.equal(body.question, 'q?')
  assert.equal(body.project, null)
  assert.equal(String(body.actionPerformerURDD), process.env.CSAAS_ACTOR_URDD)
  // a per-call timeout is passed as the abort signal
  assert.ok(captured.opts.signal instanceof AbortSignal)
})

test('explain normalises a missing references array', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ status: 200, payload: { return: { answer: 'A', scope: 'x' } } }),
  })
  const out = await explain({ question: 'q?', project: null })
  assert.deepEqual(out.references, [])
})
