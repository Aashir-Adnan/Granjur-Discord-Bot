import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestStatusLabel, timelineLines, myRequestsLines } from './clientRequestView.js'

test('pending is "Waiting on you"; every other status keeps its label', () => {
  assert.equal(requestStatusLabel('pending'), 'Waiting on you')
  assert.equal(requestStatusLabel('in_progress'), 'in progress')
  assert.equal(requestStatusLabel('done'), 'done')
})

test('timeline keeps status and assignee changes only, newest last, capped', () => {
  const rows = [
    { createdAt: new Date('2026-09-24T10:00:00Z'), actorLabel: 'Sam', changes: [{ field: 'status', from: 'open', to: 'in_progress' }, { field: 'estimateMinutes', from: null, to: 120 }] },
    { createdAt: new Date('2026-09-23T10:00:00Z'), actorDiscordId: 'u2', changes: [{ field: 'assignees', added: ['u2'], removed: [] }] },
    { createdAt: new Date('2026-09-22T10:00:00Z'), changes: [{ field: 'scope', from: 'a', to: 'b' }] },
  ]
  const lines = timelineLines(rows, { nameFor: (id) => ({ u2: 'Sam' })[id] })
  const at = (iso) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:d>`
  assert.deepEqual(lines, [
    `${at('2026-09-23T10:00:00Z')} — assigned to Sam`,
    `${at('2026-09-24T10:00:00Z')} — status: open → in progress (Sam)`,
  ])
  assert.ok(!lines.join('\n').includes('120'), 'estimate never renders')
  assert.equal(timelineLines(Array.from({ length: 40 }, (_, i) => ({ createdAt: new Date(2026, 0, 1 + i), changes: [{ field: 'status', from: 'a', to: 'b' }] })), {}).length, 15)
})

test('myRequestsLines shows type, title, project, status and channel', () => {
  const lines = myRequestsLines([
    { type: 'bug', title: 'Login fails', projectName: 'Framework', status: 'pending', discordChannelId: 'c1' },
    { type: 'feature', title: 'Export', projectName: null, status: 'open', discordChannelId: null },
  ])
  assert.deepEqual(lines, [
    '🐞 **Login fails** · Framework · **Waiting on you** · <#c1>',
    '✨ **Export** · no project · open',
  ])
})
