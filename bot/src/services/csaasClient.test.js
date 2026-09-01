import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.CSAAS_API_URL = 'http://csaas.test/api'
process.env.CSAAS_ACTOR_URDD = '999'

let calls
beforeEach(() => {
  calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return {
      ok: true,
      status: 200,
      async json() {
        return { status: 200, payload: { return: { meeting_id: 'm1', echoedBody: JSON.parse(opts.body) } } }
      },
      async text() { return JSON.stringify({ status: 200, payload: { return: { meeting_id: 'm1', echoedBody: JSON.parse(opts.body) } } }) },
    }
  }
})

const { createMeeting, CsaasError, isConfigured } = await import('./csaasClient.js')

test('isConfigured reflects env', () => {
  assert.equal(isConfigured(), true)
})

test('createMeeting unwraps payload.return and injects actionPerformerURDD', async () => {
  const out = await createMeeting({ title: 'T', participants: ['Ali'] })
  assert.equal(out.meeting_id, 'm1')
  assert.equal(calls[0].url, 'http://csaas.test/api/meeting/workflow/create')
  assert.equal(out.echoedBody.actionPerformerURDD, '999')
  assert.equal(out.echoedBody.title, 'T')
})

test('non-200 envelope throws CsaasError', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    async json() { return { status: 500, message: 'boom' } },
    async text() { return JSON.stringify({ status: 500, message: 'boom' }) },
  })
  await assert.rejects(() => createMeeting({ title: 'x' }), (e) => e instanceof CsaasError && /boom/.test(e.message))
})
