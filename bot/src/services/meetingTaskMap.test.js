import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapMeetingTaskToRow, meetingTaskScope, meetingTaskModules } from './meetingTaskMap.js'

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
  // No project resolved: no name either. The name CSAAS heard is not kept
  // (roadmap sub-project 2), so it cannot become a stray project group.
  assert.equal(row.projectName, null)
  // No scope from CSAAS and no platform: no scope. The free-text feature is a
  // module now, never a scope (roadmap sub-project 2, 2026-09-29).
  assert.equal(row.scope, null)
  assert.deepEqual(row.modules, ['Auth', 'Login'])
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

test('title is capped at 200 chars', () => {
  const row = mapMeetingTaskToRow(
    { task_id: 'ct3', goal_of_task: 'x'.repeat(500) },
    { taskId: 'ct3', rejected: false },
    { guildConfigId: 'g', meetingId: 'M' },
  )
  assert.equal(row.title.length, 200)
})

test('description is capped at 4000 chars', () => {
  const row = mapMeetingTaskToRow(
    { task_id: 'ct4', intended_actions: ['y'.repeat(3000), 'z'.repeat(3000)] },
    { taskId: 'ct4', rejected: false },
    { guildConfigId: 'g', meetingId: 'M' },
  )
  assert.equal(row.description.length, 4000)
})

test('meetingTaskScope takes a valid CSAAS scope, in any case or padding', () => {
  assert.equal(meetingTaskScope({ scope: 'backend' }), 'backend')
  assert.equal(meetingTaskScope({ scope: '  Frontend ' }), 'frontend')
  assert.equal(meetingTaskScope({ scope: 'QA' }), 'qa')
  assert.equal(meetingTaskScope({ scope: 'design', platform: 'node' }), 'design', 'Claude wins over platform')
})

test('meetingTaskScope falls back to the platform when the scope is missing or free text', () => {
  assert.equal(meetingTaskScope({ platform: 'node' }), 'backend')
  assert.equal(meetingTaskScope({ platform: 'Python' }), 'backend')
  assert.equal(meetingTaskScope({ platform: 'react' }), 'frontend')
  assert.equal(meetingTaskScope({ scope: 'GitSync', platform: 'react-native' }), 'frontend')
})

test('meetingTaskScope is null with no usable scope or platform', () => {
  assert.equal(meetingTaskScope({}), null)
  assert.equal(meetingTaskScope({ scope: 'GitSync', platform: 'other' }), null)
  assert.equal(meetingTaskScope(null), null)
})

test('meetingTaskModules keeps feature and sub-feature, trimmed, without blanks or duplicates', () => {
  assert.deepEqual(meetingTaskModules({ feature: ' Auth ', sub_feature: 'Login' }), ['Auth', 'Login'])
  assert.deepEqual(meetingTaskModules({ feature: 'Auth', sub_feature: 'auth' }), ['Auth'])
  assert.deepEqual(meetingTaskModules({ feature: '', sub_feature: 'Login' }), ['Login'])
  assert.deepEqual(meetingTaskModules({}), [])
})

test('mapMeetingTaskToRow stores the fixed scope', () => {
  const row = mapMeetingTaskToRow(
    { task_id: 'ct9', scope: 'Backend', feature: 'GitSync' },
    { taskId: 'ct9', rejected: false },
    { guildConfigId: 'g', meetingId: 'M' },
  )
  assert.equal(row.scope, 'backend')
  assert.deepEqual(row.modules, ['GitSync'])
})
