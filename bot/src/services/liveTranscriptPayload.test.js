import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnalyzeLivePayload, SEGMENT_MS } from './liveTranscriptPayload.js'

const T0 = new Date('2026-09-07T10:00:00Z').getTime()
const u = (sequence, offsetMs, speakerName, text) => ({
  sequence, speakerName, text, durationMs: 1000,
  startedAt: new Date(T0 + offsetMs),
})

test('turns become Name: text lines in sequence order within a segment', () => {
  const { meetingNotes } = buildAnalyzeLivePayload([
    u(1, 0, 'Nauraiz', 'start with booking'),
    u(2, 4000, 'Adnan', 'the created date is wrong'),
  ])
  assert.deepEqual(Object.keys(meetingNotes), ['segment_0'])
  assert.equal(meetingNotes.segment_0.transcription, 'Nauraiz: start with booking\nAdnan: the created date is wrong')
  assert.equal(meetingNotes.segment_0.time_range, '00:00-05:00')
})

test('turns are bucketed into five-minute segments by their offset', () => {
  const { meetingNotes } = buildAnalyzeLivePayload([
    u(1, 0, 'A', 'one'),
    u(2, SEGMENT_MS + 1000, 'B', 'two'),
    u(3, 2 * SEGMENT_MS + 1000, 'C', 'three'),
  ])
  assert.deepEqual(Object.keys(meetingNotes), ['segment_0', 'segment_1', 'segment_2'])
  assert.equal(meetingNotes.segment_1.time_range, '05:00-10:00')
  assert.equal(meetingNotes.segment_2.transcription, 'C: three')
})

test('an empty segment in the middle is not emitted', () => {
  const { meetingNotes } = buildAnalyzeLivePayload([
    u(1, 0, 'A', 'one'),
    u(2, 2 * SEGMENT_MS + 1000, 'C', 'three'),
  ])
  assert.deepEqual(Object.keys(meetingNotes), ['segment_0', 'segment_2'])
})

test('empty and whitespace-only turns are dropped', () => {
  const { meetingNotes } = buildAnalyzeLivePayload([
    u(1, 0, 'A', '  '), u(2, 1000, 'B', 'real'), u(3, 2000, 'C', ''),
  ])
  assert.equal(meetingNotes.segment_0.transcription, 'B: real')
})

test('total duration spans first turn to the end of the last', () => {
  const { totalDurationSec } = buildAnalyzeLivePayload([u(1, 0, 'A', 'one'), u(2, 9000, 'B', 'two')])
  assert.equal(totalDurationSec, 10, '9s offset + the last turn\'s 1s')
})

test('no usable turns yields an empty payload rather than throwing', () => {
  const out = buildAnalyzeLivePayload([])
  assert.deepEqual(out.meetingNotes, {})
  assert.equal(out.totalDurationSec, 0)
})
