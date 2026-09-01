import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapMeetingTaskToRow } from './meetingTaskMap.js'

test('maps a csaas task + review row to a task.create payload', () => {
  const row = mapMeetingTaskToRow(
    { task_id: 'ct1', project: 'granjur', feature: 'Auth', sub_feature: 'Login',
      goal_of_task: 'Build login', intended_actions: ['a', 'b'], suggested_commands: ['npm t'],
      code_residence: 'src/auth.js' },
    { taskId: 'ct1', assigneeRef: '11', github: true, rejected: false },
    { guildConfigId: 'g', meetingId: 'M', discordChannelId: 'c', botUserId: 'bot', repositoryId: 'r1' },
  )
  assert.equal(row.guildConfigId, 'g')
  assert.equal(row.type, 'feature')
  assert.equal(row.is_feature, true)
  assert.equal(row.is_bug, false)
  assert.equal(row.title, 'Build login')
  assert.deepEqual(row.assigneeIds, ['11'])
  assert.equal(row.status, 'open')
  assert.equal(row.createdBy, 'bot')
  assert.equal(row.projectName, 'granjur')
  assert.equal(row.scope, 'Auth')
  assert.deepEqual(row.modules, ['Login'])
  assert.equal(row.externalId, 'csaas:ct1')
  assert.equal(row.meetingId, 'M')
  assert.equal(row.discordChannelId, 'c')
  assert.equal(row.repositoryId, 'r1')
  assert.match(row.description, /a\nb/)
  assert.match(row.description, /Suggested commands:\nnpm t/)
  assert.match(row.description, /Code: src\/auth\.js/)
})

test('empty task yields null description and empty collections', () => {
  const row = mapMeetingTaskToRow(
    { task_id: 'ct2' },
    { taskId: 'ct2', rejected: false },
    { guildConfigId: 'g', meetingId: 'M' },
  )
  assert.equal(row.description, null)
  assert.equal(row.title, 'Meeting task')
  assert.deepEqual(row.assigneeIds, [])
  assert.deepEqual(row.modules, [])
  assert.equal(row.projectName, null)
  assert.equal(row.repositoryId, null)
  assert.equal(row.createdBy, null)
  assert.equal(row.discordChannelId, null)
})
