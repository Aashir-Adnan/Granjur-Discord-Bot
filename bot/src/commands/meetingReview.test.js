import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReviewCustomId, reviewActionFor, notesAttachedIn } from './meetingReview.js'

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

test('reviewActionFor maps each component kind to its review action', () => {
  assert.deepEqual(reviewActionFor('mtg_assignee', 't', ['11']), { type: 'assignee', taskId: 't', ref: '11' })
  assert.deepEqual(reviewActionFor('mtg_assignee', 't', []), { type: 'assignee', taskId: 't', ref: null })
  assert.deepEqual(reviewActionFor('mtg_project', 't', ['p2']), { type: 'project', taskId: 't', projectId: 'p2' })
  assert.deepEqual(reviewActionFor('mtg_project', 't', ['none']), { type: 'project', taskId: 't', projectId: 'none' })
  assert.deepEqual(reviewActionFor('mtg_gh', 't'), { type: 'toggleGithub', taskId: 't' })
  assert.deepEqual(reviewActionFor('mtg_taskreject', 't'), { type: 'rejectTask', taskId: 't' })
  assert.deepEqual(reviewActionFor('mtg_page', '2'), { type: 'page', page: 2 })
  assert.equal(reviewActionFor('mtg_unknown', 't'), null)
})

test('parseReviewCustomId handles the project select', () => {
  assert.deepEqual(parseReviewCustomId('mtg_project:j:7'), { kind: 'mtg_project', jobId: 'j', taskId: '7' })
})

test('notesAttachedIn: only in the channel the notes message was posted to', () => {
  const d = { notesMessageId: 'n1', notesChannelId: 'c1' }
  assert.equal(notesAttachedIn(d, 'c1'), true)
  assert.equal(notesAttachedIn(d, 'c2'), false)
})

test('notesAttachedIn: a job reviewed before notesChannelId existed, or with no notes, is false', () => {
  assert.equal(notesAttachedIn({ notesMessageId: 'n1' }, 'c1'), false)
  assert.equal(notesAttachedIn({ notesChannelId: 'c1' }, 'c1'), false)
  assert.equal(notesAttachedIn(undefined, 'c1'), false)
})
