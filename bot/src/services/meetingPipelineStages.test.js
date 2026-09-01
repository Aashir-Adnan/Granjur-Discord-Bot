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
  assert.equal(calls[0].segmentIndex, 1) // index = uploaded + missing count
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
