import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backoffMs, meetingPipelineEnabled } from './meetingPipelineJob.helpers.js'

test('backoff grows and caps at 1h', () => {
  assert.equal(backoffMs(1), 60_000)
  assert.equal(backoffMs(2), 5 * 60_000)
  assert.equal(backoffMs(3), 15 * 60_000)
  assert.equal(backoffMs(4), 60 * 60_000)
  assert.equal(backoffMs(9), 60 * 60_000)
})

test('meetingPipelineEnabled: only 1/true/yes/on enable it', () => {
  const prev = process.env.MEETING_PIPELINE_ENABLED
  try {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
      process.env.MEETING_PIPELINE_ENABLED = v
      assert.equal(meetingPipelineEnabled(), true, v)
    }
    for (const v of ['0', 'false', 'no', 'off', '', 'disabled']) {
      process.env.MEETING_PIPELINE_ENABLED = v
      assert.equal(meetingPipelineEnabled(), false, v)
    }
    delete process.env.MEETING_PIPELINE_ENABLED
    assert.equal(meetingPipelineEnabled(), false)
  } finally {
    if (prev === undefined) delete process.env.MEETING_PIPELINE_ENABLED
    else process.env.MEETING_PIPELINE_ENABLED = prev
  }
})
