// Migration 028 is plain SQL and there is no test database (the root .env is
// production), so this pins the statements' guards instead of running them:
// each step must be a no-op on a second run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sql = readFileSync(fileURLToPath(new URL('./migrations/028_task_scope_fixed_values.sql', import.meta.url)), 'utf8')
const statements = sql
  .replace(/--.*$/gm, '')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)
const FIXED = "('backend', 'frontend', 'qa', 'design')"
const MODULES = "IF(JSON_TYPE(modules) = 'ARRAY', modules, JSON_ARRAY())"

test('four UPDATEs on task and nothing else', () => {
  assert.equal(statements.length, 4)
  for (const s of statements) assert.match(s, /^UPDATE task SET /)
  assert.ok(!/\b(DELETE|DROP|ALTER|TRUNCATE|INSERT)\b/i.test(sql.replace(/--.*$/gm, '')))
})

// task.updatedAt is DATETIME(3) ... ON UPDATE CURRENT_TIMESTAMP(3) (schema.sql).
// Every UPDATE here must set it back to itself, or MySQL stamps it to deploy
// time on every touched row — old meeting tasks would jump to the top of
// every `ORDER BY updatedAt desc` (taskFinder, taskHub, /update-task,
// /clock-in) and the site's "Last updated" would lie.
test('every statement holds updatedAt unchanged', () => {
  for (const s of statements) assert.ok(s.includes('updatedAt = updatedAt'), s)
})

test('1: case variants of the four become lowercase, compared byte-for-byte', () => {
  const s = statements[0]
  assert.ok(s.includes('SET scope = LOWER(TRIM(scope))'), s)
  assert.ok(s.includes(`LOWER(TRIM(scope)) IN ${FIXED}`), s)
  assert.ok(s.includes('CAST(scope AS BINARY) <> CAST(LOWER(TRIM(scope)) AS BINARY)'), s)
})

test('2: a blank scope becomes NULL', () => {
  assert.ok(statements[1].includes('SET scope = NULL'))
  assert.ok(statements[1].includes("scope IS NOT NULL AND TRIM(scope) = ''"))
})

test('3: other text is appended to modules only when not already there', () => {
  const s = statements[2]
  assert.ok(s.includes(`SET modules = JSON_ARRAY_APPEND(${MODULES}, '$', TRIM(scope))`), s)
  assert.ok(s.includes(`LOWER(TRIM(scope)) NOT IN ${FIXED}`), s)
  assert.ok(s.includes(`NOT JSON_CONTAINS(${MODULES}, JSON_QUOTE(TRIM(scope)))`), s)
  assert.ok(s.includes("TRIM(scope) <> ''"), s)
})

test('4: then only non-fixed scopes are cleared (after step 3 copied them)', () => {
  const s = statements[3]
  assert.ok(s.includes('SET scope = NULL'), s)
  assert.ok(s.includes(`LOWER(TRIM(scope)) NOT IN ${FIXED}`), s)
})
