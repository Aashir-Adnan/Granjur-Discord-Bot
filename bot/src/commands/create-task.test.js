import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assigneeRow } from './create-task.js'

test('assignee row is a user select allowing up to 25 people with current assignees preselected', () => {
  const row = assigneeRow({ assigneeIds: ['111', '222'] }).toJSON()
  const menu = row.components[0]
  assert.equal(menu.custom_id, 'create_task_assignees')
  assert.equal(menu.type, 5) // ComponentType.UserSelect
  assert.equal(menu.min_values, 0)
  assert.equal(menu.max_values, 25)
  assert.deepEqual(menu.default_values.map((d) => d.id), ['111', '222'])
})

test('assignee row with no assignees has no defaults', () => {
  const menu = assigneeRow({}).toJSON().components[0]
  assert.ok(!menu.default_values || menu.default_values.length === 0)
})
