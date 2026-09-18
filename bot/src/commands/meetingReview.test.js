import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReviewCustomId } from './meetingReview.js'

test('parseReviewCustomId splits kind/job/task', () => {
  assert.deepEqual(parseReviewCustomId('mtg_assignee:job1:taskA'), { kind: 'mtg_assignee', jobId: 'job1', taskId: 'taskA' })
  assert.deepEqual(parseReviewCustomId('mtg_approve:job1'), { kind: 'mtg_approve', jobId: 'job1', taskId: undefined })
  assert.deepEqual(parseReviewCustomId('mtg_page:job1:2'), { kind: 'mtg_page', jobId: 'job1', taskId: '2' })
})

test('parseReviewCustomId handles gh / taskreject / reject', () => {
  assert.deepEqual(parseReviewCustomId('mtg_gh:j:t'), { kind: 'mtg_gh', jobId: 'j', taskId: 't' })
  assert.deepEqual(parseReviewCustomId('mtg_taskreject:j:t'), { kind: 'mtg_taskreject', jobId: 'j', taskId: 't' })
  assert.deepEqual(parseReviewCustomId('mtg_reject:j'), { kind: 'mtg_reject', jobId: 'j', taskId: undefined })
})

test('parseReviewCustomId tolerates task ids containing colons', () => {
  assert.deepEqual(parseReviewCustomId('mtg_assignee:job1:a:b:c'), { kind: 'mtg_assignee', jobId: 'job1', taskId: 'a:b:c' })
})
