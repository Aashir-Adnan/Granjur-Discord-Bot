import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocTextError } from '../services/docText.js'
import { execute, readBrief, documentReplyLines, MAX_BRIEF_CHARS } from './record.js'

const attachment = { name: 'agenda.md', url: 'https://cdn.test/agenda.md', size: 10 }

// Fakes for everything execute touches: no Discord, no database, no CSAAS, no network.
function harness({ action = 'start', doc = null, extractText = 'hello', extractError = null, voice = true } = {}) {
  const replies = []
  const calls = { start: [], stop: [], download: [], extract: [] }
  const interaction = {
    client: {},
    user: { id: 'u1' },
    guild: {
      client: { user: { id: 'bot' } },
      members: { fetch: async () => ({ voice: { channel: voice ? { id: 'vc1', name: 'Standup' } : null } }) },
    },
    options: {
      getString: () => action,
      getAttachment: (name) => (name === 'document' ? doc : null),
    },
    editReply: async (r) => { replies.push(r) },
  }
  const deps = {
    start: async (...args) => { calls.start.push(args) },
    stop: async (id) => { calls.stop.push(id); return true },
    recording: () => false,
    ensureChannel: async () => ({ meetingId: 'm1', guildConfigId: 'g1' }),
    resolveChannel: async () => null,
    pinGuidelines: async () => {},
    db: {},
    download: async (a) => { calls.download.push(a); return Buffer.from('x') },
    extract: async (a) => {
      calls.extract.push(a)
      if (extractError) throw extractError
      return { text: extractText, chars: extractText.length }
    },
  }
  return { interaction, deps, calls, replies }
}
const description = (replies) => replies[0].embeds[0].data.description

test('documentReplyLines: a short document gets one line', () => {
  assert.deepEqual(documentReplyLines({ fileName: 'a.md', chars: 3000 }), [
    'Using **a.md** as background for this meeting.',
  ])
})

test('documentReplyLines: over 3,000 characters adds the second line', () => {
  assert.deepEqual(documentReplyLines({ fileName: 'a.md', chars: 3001 }), [
    'Using **a.md** as background for this meeting.',
    'Claude reads the first 3,000 characters of it.',
  ])
})

test('documentReplyLines: an error explains that the document was not used', () => {
  assert.deepEqual(documentReplyLines({ error: '**a.md** could not be read.' }), [
    'The document was not used: **a.md** could not be read.',
  ])
})

test('readBrief caps the text at 20,000 characters but reports the full length', async () => {
  const long = 'x'.repeat(25000)
  const out = await readBrief(attachment, {
    download: async () => Buffer.from('b'),
    extract: async () => ({ text: long, chars: long.length }),
  })
  assert.equal(out.text.length, MAX_BRIEF_CHARS)
  assert.equal(out.chars, 25000)
  assert.equal(out.fileName, 'agenda.md')
})

test('readBrief turns a DocTextError into its sentence and rethrows anything else', async () => {
  const refused = await readBrief(attachment, {
    download: async () => { throw new DocTextError('**agenda.md** could not be downloaded.') },
    extract: async () => { throw new Error('unreachable') },
  })
  assert.deepEqual(refused, { error: '**agenda.md** could not be downloaded.' })

  await assert.rejects(
    () => readBrief(attachment, { download: async () => { throw new Error('bug') }, extract: async () => ({}) }),
    /bug/,
  )
})

test('start with a document passes the text to the recording and says so in the reply', async () => {
  const h = harness({ doc: attachment, extractText: 'Discuss the launch.' })
  await execute(h.interaction, h.deps)

  assert.equal(h.calls.start.length, 1)
  assert.deepEqual(h.calls.start[0].slice(2, 4), ['m1', 'vc1'])
  assert.deepEqual(h.calls.start[0][4], { preMeetingNotes: 'Discuss the launch.' })
  assert.deepEqual(h.calls.extract[0].fileName, 'agenda.md')
  assert.match(description(h.replies), /Recording individual voices in \*\*Standup\*\*/)
  assert.match(description(h.replies), /\nUsing \*\*agenda\.md\*\* as background for this meeting\.$/)
})

test('start with a long document sends at most 20,000 characters and adds the 3,000 line', async () => {
  const h = harness({ doc: attachment, extractText: 'y'.repeat(30000) })
  await execute(h.interaction, h.deps)

  assert.equal(h.calls.start[0][4].preMeetingNotes.length, 20000)
  assert.match(description(h.replies), /\nUsing \*\*agenda\.md\*\* as background for this meeting\.\nClaude reads the first 3,000 characters of it\.$/)
})

test('an unreadable document still starts the recording, without a brief, and explains', async () => {
  const h = harness({ doc: attachment, extractError: new DocTextError('**agenda.md** could not be read.') })
  await execute(h.interaction, h.deps)

  assert.equal(h.calls.start.length, 1)
  assert.deepEqual(h.calls.start[0][4], {})
  assert.match(description(h.replies), /\nThe document was not used: \*\*agenda\.md\*\* could not be read\.$/)
  assert.doesNotMatch(description(h.replies), /Using \*\*/)
})

test('start without a document behaves as before: no brief, unchanged reply', async () => {
  const h = harness()
  await execute(h.interaction, h.deps)

  assert.equal(h.calls.download.length, 0)
  assert.deepEqual(h.calls.start[0][4], {})
  assert.equal(
    description(h.replies),
    'Recording individual voices in **Standup**. Run `/record action:stop` when done.',
  )
})

test('stop ignores a document: nothing is downloaded and the recording is stopped', async () => {
  const h = harness({ action: 'stop', doc: attachment })
  await execute(h.interaction, h.deps)

  assert.equal(h.calls.download.length, 0)
  assert.equal(h.calls.start.length, 0)
  assert.deepEqual(h.calls.stop, ['m1'])
})

test('not in a voice channel: the document is not read', async () => {
  const h = harness({ doc: attachment, voice: false })
  await execute(h.interaction, h.deps)

  assert.equal(h.calls.download.length, 0)
  assert.equal(h.calls.start.length, 0)
  assert.equal(h.replies[0].content, 'Join a voice channel first, then run this command.')
})
