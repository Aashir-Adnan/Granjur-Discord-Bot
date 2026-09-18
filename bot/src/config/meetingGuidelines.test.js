import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGuidelinesEmbed, findGuidelinesPin, ensureGuidelinesPinned, postConsentNotice, GUIDELINES_MARKER } from './meetingGuidelines.js'

test('the embed explains transcription, the commands and the flow', () => {
  const json = buildGuidelinesEmbed().toJSON()
  const blob = JSON.stringify(json)
  assert.match(blob, /transcri/i, 'says the meeting is transcribed')
  for (const cmd of ['/record', '/schedule', '/meetings', '/meeting-channel', '/meeting-review', '/meeting-retry', '/playback']) {
    assert.ok(blob.includes(cmd), `missing ${cmd}`)
  }
  assert.equal(json.footer.text, GUIDELINES_MARKER)
})

test('an existing pin is recognised by marker and author', () => {
  const mine = { author: { id: 'bot' }, embeds: [{ footer: { text: GUIDELINES_MARKER } }] }
  const theirs = { author: { id: 'someone' }, embeds: [{ footer: { text: GUIDELINES_MARKER } }] }
  const other = { author: { id: 'bot' }, embeds: [{ footer: { text: 'something else' } }] }
  assert.equal(findGuidelinesPin([other, mine], 'bot'), mine)
  assert.equal(findGuidelinesPin([theirs, other], 'bot'), null)
  assert.equal(findGuidelinesPin([], 'bot'), null)
  assert.equal(findGuidelinesPin([{ author: { id: 'bot' }, embeds: [] }], 'bot'), null)
})

test('pinning is idempotent — a second call posts nothing', async () => {
  const pins = []
  const channel = {
    isTextBased: () => true,
    messages: { fetchPinned: async () => pins },
    send: async (payload) => {
      const msg = { author: { id: 'bot' }, embeds: payload.embeds.map((e) => e.toJSON()), pin: async () => { pins.push(msg) } }
      return msg
    },
  }
  assert.equal(await ensureGuidelinesPinned(channel, 'bot'), true)
  assert.equal(pins.length, 1)
  assert.equal(await ensureGuidelinesPinned(channel, 'bot'), false, 'second call is a no-op')
  assert.equal(pins.length, 1)
})

test('a channel that cannot be read never throws at a call site', async () => {
  const channel = {
    isTextBased: () => true,
    messages: { fetchPinned: async () => { throw new Error('Missing Access') } },
    send: async () => { throw new Error('Missing Permissions') },
  }
  assert.equal(await ensureGuidelinesPinned(channel, 'bot'), false)
})

test('the consent notice says the meeting is recorded and where the words go', async () => {
  // Moved here from transcriptFeed: it used to be posted by feed.start(), which
  // only runs when CSAAS answered — so a backend outage meant a meeting recorded
  // with no notice at all. It is now posted from the recording-start path.
  const sent = []
  const channel = { isTextBased: () => true, send: async (payload) => { sent.push(payload) } }

  assert.equal(await postConsentNotice(channel), true)
  assert.equal(sent.length, 1, 'posted exactly once')
  assert.match(sent[0].content, /recorded/i)
  assert.match(sent[0].content, /transcrib/i)
  assert.match(sent[0].content, /appear in this channel/i)
  assert.deepEqual(sent[0].allowedMentions, { parse: [] })
})

test('a channel that refuses the consent notice does not stop the recording', async () => {
  const channel = { isTextBased: () => true, send: async () => { throw new Error('Missing Permissions') } }
  assert.equal(await postConsentNotice(channel), false)
  assert.equal(await postConsentNotice(null), false)
})
