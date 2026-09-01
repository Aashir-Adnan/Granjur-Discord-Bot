import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backoffMs } from './meetingPipelineJob.helpers.js'

test('backoff grows and caps at 1h', () => {
  assert.equal(backoffMs(1), 60_000)
  assert.equal(backoffMs(2), 5 * 60_000)
  assert.equal(backoffMs(3), 15 * 60_000)
  assert.equal(backoffMs(4), 60 * 60_000)
  assert.equal(backoffMs(9), 60 * 60_000)
})
