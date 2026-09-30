import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  projectFindManySql, taskFindManySql, taskFindByIdsSql, ticketDocListWithTaskSql, projectUpdateSql,
} from './index.js'

const HIDE_TASK = 'AND NOT EXISTS (SELECT 1 FROM `project` p WHERE p.id = task.projectId AND p.deletedAt IS NOT NULL)'
const HIDE_DOC = 'AND NOT EXISTS (SELECT 1 FROM `project` p WHERE p.id = t.projectId AND p.deletedAt IS NOT NULL)'

test('project.findMany hides deleted projects by default', () => {
  const { sql, params } = projectFindManySql({ guildConfigId: 'g1' })
  assert.equal(sql, 'SELECT * FROM `project` WHERE guildConfigId = ? AND deletedAt IS NULL')
  assert.deepEqual(params, ['g1'])
})

test('project.findMany with includeDeleted: true keeps the old statement, and the flag is not a column', () => {
  const { sql, params } = projectFindManySql({ guildConfigId: 'g1', includeDeleted: true })
  assert.equal(sql, 'SELECT * FROM `project` WHERE guildConfigId = ?')
  assert.deepEqual(params, ['g1'])
  assert.ok(!/includeDeleted/.test(sql))
})

test('project.findMany: only includeDeleted === true opts in', () => {
  assert.match(projectFindManySql({ guildConfigId: 'g1', includeDeleted: 1 }).sql, /deletedAt IS NULL/)
})

test('task.findMany hides tasks of deleted projects by default', () => {
  const { sql, params } = taskFindManySql({ where: { guildConfigId: 'g1', status: 'open' } })
  assert.equal(sql, `SELECT * FROM \`task\` WHERE guildConfigId = ? AND status = ? ${HIDE_TASK} ORDER BY \`createdAt\` DESC LIMIT 500`)
  assert.deepEqual(params, ['g1', 'open'])
})

test('task.findMany with includeDeleted: true has no project clause and no flag in the SQL', () => {
  const { sql, params } = taskFindManySql({ where: { guildConfigId: 'g1', includeDeleted: true }, take: 5 })
  assert.equal(sql, 'SELECT * FROM `task` WHERE guildConfigId = ? ORDER BY `createdAt` DESC LIMIT 5')
  assert.deepEqual(params, ['g1'])
})

test('task.findMany keeps projectId filters alongside the hiding clause', () => {
  const a = taskFindManySql({ where: { guildConfigId: 'g1', projectId: 'p1' } })
  assert.match(a.sql, /AND projectId = \? AND NOT EXISTS/)
  assert.deepEqual(a.params, ['g1', 'p1'])
  const b = taskFindManySql({ where: { guildConfigId: 'g1', projectId: null } })
  assert.match(b.sql, /AND projectId IS NULL AND NOT EXISTS/)
})

test('task.findMany without a guild builds nothing', () => {
  assert.equal(taskFindManySql({ where: {} }), null)
})

test('task.findByIds hides tasks of deleted projects by default', () => {
  const { sql, params } = taskFindByIdsSql({ guildConfigId: 'g1', ids: ['a', 'b'] })
  assert.equal(sql, `SELECT * FROM \`task\` WHERE guildConfigId = ? AND id IN (?, ?) ${HIDE_TASK}`)
  assert.deepEqual(params, ['g1', 'a', 'b'])
})

test('task.findByIds with includeDeleted: true is the old statement', () => {
  const { sql, params } = taskFindByIdsSql({ guildConfigId: 'g1', ids: ['a'], includeDeleted: true })
  assert.equal(sql, 'SELECT * FROM `task` WHERE guildConfigId = ? AND id IN (?)')
  assert.deepEqual(params, ['g1', 'a'])
})

test('task.findByIds with nothing to look up builds nothing', () => {
  assert.equal(taskFindByIdsSql({ guildConfigId: 'g1', ids: [] }), null)
  assert.equal(taskFindByIdsSql({ ids: ['a'] }), null)
})

test('ticketDoc.listWithTask hides docs of deleted projects by default', () => {
  const { sql, params } = ticketDocListWithTaskSql({ guildConfigId: 'g1' })
  assert.ok(sql.includes(HIDE_DOC))
  assert.ok(sql.indexOf(HIDE_DOC) < sql.indexOf('ORDER BY'))
  assert.deepEqual(params, ['g1'])
})

test('ticketDoc.listWithTask with includeDeleted: true has no project clause', () => {
  const { sql } = ticketDocListWithTaskSql({ guildConfigId: 'g1', includeDeleted: true })
  assert.ok(!/NOT EXISTS/.test(sql))
})

test('project.update can write deletedAt and deletedBy', () => {
  const at = new Date('2026-10-01T00:00:00Z')
  const { sql, params } = projectUpdateSql('p1', { deletedAt: at, deletedBy: 'u1' })
  assert.equal(sql, 'UPDATE `project` SET deletedAt = ?, deletedBy = ? WHERE id = ?')
  assert.deepEqual(params, [at, 'u1', 'p1'])
})

test('project.update can reactivate by writing null', () => {
  const { sql, params } = projectUpdateSql('p1', { deletedAt: null, deletedBy: null })
  assert.equal(sql, 'UPDATE `project` SET deletedAt = ?, deletedBy = ? WHERE id = ?')
  assert.deepEqual(params, [null, null, 'p1'])
})
