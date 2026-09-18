import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { clearStaleLiveSession } from './voiceCapture.js'

test('the stale live session is cleared before a new recording can write over it', async () => {
  const calls = []
  const db = {
    meeting: { update: async (args) => { calls.push(['meeting.update', args]) } },
    meetingUtterance: { deleteMany: async (args) => { calls.push(['utterance.deleteMany', args]) } },
  }

  await clearStaleLiveSession(db, 'm1')

  assert.deepEqual(calls.map(([name]) => name), ['meeting.update', 'utterance.deleteMany'])
  // The old CSAAS meeting id has to go too: createdStage reuses whatever is on
  // the row, so leaving it would file this meeting's analysis under the last one.
  assert.deepEqual(calls[0][1], { where: { id: 'm1' }, data: { csaasMeetingId: null } })
  assert.deepEqual(calls[1][1], { where: { meetingId: 'm1' } })
})

test('a failed clear propagates, so the caller can refuse to start a feed', async () => {
  // Recording a second meeting in the same voice channel with the previous
  // meeting's turns still present means the feed overwrites them row by row
  // (ON DUPLICATE KEY on (meetingId, sequence)). Silence here is what made that
  // corruption invisible.
  const db = {
    meeting: { update: async () => {} },
    meetingUtterance: { deleteMany: async () => { throw new Error('db down') } },
  }
  await assert.rejects(() => clearStaleLiveSession(db, 'm1'), /db down/)
})

test('recording start posts consent and clears the stale session before CSAAS is called', () => {
  // Both live outside the CSAAS block on purpose: the notice because consent is
  // announced whether or not the backend answers, the clear because stale turns
  // are what the pipeline would otherwise analyse for this meeting. Source-level
  // for the same reason as the guard test below — startMeetingRecording needs a
  // live voice connection and a database.
  const src = readFileSync(new URL('./voiceCapture.js', import.meta.url), 'utf8')
  const start = src.indexOf('export async function startMeetingRecording')
  const body = src.slice(start)

  const notice = body.indexOf('postConsentNotice(')
  const clear = body.indexOf('clearStaleLiveSession(db, meetingId)')
  const create = body.indexOf('csaasClient.createMeeting(')
  const configured = body.indexOf('csaasClient.isConfigured()')

  assert.ok(notice > -1, 'recording start must post the consent notice')
  assert.ok(clear > -1, 'recording start must clear the previous session')
  assert.ok(notice < configured, 'the notice must not depend on CSAAS being configured')
  assert.ok(clear < create, 'nothing may write utterances before the old ones are gone')
})

test('endMeetingSession refuses to run twice', () => {
  // A behavioural test would need a live voice connection and a database:
  // endMeetingSession is a closure built inside startMeetingRecording and is not
  // reachable from a test. What is asserted instead is that the guard is still
  // the first thing the function does. Teardown now parks for tens of seconds
  // (final utterance flush, then feed.stop() draining three 30 s STT calls) while
  // the meeting is still in activeConnections and sessionEnders, so `/record
  // action:stop` during the empty-channel grace period runs it a second time.
  // Both runs reach connection.destroy(); the second throws, and on the timer
  // path that rejection is unhandled and skips cleanup() and channel deletion.
  const src = readFileSync(new URL('./voiceCapture.js', import.meta.url), 'utf8')
  const start = src.indexOf('const endMeetingSession = async () => {')
  assert.ok(start > -1, 'endMeetingSession moved or was renamed — update this test')

  const firstStatement = src
    .slice(start)
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))[0]

  assert.equal(
    firstStatement,
    'if (sessionEnding) return;',
    'endMeetingSession must return immediately when a teardown is already running',
  )
})
