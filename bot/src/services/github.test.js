import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIssue, setIssueState, checkRepoAccess, parseTokens, tokenFor } from './github.js'

const fakeResponse = (body) => ({
  ok: true,
  text: async () => JSON.stringify(body),
})

test('createIssue passes an AbortSignal to fetch, so a hung GitHub call cannot hang createTask', async () => {
  let capturedInit = null
  const fetchImpl = async (_url, init) => {
    capturedInit = init
    return fakeResponse({ html_url: 'https://github.com/o/r/issues/1', number: 1 })
  }
  const res = await createIssue('https://github.com/o/r', 'Title', 'Body', { fetchImpl, tokens: new Map(), fallback: 'DEF' })
  assert.ok(capturedInit, 'fetch was called')
  assert.ok(capturedInit.signal instanceof AbortSignal, 'a signal was passed to fetch')
  assert.equal(res.url, 'https://github.com/o/r/issues/1')
})

test('parseTokens: owner:token pairs, owner case-insensitive, junk ignored', () => {
  const m = parseTokens(' ubs-dev-org:ghp_a , Other:ghp_b:c,, bad ,:x')
  assert.equal(m.get('ubs-dev-org'), 'ghp_a')
  assert.equal(m.get('other'), 'ghp_b:c')
  assert.equal(m.size, 2)
})

test('tokenFor: the owner token, else the fallback, else empty', () => {
  const tokens = parseTokens('ubs-dev-org:ORG')
  assert.equal(tokenFor('UBS-Dev-Org', { tokens, fallback: 'DEF' }), 'ORG')
  assert.equal(tokenFor('aashir-adnan', { tokens, fallback: 'DEF' }), 'DEF')
  assert.equal(tokenFor('x', { tokens: new Map(), fallback: '' }), '')
})

test('createIssue sends the owner token and returns url and number', async () => {
  const calls = []
  const fetchImpl = async (url, opts) => { calls.push([url, opts]); return { ok: true, status: 201, text: async () => JSON.stringify({ html_url: 'https://github.com/ubs-dev-org/R/issues/7', number: 7 }) } }
  const out = await createIssue('https://github.com/ubs-dev-org/R', 'T', 'B', { fetchImpl, tokens: parseTokens('ubs-dev-org:ORG'), fallback: 'DEF' })
  assert.deepEqual(out, { url: 'https://github.com/ubs-dev-org/R/issues/7', number: 7 })
  assert.equal(calls[0][0], 'https://api.github.com/repos/ubs-dev-org/R/issues')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer ORG')
})

test('createIssue: no token or 404/403 is no-access with the exact message; nothing is sent without a token', async () => {
  let called = false
  const never = async () => { called = true; throw new Error('should not fetch') }
  await assert.rejects(() => createIssue('https://github.com/itulahore/E', 'T', 'B', { fetchImpl: never, tokens: new Map(), fallback: '' }),
    (e) => e.code === 'no-access' && e.message === 'No GitHub access to itulahore/E')
  assert.equal(called, false)
  for (const status of [401, 403, 404]) {
    const fetchImpl = async () => ({ ok: false, status, statusText: 'x', text: async () => JSON.stringify({ message: 'Not Found' }) })
    await assert.rejects(() => createIssue('https://github.com/o/r', 'T', 'B', { fetchImpl, tokens: new Map(), fallback: 'DEF' }),
      (e) => e.code === 'no-access' && e.message === 'No GitHub access to o/r')
  }
})

test('createIssue: a bad URL, and another GitHub error, say so', async () => {
  await assert.rejects(() => createIssue('not a url', 'T', 'B', { tokens: new Map(), fallback: 'DEF' }), (e) => e.code === 'bad-url')
  const fetchImpl = async () => ({ ok: false, status: 422, statusText: 'x', text: async () => JSON.stringify({ message: 'Validation Failed' }) })
  await assert.rejects(() => createIssue('https://github.com/o/r', 'T', 'B', { fetchImpl, tokens: new Map(), fallback: 'DEF' }),
    (e) => e.code === 'github' && /Validation Failed/.test(e.message))
})

test('setIssueState closes with a reason and reopens without one', async () => {
  const bodies = []
  const fetchImpl = async (url, opts) => { bodies.push([url, opts.method, JSON.parse(opts.body)]); return { ok: true, status: 200, text: async () => '{}' } }
  const o = { fetchImpl, tokens: new Map(), fallback: 'DEF' }
  await setIssueState('https://github.com/o/r', 7, { state: 'closed', reason: 'not_planned' }, o)
  await setIssueState('https://github.com/o/r', 7, { state: 'open' }, o)
  assert.deepEqual(bodies, [
    ['https://api.github.com/repos/o/r/issues/7', 'PATCH', { state: 'closed', state_reason: 'not_planned' }],
    ['https://api.github.com/repos/o/r/issues/7', 'PATCH', { state: 'open' }],
  ])
})

test('checkRepoAccess never throws', async () => {
  const ok = async () => ({ ok: true, status: 200, text: async () => '{}' })
  const missing = async () => ({ ok: false, status: 404, statusText: 'x', text: async () => '{}' })
  const boom = async () => { throw new Error('timeout') }
  assert.deepEqual(await checkRepoAccess('https://github.com/o/r', { fetchImpl: ok, tokens: new Map(), fallback: 'DEF' }), { ok: true })
  assert.equal((await checkRepoAccess('https://github.com/o/r', { fetchImpl: missing, tokens: new Map(), fallback: 'DEF' })).code, 'no-access')
  assert.equal((await checkRepoAccess('https://github.com/o/r', { fetchImpl: boom, tokens: new Map(), fallback: 'DEF' })).code, 'error')
  assert.equal((await checkRepoAccess('nope', { tokens: new Map(), fallback: 'DEF' })).code, 'bad-url')
  assert.equal((await checkRepoAccess('https://github.com/o/r', { tokens: new Map(), fallback: '' })).code, 'no-access')
})

// M7 (final review, 2026-09-30): reading the repo is not enough to open issues.
test('checkRepoAccess: issues switched off on the repo is no-access with its own message', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ has_issues: false, permissions: { push: true } }) })
  assert.deepEqual(await checkRepoAccess('https://github.com/o/r', { fetchImpl, tokens: new Map(), fallback: 'DEF' }),
    { ok: false, code: 'no-access', message: 'Issues are disabled on o/r', issuesDisabled: true })
})

test('checkRepoAccess: a token that can read but neither push nor triage is no-access', async () => {
  const readOnly = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ has_issues: true, permissions: { pull: true, push: false, triage: false } }) })
  assert.deepEqual(await checkRepoAccess('https://github.com/o/r', { fetchImpl: readOnly, tokens: new Map(), fallback: 'DEF' }),
    { ok: false, code: 'no-access', message: 'No GitHub access to o/r' })
})

test('checkRepoAccess: triage without push, push, or no permissions block at all is ok', async () => {
  for (const body of [
    { has_issues: true, permissions: { pull: true, push: false, triage: true } },
    { has_issues: true, permissions: { pull: true, push: true } },
    { has_issues: true },
  ]) {
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
    assert.deepEqual(await checkRepoAccess('https://github.com/o/r', { fetchImpl, tokens: new Map(), fallback: 'DEF' }), { ok: true }, JSON.stringify(body))
  }
})
