import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectUpdateSql } from './index.js'

test('project update: one ordered array drives the SET list and the params', () => {
  const { sql, params } = projectUpdateSql('p1', {
    discordCategoryId: 'c1', discordRoleId: 'r1', discordChannels: { members: 'm1' },
  })
  const sets = sql.match(/SET (.+) WHERE/)[1].split(',').map((s) => s.trim())
  assert.deepEqual(sets, ['discordCategoryId = ?', 'discordRoleId = ?', 'discordChannels = ?'])
  assert.deepEqual(params, ['c1', 'r1', '{"members":"m1"}', 'p1'])
  assert.equal((sql.match(/\?/g) || []).length, params.length)
  assert.match(sql, /^UPDATE `project` SET /)
})

test('project update: only the given fields are written, id is always last', () => {
  const { sql, params } = projectUpdateSql('p2', { name: 'Framework' })
  assert.match(sql, /SET name = \? WHERE id = \?$/)
  assert.deepEqual(params, ['Framework', 'p2'])
})

test('project update: nothing to write returns null', () => {
  assert.equal(projectUpdateSql('p3', {}), null)
})
