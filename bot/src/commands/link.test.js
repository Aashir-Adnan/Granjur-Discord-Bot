import { test } from 'node:test'
import assert from 'node:assert/strict'
import { data, execute, generateCode, CODE_ALPHABET } from './link.js'

test('the command is /link with no options', () => {
  const json = data.toJSON()
  assert.equal(json.name, 'link')
  assert.equal((json.options || []).length, 0)
})

test('codes are 6 characters from the unambiguous alphabet', () => {
  assert.equal(CODE_ALPHABET, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789')
  for (let i = 0; i < 200; i++) {
    const c = generateCode()
    assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
  }
  let n = 0
  assert.equal(generateCode(() => n++ % 32), 'ABCDEF')
})

function interaction() {
  const replies = []
  return {
    replies,
    guild: { id: 'G1' },
    user: { id: 'u1' },
    editReply: async (p) => { replies.push(typeof p === 'string' ? p : p.content) },
  }
}

test('issues a code for the caller and replies privately with it', async () => {
  const calls = []
  const db = { discordLinkCode: { issue: async (a) => { calls.push(a); return { id: 'x', code: a.code } } } }
  const i = interaction()
  await execute(i, { db, getConfig: async () => ({ id: 'cfg1' }), makeCode: () => 'ABC234' })
  assert.deepEqual(calls, [{ guildConfigId: 'cfg1', discordId: 'u1', code: 'ABC234' }])
  assert.match(i.replies[0], /\*\*ABC234\*\*/)
  assert.match(i.replies[0], /10 minutes/)
  assert.match(i.replies[0], /UBS-Doc/)
})

test('a code collision is retried with a fresh code', async () => {
  let attempts = 0
  const db = { discordLinkCode: { issue: async (a) => {
    attempts++
    if (attempts < 3) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e }
    return { id: 'x', code: a.code }
  } } }
  const codes = ['AAAAAA', 'BBBBBB', 'CCCCCC']
  const i = interaction()
  await execute(i, { db, getConfig: async () => ({ id: 'cfg1' }), makeCode: () => codes.shift() })
  assert.equal(attempts, 3)
  assert.match(i.replies[0], /\*\*CCCCCC\*\*/)
})

test('after five collisions it gives up with a sentence', async () => {
  const db = { discordLinkCode: { issue: async () => { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e } } }
  const i = interaction()
  await execute(i, { db, getConfig: async () => ({ id: 'cfg1' }), makeCode: () => 'AAAAAA' })
  assert.equal(i.replies[0], 'Could not make a code right now. Try /link again in a moment.')
})

test('outside a server or before /init it says so', async () => {
  const i = { ...interaction(), guild: null }
  await execute(i, { db: {}, getConfig: async () => null, makeCode: () => 'AAAAAA' })
  assert.equal(i.replies[0], 'Use this in a server.')
  const j = interaction()
  await execute(j, { db: {}, getConfig: async () => null, makeCode: () => 'AAAAAA' })
  assert.equal(j.replies[0], 'Server not initialized. Run **/init** first.')
})
