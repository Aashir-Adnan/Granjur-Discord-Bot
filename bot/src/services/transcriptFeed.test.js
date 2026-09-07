import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  takeReady, groupUtterances, renderBlocks,
  STALL_MS, GROUP_WINDOW_MS, MAX_MESSAGE_CHARS,
} from './transcriptFeed.js'

const T0 = new Date('2026-09-07T10:00:00Z').getTime()
const entry = (sequence, over = {}) => ({
  sequence, speakerRef: 'u1', speakerName: 'Nauraiz',
  startedAt: new Date(T0 + sequence * 1000), durationMs: 900,
  text: `line ${sequence}`, status: 'done', enqueuedAt: T0, ...over,
})
const mapOf = (...es) => new Map(es.map((e) => [e.sequence, e]))

test('only a contiguous run is released, so order is never broken', () => {
  // 1 and 2 are done, 3 has not arrived, 4 is done but must wait behind 3.
  const pending = mapOf(entry(1), entry(2), entry(4))
  const { ready, next } = takeReady(pending, 1, T0 + 1000, STALL_MS)
  assert.deepEqual(ready.map((e) => e.sequence), [1, 2])
  assert.equal(next, 3)
})

test('out-of-order arrival still flushes in capture order', () => {
  const pending = mapOf(entry(2), entry(1))
  const { ready } = takeReady(pending, 1, T0 + 1000, STALL_MS)
  assert.deepEqual(ready.map((e) => e.sequence), [1, 2])
})

test('a stalled sequence is skipped once the timeout passes, not before', () => {
  const pending = mapOf(entry(1, { status: 'pending', text: '' }), entry(2))
  const early = takeReady(pending, 1, T0 + STALL_MS - 1, STALL_MS)
  assert.deepEqual(early.ready, [], 'nothing released while still within the window')
  assert.equal(early.next, 1, 'cursor does not move')

  const late = takeReady(pending, 1, T0 + STALL_MS, STALL_MS)
  assert.deepEqual(late.ready.map((e) => e.sequence), [2], 'the stalled turn is dropped, not rendered')
  assert.equal(late.next, 3)
})

test('failed and inaudible turns are consumed but never rendered', () => {
  const pending = mapOf(entry(1, { status: 'failed', text: '' }), entry(2, { text: '   ' }), entry(3))
  const { ready, next } = takeReady(pending, 1, T0 + 1000, STALL_MS)
  assert.deepEqual(ready.map((e) => e.sequence), [3])
  assert.equal(next, 4)
})

test('consecutive turns by one speaker merge into a single block', () => {
  const blocks = groupUtterances([entry(1), entry(2), entry(3, { speakerName: 'Adnan', speakerRef: 'u2' })], GROUP_WINDOW_MS)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0].texts, ['line 1', 'line 2'])
  assert.equal(blocks[1].speakerName, 'Adnan')
})

test('a long gap starts a new block even for the same speaker', () => {
  const far = entry(2, { startedAt: new Date(T0 + GROUP_WINDOW_MS + 5000) })
  const blocks = groupUtterances([entry(1), far], GROUP_WINDOW_MS)
  assert.equal(blocks.length, 2, 'the 60s window bounds a block')
})

test('a block renders as a bold name, a viewer-local time and quoted lines', () => {
  const [msg] = renderBlocks(groupUtterances([entry(1)], GROUP_WINDOW_MS), MAX_MESSAGE_CHARS)
  assert.match(msg, /\*\*Nauraiz\*\*/)
  assert.match(msg, /<t:\d+:t>/, 'timestamp renders in each viewer\'s own timezone')
  assert.match(msg, /^> line 1$/m)
})

test('multi-line speech stays inside the quote block', () => {
  const [msg] = renderBlocks(groupUtterances([entry(1, { text: 'first\nsecond' })], GROUP_WINDOW_MS), MAX_MESSAGE_CHARS)
  assert.match(msg, /^> first$/m)
  assert.match(msg, /^> second$/m)
})

test('output is split into messages that always fit Discord', () => {
  const many = Array.from({ length: 40 }, (_, i) => entry(i + 1, { text: 'x'.repeat(200) }))
  const msgs = renderBlocks(groupUtterances(many, GROUP_WINDOW_MS), MAX_MESSAGE_CHARS)
  assert.ok(msgs.length > 1, 'it split')
  for (const m of msgs) assert.ok(m.length <= MAX_MESSAGE_CHARS, `message too long: ${m.length}`)
})

test('a single turn longer than the cap is split with the header repeated', () => {
  const msgs = renderBlocks(groupUtterances([entry(1, { text: 'y'.repeat(5000) })], GROUP_WINDOW_MS), MAX_MESSAGE_CHARS)
  assert.ok(msgs.length > 1)
  for (const m of msgs) {
    assert.ok(m.length <= MAX_MESSAGE_CHARS)
    assert.match(m, /\*\*Nauraiz\*\*/, 'every part says who is speaking')
  }
})

// Ruling override: the brief's sample renderBlocks splitting loop is not trusted
// (the push(part) inside the while loop plus the trailing push(part) after it can
// duplicate content). This test proves the implementation used here neither
// duplicates nor drops any character of the original speech when a block is
// split across many messages: stripping the repeated header from each message
// and concatenating what remains, in order, must reproduce the original quoted
// text exactly once — a duplicating (or char-dropping) split would fail this.
test('a long split block reassembles to the original text exactly once, with no duplication or loss', () => {
  const original = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ')
  const msgs = renderBlocks(groupUtterances([entry(1, { text: original })], GROUP_WINDOW_MS), MAX_MESSAGE_CHARS)
  assert.ok(msgs.length > 1, 'the block must actually split for this test to mean anything')

  const headPattern = /^\*\*Nauraiz\*\* · <t:\d+:t>\n/
  let reconstructed = ''
  for (const m of msgs) {
    assert.match(m, headPattern, 'every part of a split block must repeat the header')
    reconstructed += m.replace(headPattern, '')
  }
  // The whole quoted body starts with a single "> " marker (this speech has no
  // embedded newlines, so quote() produced exactly one quoted line); stripping
  // it once recovers the original text.
  assert.equal(reconstructed.replace(/^> /, ''), original)
})
