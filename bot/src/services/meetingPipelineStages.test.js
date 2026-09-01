import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stageRunners } from './meetingPipelineStages.js'

test('transcribing uploads only not-yet-uploaded files, idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-'))
  const f1 = path.join(dir, 'ali.ogg'); fs.writeFileSync(f1, 'aaa')
  const f2 = path.join(dir, 'sara.ogg'); fs.writeFileSync(f2, 'bbb')

  const uploaded = []
  const csaasClient = {
    transcribeSegment: async (mid, { filename, segmentIndex }) => {
      uploaded.push({ filename, segmentIndex }); return { preview: 'ok' }
    },
  }
  const db = {
    meetingRecording: { findMany: async () => [
      { id: 'r1', filePath: f1, fileName: 'ali.ogg', startedAt: '2026-01-01T00:00:00Z' },
      { id: 'r2', filePath: f2, fileName: 'sara.ogg', startedAt: '2026-01-01T00:01:00Z' },
    ] },
  }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: { uploaded: ['r1'] } }
  const out = await stageRunners.transcribing({ job, db, csaasClient, client: {} })
  assert.deepEqual(uploaded.map((u) => u.filename), ['sara.ogg'])
  assert.equal(uploaded[0].segmentIndex, 1) // uploaded.length was 1
  assert.deepEqual(out.patch.dataJson.uploaded.sort(), ['r1', 'r2'])
})

test('transcribing one successful upload per tick, advance false on partial progress', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-'))
  const f1 = path.join(dir, 'ali.ogg'); fs.writeFileSync(f1, 'aaa')
  const f2 = path.join(dir, 'sara.ogg'); fs.writeFileSync(f2, 'bbb')

  const calls = []
  const csaasClient = {
    transcribeSegment: async (mid, opts) => { calls.push(opts); return {} },
  }
  const db = {
    meetingRecording: { findMany: async () => [
      { id: 'r2', filePath: f2, fileName: 'sara.ogg', startedAt: '2026-01-01T00:01:00Z' },
      { id: 'r1', filePath: f1, fileName: 'ali.ogg', startedAt: '2026-01-01T00:00:00Z' },
    ] },
  }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: {} }

  const t1 = await stageRunners.transcribing({ job, db, csaasClient, client: {} })
  assert.equal(t1.advance, false)
  assert.deepEqual(calls.map((c) => c.filename), ['ali.ogg']) // sorted by startedAt asc
  assert.equal(calls[0].segmentIndex, 0)
  assert.deepEqual(t1.patch.dataJson.uploaded, ['r1'])

  const job2 = { ...job, dataJson: t1.patch.dataJson }
  const t2 = await stageRunners.transcribing({ job: job2, db, csaasClient, client: {} })
  assert.equal(t2.advance, false)
  assert.deepEqual(calls.map((c) => c.filename), ['ali.ogg', 'sara.ogg'])
  assert.equal(calls[1].segmentIndex, 1)

  const job3 = { ...job, dataJson: t2.patch.dataJson }
  const t3 = await stageRunners.transcribing({ job: job3, db, csaasClient, client: {} })
  assert.notEqual(t3.advance, false) // advance to analyzing
  assert.deepEqual(t3.patch.dataJson.uploaded.sort(), ['r1', 'r2'])
})

test('transcribing records unreadable files in missing, keeps segment indexes contiguous', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-'))
  const f2 = path.join(dir, 'sara.ogg'); fs.writeFileSync(f2, 'bbb')
  const gone = path.join(dir, 'nope.ogg')

  const calls = []
  const csaasClient = {
    transcribeSegment: async (mid, opts) => { calls.push(opts); return {} },
  }
  const db = {
    meetingRecording: { findMany: async () => [
      { id: 'r1', filePath: gone, fileName: 'nope.ogg', startedAt: '2026-01-01T00:00:00Z' },
      { id: 'r2', filePath: f2, fileName: 'sara.ogg', startedAt: '2026-01-01T00:01:00Z' },
    ] },
  }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: {} }
  const out = await stageRunners.transcribing({ job, db, csaasClient, client: {} })
  // missing file skipped in same tick, second file uploaded
  assert.deepEqual(out.patch.dataJson.missing, ['r1'])
  assert.deepEqual(out.patch.dataJson.uploaded, ['r2'])
  assert.equal(calls[0].segmentIndex, 0) // missing files do not consume an index — first success is index 0
  assert.equal(out.advance, false)
})

