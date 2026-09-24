import { ChannelType } from 'discord.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskChannelName, taskChannelTopic, isTicketChannel } from './taskChannelName.js'

const ID = 'a1b2c3d4e5f6a7b8c9d0e1f2'

test('a feature is named after its title', () => {
  assert.equal(taskChannelName({ type: 'feature', title: 'Git Sync', taskId: ID }), 'feature-git-sync')
})

test('a bug uses the bug prefix and squashes punctuation', () => {
  assert.equal(taskChannelName({ type: 'bug', title: 'Login  crash!! (urgent)', taskId: ID }), 'bug-login-crash-urgent')
})

test('an empty or symbol-only title falls back to the short id', () => {
  assert.equal(taskChannelName({ type: 'feature', title: '', taskId: ID }), `feature-${ID.slice(-6)}`)
  assert.equal(taskChannelName({ type: 'feature', title: '!!! ???', taskId: ID }), `feature-${ID.slice(-6)}`)
})

test('a long title is cut to 100 characters and never loses its prefix', () => {
  const name = taskChannelName({ type: 'feature', title: 'x'.repeat(200), taskId: ID })
  assert.equal(name.length, 100)
  assert.ok(name.startsWith('feature-'))
  assert.ok(!name.endsWith('-'))
})

test('a taken name gets four characters of the id, and is stable on repeat', () => {
  const taken = new Set(['feature-git-sync'])
  const a = taskChannelName({ type: 'feature', title: 'Git Sync', taskId: ID, taken })
  assert.equal(a, `feature-git-sync-${ID.slice(0, 4)}`)
  assert.equal(taskChannelName({ type: 'feature', title: 'Git Sync', taskId: ID, taken }), a)
})

test('when the suffixed name is also taken it grows deterministically', () => {
  const taken = new Set(['feature-git-sync', `feature-git-sync-${ID.slice(0, 4)}`])
  const name = taskChannelName({ type: 'feature', title: 'Git Sync', taskId: ID, taken })
  assert.equal(name, `feature-git-sync-${ID.slice(0, 8)}`)
})

// A client's SUPPORT TASK is its own kind: not a bug, not a feature.
test('a support task uses the task prefix, the Task: topic, and is recognised as a ticket channel', () => {
  assert.equal(taskChannelName({ type: 'task', title: 'Move students', taskId: ID }), 'task-move-students')
  assert.equal(taskChannelTopic({ type: 'task', title: 'Move students', taskId: ID }), `Task: Move students — Task ${ID}`)
  assert.equal(isTicketChannel({ type: ChannelType.GuildText, id: 'x', name: 'anything', topic: `Task: Move students — Task ${ID}` }), true)
  assert.equal(isTicketChannel({ type: ChannelType.GuildText, id: 'x', name: 'task-move-students', topic: '' }), true)
})
