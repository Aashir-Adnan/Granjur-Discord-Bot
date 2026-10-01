import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskFindManySql } from './index.js'

// The pickers (/update-task, /clock-in, the Find panel) used to load the 200
// most recently updated tasks of the whole server and search those in memory;
// one bulk import pushed every other project out of that window. These filters
// move the narrowing into SQL so the window holds matches, not anything.

const HIDE = 'AND NOT EXISTS (SELECT 1 FROM `project` p WHERE p.id = task.projectId AND p.deletedAt IS NOT NULL)'
const base = (where, take = 200) => taskFindManySql({ where: { guildConfigId: 'g1', ...where }, orderBy: { updatedAt: 'desc' }, take })

test('search: a typed term matches title, id prefix, status, scope or project name, in one OR group', () => {
  const { sql, params } = base({ search: { text: 'Abu' } })
  assert.equal(
    sql,
    'SELECT * FROM `task` WHERE guildConfigId = ? AND (LOWER(title) LIKE ? OR id LIKE ? OR LOWER(status) = ? OR LOWER(scope) LIKE ? ' +
      'OR projectId IN (SELECT id FROM `project` WHERE guildConfigId = ? AND LOWER(name) LIKE ?)) ' +
      `${HIDE} ORDER BY \`updatedAt\` DESC LIMIT 200`,
  )
  assert.deepEqual(params, ['g1', '%abu%', 'abu%', 'abu', 'abu%', 'g1', '%abu%'])
})

test('search: a plain string is accepted too, and is trimmed and lower-cased', () => {
  const { params } = base({ search: '  BILLING ' })
  assert.deepEqual(params, ['g1', '%billing%', 'billing%', 'billing', 'billing%', 'g1', '%billing%'])
})

test('search: holder ids (resolved from the member cache by the caller) join the same OR group', () => {
  const { sql, params } = base({ search: { text: 'ali', holderIds: ['u1', 'u2'] } })
  assert.match(sql, /OR JSON_CONTAINS\(assigneeIds, \?\) OR JSON_CONTAINS\(taggedMemberIds, \?\) OR JSON_CONTAINS\(assigneeIds, \?\) OR JSON_CONTAINS\(taggedMemberIds, \?\)\)/)
  assert.deepEqual(params.slice(-4), ['"u1"', '"u1"', '"u2"', '"u2"'])
})

test('search: holder ids alone (a name that matches no title) still narrow the query', () => {
  const { sql, params } = base({ search: { text: '', holderIds: ['u9'] } })
  assert.equal(sql, `SELECT * FROM \`task\` WHERE guildConfigId = ? AND (JSON_CONTAINS(assigneeIds, ?) OR JSON_CONTAINS(taggedMemberIds, ?)) ${HIDE} ORDER BY \`updatedAt\` DESC LIMIT 200`)
  assert.deepEqual(params, ['g1', '"u9"', '"u9"'])
})

test('search: at most ten holder ids are used, so a one-letter term cannot bloat the statement', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `u${i}`)
  const { sql } = base({ search: { text: 'a', holderIds: ids } })
  assert.equal((sql.match(/JSON_CONTAINS\(assigneeIds/g) || []).length, 10)
})

test('search: an empty or blank term adds no clause at all', () => {
  const plain = base({}).sql
  assert.equal(base({ search: '' }).sql, plain)
  assert.equal(base({ search: '   ' }).sql, plain)
  assert.equal(base({ search: { text: ' ', holderIds: [] } }).sql, plain)
  assert.ok(!/search/i.test(plain))
})

test('search: LIKE wildcards typed by the person are literal, not wildcards', () => {
  const { params } = base({ search: '50%_done\\' })
  assert.equal(params[1], '%50\\%\\_done\\\\%')
  assert.equal(params[2], '50\\%\\_done\\\\%')
})

test('holderId: narrows to tasks the person holds (an AND, for the Find panel and for non-leadership members)', () => {
  const { sql, params } = base({ holderId: 'u1' })
  assert.equal(sql, `SELECT * FROM \`task\` WHERE guildConfigId = ? AND (JSON_CONTAINS(assigneeIds, ?) OR JSON_CONTAINS(taggedMemberIds, ?)) ${HIDE} ORDER BY \`updatedAt\` DESC LIMIT 200`)
  assert.deepEqual(params, ['g1', '"u1"', '"u1"'])
})

test('holderId and projectId combine with a search, and the deleted-project clause still follows them', () => {
  const { sql, params } = base({ projectId: 'p1', holderId: 'u1', search: 'x' })
  assert.match(sql, /AND projectId = \? AND \(LOWER\(title\) LIKE \?.*\) AND \(JSON_CONTAINS\(assigneeIds, \?\) OR JSON_CONTAINS\(taggedMemberIds, \?\)\) AND NOT EXISTS/)
  assert.deepEqual(params, ['g1', 'p1', '%x%', 'x%', 'x', 'x%', 'g1', '%x%', '"u1"', '"u1"'])
})