test('transcribing throws when every file is missing', async () => {
  const db = {
    meetingRecording: { findMany: async () => [
      { id: 'r1', filePath: '/no/such/a.ogg', fileName: 'a.ogg', startedAt: '2026-01-01T00:00:00Z' },
      { id: 'r2', filePath: '/no/such/b.ogg', fileName: 'b.ogg', startedAt: '2026-01-01T00:01:00Z' },
    ] },
  }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: {} }
  const csaasClient = { transcribeSegment: async () => { throw new Error('should not be called') } }
  await assert.rejects(
    () => stageRunners.transcribing({ job, db, csaasClient, client: {} }),
    /all meeting recording files missing on disk/,
  )
})

test('stageRunners still exposes the created stage', () => {
  assert.equal(typeof stageRunners.created, 'function')
})

test('analyzing/generating_tasks/assigning store their results on dataJson', async () => {
  const csaasClient = {
    analyze: async () => ({ analysis: { summary: 's' } }),
    generateTasks: async () => ({ tasks: [{ task_id: 't1', goal_of_task: 'g' }] }),
    assign: async () => ({ assignments: [{ task_id: 't1', assignee_ref: '11', quote: 'q', confidence: 0.9 }] }),
  }
  const db = { meetingRecording: { findMany: async () => [] } }
  let job = { id: 'j', meetingId: 'M', csaasMeetingId: 'm', dataJson: { roster: [{ ref: '11', displayName: 'Ali', aliases: ['Ali'] }] } }

  let out = await stageRunners.analyzing({ job, db, csaasClient, client: {} })
  Object.assign(job.dataJson, out.patch.dataJson)
  assert.equal(job.dataJson.analysis.summary, 's')

  out = await stageRunners.generating_tasks({ job, db, csaasClient, client: {} })
  Object.assign(job.dataJson, out.patch.dataJson)
  assert.equal(job.dataJson.tasks[0].task_id, 't1')

  out = await stageRunners.assigning({ job, db, csaasClient, client: {} })
  Object.assign(job.dataJson, out.patch.dataJson)
  assert.equal(job.dataJson.assignments[0].assignee_ref, '11')

  // prior keys survive, assigning does not block
  assert.deepEqual(job.dataJson.roster[0].ref, '11')
  assert.notEqual(out.block, true)
})

function reviewJob() {
  return {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      title: 'T',
      tasks: [{ task_id: 'a', goal_of_task: 'A' }],
      assignments: [{ task_id: 'a', assignee_ref: '11' }],
      roster: [{ ref: '11', displayName: 'Ali', aliases: [] }],
    },
  }
}

test('awaiting_review posts a message and blocks', async () => {
  process.env.MEETING_REPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-reports-'))
  const sent = []
  const channel = { send: async (payload) => { sent.push(payload); return { id: 'msg1' } } }
  const fetched = []
  const client = { channels: { fetch: async (id) => { fetched.push(id); return channel } } }
  const csaasClient = { fetchNotes: async () => ({ notes: 'Notes body', html: '<html></html>' }) }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1', createdAt: '2026-01-01' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    meetingRecording: { findMany: async () => [] },
  }
  const out = await stageRunners.awaiting_review({ job: reviewJob(), db, csaasClient, client })
  assert.equal(out.block, true)
  assert.equal(out.patch.reviewMessageId, 'msg1')
  assert.equal(sent.length, 1)
  assert.equal(fetched[0], 'tc1')
  assert.equal(typeof out.patch.dataJson.review, 'object')
  assert.ok(Array.isArray(out.patch.dataJson.review.tasks))
  assert.equal(out.patch.dataJson.notes, 'Notes body')
})

test('awaiting_review posts even without html report', async () => {
  process.env.MEETING_REPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-reports-'))
  const sent = []
  const channel = { send: async (payload) => { sent.push(payload); return { id: 'msg2' } } }
  const client = { channels: { fetch: async () => channel } }
  const csaasClient = { fetchNotes: async () => ({ notes: 'Only notes' }) }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    meetingRecording: { findMany: async () => [] },
  }
  const out = await stageRunners.awaiting_review({ job: reviewJob(), db, csaasClient, client })
  assert.equal(out.block, true)
  assert.equal(out.patch.reviewMessageId, 'msg2')
  assert.equal(sent.length, 1)
  const desc = sent[0].embeds[0].data.description
  assert.ok(!/Full report:/.test(desc))
})

test('awaiting_review still blocks when channel resolution fails', async () => {
  process.env.MEETING_REPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-reports-'))
  const client = { channels: { fetch: async () => { throw new Error('no channel') } } }
  const csaasClient = { fetchNotes: async () => ({ notes: 'N', html: '<html></html>' }) }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => null },
    meetingRecording: { findMany: async () => [] },
  }
  const out = await stageRunners.awaiting_review({ job: reviewJob(), db, csaasClient, client })
  assert.equal(out.block, true)
  assert.equal(out.patch.reviewMessageId, undefined)
  assert.equal(typeof out.patch.dataJson.review, 'object')
})
