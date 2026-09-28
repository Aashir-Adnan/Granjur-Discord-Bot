import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIssue } from './github.js'

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
  const res = await createIssue('https://github.com/o/r', 'Title', 'Body', { fetchImpl })
  assert.ok(capturedInit, 'fetch was called')
  assert.ok(capturedInit.signal instanceof AbortSignal, 'a signal was passed to fetch')
  assert.equal(res.url, 'https://github.com/o/r/issues/1')
})
