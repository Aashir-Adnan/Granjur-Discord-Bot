import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aliasesFor } from './meetingRoster.js'

test('aliasesFor: displayName words + email local part, deduped, no blanks', () => {
  const a = aliasesFor({ displayName: 'Ali Raza', user: { username: 'alir' } }, 'ali.raza@granjur.com')
  assert.ok(a.includes('Ali'))
  assert.ok(a.includes('Ali Raza'))
  assert.ok(a.includes('ali.raza'))
  assert.ok(a.includes('alir'))
  assert.equal(new Set(a).size, a.length)
})

test('aliasesFor: single-char words dropped, no blanks, deduped', () => {
  const a = aliasesFor({ displayName: 'A B Charlie', user: { username: 'Charlie' } }, null)
  assert.ok(!a.includes('A'))
  assert.ok(!a.includes('B'))
  assert.ok(a.includes('Charlie'))
  assert.ok(a.every((x) => x && x.trim().length))
  assert.equal(new Set(a).size, a.length)
})

test('aliasesFor: falls back to globalName then username; tolerates empty member', () => {
  assert.deepEqual(aliasesFor({}, ''), [])
  const a = aliasesFor({ user: { globalName: 'Deep Thought', username: 'dt' } }, 'dt@x.com')
  assert.ok(a.includes('Deep Thought'))
  assert.ok(a.includes('Deep'))
  assert.ok(a.includes('dt'))
})
