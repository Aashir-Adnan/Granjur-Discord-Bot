import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  takeReady, groupUtterances, renderBlocks,
  STALL_MS, OPEN_STALL_MS, GROUP_WINDOW_MS, MAX_MESSAGE_CHARS,
} from './transcriptFeed.js'

const T0 = new Date('2026-09-07T10:00:00Z').getTime()
// startedAtMs matters: the open-stall branch reads it, and leaving it undefined
// would make `now - undefined >= openStallMs` evaluate NaN >= n as false, so a
// test of that branch would pass without ever exercising it.
const entry = (sequence, over = {}) => ({
  sequence, speakerRef: 'u1', speakerName: 'Nauraiz',
  startedAt: new Date(T0 + sequence * 1000), durationMs: 900,
  text: `line ${sequence}`, status: 'done', startedAtMs: T0, enqueuedAt: T0, ...over,
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

test('a turn still open holds the cursor until OPEN_STALL_MS, then is consumed', () => {
  // The one thing standing between a sequence claimed but never settled and a
  // feed frozen for the rest of the meeting.
  const pending = mapOf(entry(1, { status: 'open', text: '' }), entry(2))

  const early = takeReady(pending, 1, T0 + OPEN_STALL_MS - 1, STALL_MS, OPEN_STALL_MS)
  assert.deepEqual(early.ready, [], 'a turn still being spoken holds everything behind it')
  assert.equal(early.next, 1, 'the cursor does not move past it')

  const late = takeReady(pending, 1, T0 + OPEN_STALL_MS, STALL_MS, OPEN_STALL_MS)
  assert.deepEqual(late.ready.map((e) => e.sequence), [2], 'the abandoned turn is dropped, not rendered')
  assert.equal(late.next, 3, 'the cursor advances past it so later turns can render')
})

test('an open turn is held on its own clock, not the submitted-turn stall window', () => {
  // STALL_MS (25 s) is shorter than a maximum segment (30 s), so measuring an
  // open turn against it would drop every long turn.
  const pending = mapOf(entry(1, { status: 'open', text: '' }))
  const { ready, next } = takeReady(pending, 1, T0 + STALL_MS + 1, STALL_MS, OPEN_STALL_MS)
  assert.deepEqual(ready, [])
  assert.equal(next, 1, 'still held well past the window that applies to a submitted turn')
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

import { createTranscriptFeed } from './transcriptFeed.js'

const fakeChannel = () => {
  const sent = []
  return { sent, isTextBased: () => true, send: async (m) => { sent.push(typeof m === 'string' ? m : m.content); return {} } }
}
const fakeDb = () => {
  const rows = []
  return { rows, meetingUtterance: { create: async ({ data }) => { rows.push(data); return data } } }
}
const echoStt = { transcribeUtterance: async (_m, o) => ({ text: `text-${o.sequence}`, sequence: o.sequence }) }

// What the capture loop does for a turn that runs to completion: claim the
// number when the turn starts, hand over the audio when it ends.
const turn = (feed, { speakerRef = 'u1', speakerName = 'A', startedAt, at, durationMs = 900, buffer = Buffer.from('a') }) => {
  const seq = feed.begin({ speakerRef, startedAt }, at)
  if (seq == null) return null
  feed.submit(seq, { speakerName, durationMs, buffer })
  return seq
}

test('a transcribed turn reaches the channel and the database', async () => {
  const channel = fakeChannel()
  const db = fakeDb()
  const csaasClient = { transcribeUtterance: async (_m, o) => ({ text: 'hello there', sequence: o.sequence }) }
  const feed = createTranscriptFeed({ db, csaasClient, channel, guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c' })

  turn(feed, { speakerName: 'Nauraiz', startedAt: new Date(T0), at: T0 })
  await feed.drain()
  const sentCount = await feed.flushOnce(T0 + 1000)

  assert.equal(sentCount, 1)
  assert.match(channel.sent[0], /\*\*Nauraiz\*\*/)
  assert.match(channel.sent[0], /> hello there/)
  assert.equal(db.rows.length, 1, 'the utterance is persisted')
  assert.equal(db.rows[0].meetingId, 'm')
  assert.equal(db.rows[0].sequence, 1)
})

test('sequences are contiguous, so the cursor never stalls on a gap', async () => {
  const feed = createTranscriptFeed({
    db: fakeDb(), channel: fakeChannel(), guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c',
    csaasClient: echoStt,
  })
  const a = turn(feed, { startedAt: new Date(T0), at: T0 })
  const b = turn(feed, { startedAt: new Date(T0 + 1000), at: T0 + 1000 })
  assert.equal(a, 1)
  assert.equal(b, 2)
  await feed.drain()
})

test('overlapping turns render in the order they were said, not the order they came back', async () => {
  const channel = fakeChannel()
  const feed = createTranscriptFeed({
    db: fakeDb(), channel, guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c',
    csaasClient: echoStt,
  })

  // Adnan talks for 20 s; Bilal interjects 5 s in for 2 s and so finishes first.
  const adnan = feed.begin({ speakerRef: 'u1', startedAt: new Date(T0) }, T0)
  const bilal = feed.begin({ speakerRef: 'u2', startedAt: new Date(T0 + 5000) }, T0 + 5000)
  assert.equal(adnan, 1)
  assert.equal(bilal, 2, 'the number is claimed when the turn starts')

  feed.submit(bilal, { speakerName: 'Bilal', durationMs: 2000, buffer: Buffer.from('b') })
  await feed.drain()
  assert.equal(await feed.flushOnce(T0 + 8000), 0, 'Bilal waits: Adnan is still speaking and holds the cursor')
  assert.deepEqual(channel.sent, [])

  feed.submit(adnan, { speakerName: 'Adnan', durationMs: 20000, buffer: Buffer.from('a') })
  await feed.drain()
  await feed.flushOnce(T0 + 21000)

  const body = channel.sent.join('\n')
  assert.match(body, /Adnan/)
  assert.match(body, /Bilal/)
  assert.ok(body.indexOf('Adnan') < body.indexOf('Bilal'), 'the earlier turn prints first')
})

test('a turn rejected by the minimum-duration gate is abandoned, so the cursor keeps moving', async () => {
  const channel = fakeChannel()
  const feed = createTranscriptFeed({
    db: fakeDb(), channel, guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c',
    csaasClient: echoStt,
  })
  const tooShort = feed.begin({ speakerRef: 'u1', startedAt: new Date(T0) }, T0)
  feed.abandon(tooShort)
  const real = turn(feed, { startedAt: new Date(T0 + 1000), at: T0 + 1000 })
  assert.equal(real, 2)
  await feed.drain()

  assert.equal(await feed.flushOnce(T0 + 2000), 1, 'the abandoned number settled instead of stalling the cursor')
  assert.match(channel.sent[0], /text-2/)
})

test('repeated speech-to-text failures degrade the feed once, and recording continues', async () => {
  const channel = fakeChannel()
  const csaasClient = { transcribeUtterance: async () => { throw new Error('stt down') } }
  const feed = createTranscriptFeed({ db: fakeDb(), csaasClient, channel, guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c' })

  for (let i = 0; i < 5; i++) {
    turn(feed, { startedAt: new Date(T0 + i * 1000), at: T0 + i * 1000 })
  }
  await feed.drain()
  await feed.flushOnce(T0 + STALL_MS + 1000)

  const warnings = channel.sent.filter((m) => /transcription/i.test(m) && /unavailable/i.test(m))
  assert.equal(warnings.length, 1, 'warned exactly once, not once per failure')
  assert.equal(feed.stats().degraded, true)
  assert.equal(feed.begin({ speakerRef: 'u1', startedAt: new Date() }), null)
})

test('a turn already in progress when the feed degrades is settled, not left open', async () => {
  const channel = fakeChannel()
  let calls = 0
  const csaasClient = { transcribeUtterance: async () => { calls += 1; throw new Error('stt down') } }
  const feed = createTranscriptFeed({ db: fakeDb(), csaasClient, channel, guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c' })

  // Claimed first, so it sits at the cursor and holds every later turn behind it.
  const inFlight = feed.begin({ speakerRef: 'u1', startedAt: new Date(T0) }, T0)
  for (let i = 1; i <= 3; i++) turn(feed, { startedAt: new Date(T0 + i * 1000), at: T0 + i * 1000 })
  await feed.drain()
  assert.equal(feed.stats().degraded, true)
  assert.equal(feed.stats().cursor, 1, 'nothing has been consumed: the open turn is at the cursor')

  assert.equal(feed.submit(inFlight, { speakerName: 'A', durationMs: 900, buffer: Buffer.from('a') }), null)
  assert.equal(calls, 3, 'no transcription attempted for the turn that arrived after degrading')

  // Well inside OPEN_STALL_MS, so the cursor can only move past sequence 1 if
  // submit actually settled it. Left open, it would still be holding here.
  await feed.flushOnce(T0 + STALL_MS + 1000)
  assert.equal(feed.stats().cursor, 5, 'the refused turn was settled, not left holding the queue')
})

test('a deleted channel disables the feed instead of throwing every flush', async () => {
  const channel = { isTextBased: () => true, send: async () => { throw new Error('Unknown Channel') } }
  const feed = createTranscriptFeed({
    db: fakeDb(), channel, guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c',
    csaasClient: echoStt,
  })
  turn(feed, { startedAt: new Date(T0), at: T0 })
  await feed.drain()
  await feed.flushOnce(T0 + 1000)
  assert.equal(feed.stats().disabled, true)
  await feed.flushOnce(T0 + 2000) // must not throw
})

test('start posts the consent notice before any transcript', async () => {
  const channel = fakeChannel()
  const feed = createTranscriptFeed({
    db: fakeDb(), channel, guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c',
    csaasClient: echoStt,
  })
  await feed.start({ interval: false })
  assert.match(channel.sent[0], /transcrib/i)
  assert.match(channel.sent[0], /appear in this channel/i)
  feed.stop()
})
