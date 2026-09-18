import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleOtpModal, nicknameFromEmail } from './verify.js'

// `/verify code:123456` is advertised as "skip the form", and it used to hand
// handleOtpModal a `{ ...interaction }` spread with a stubbed `fields`. A spread
// copies only own enumerable properties, so editReply (a prototype method) and
// guild (a prototype getter) were both missing: guild came back undefined, the
// handler took its "Invalid." branch, and that branch then died on the missing
// editReply. Every new member who typed their code inline hit it.
//
// Same defect as the one in invite.js. The fix is the same: pass the value.

const recordingInteraction = (over = {}) => {
  const replies = []
  return {
    replies,
    guild: { id: 'g1' },
    user: { id: 'u1' },
    editReply: async (payload) => {
      replies.push(payload)
      return {}
    },
    // deliberately no `fields` — a ChatInputCommandInteraction has none
    ...over,
  }
}

// The handler's own db seam. There is a real DATABASE_URL in the repo's .env
// pointing at production, so a test that reaches the default db queries the
// live server — which is exactly what this fake exists to prevent.
const fakeDb = (codesSeen) => ({
  verificationOtp: {
    findValidByCode: async (_guildId, _userId, code) => {
      codesSeen.push(code)
      return null // no matching code: the branch that needs no further I/O
    },
  },
})

test('handleOtpModal takes the code directly, with no fields on the interaction', async () => {
  const ix = recordingInteraction()
  const codesSeen = []
  await handleOtpModal(ix, { code: '654321', db: fakeDb(codesSeen) })

  assert.deepEqual(codesSeen, ['654321'], 'the code passed in is the code looked up')
  assert.equal(ix.replies.length, 1)
  assert.match(ix.replies[0].content, /Invalid or expired code/i)
  assert.notEqual(
    ix.replies[0].content,
    'Invalid.',
    'the bare "Invalid." branch means guild was lost, which is the original bug',
  )
})

test('the modal path still reads the code from fields', async () => {
  const ix = recordingInteraction({
    fields: { getTextInputValue: (k) => (k === 'code' ? '111111' : '') },
  })
  const codesSeen = []
  await handleOtpModal(ix, { db: fakeDb(codesSeen) })

  assert.deepEqual(codesSeen, ['111111'], 'the modal field is still read when no code is passed')
  assert.match(ix.replies[0].content, /Invalid or expired code/i)
})

test('a missing guild is still refused rather than throwing', async () => {
  const ix = recordingInteraction({ guild: null })
  await handleOtpModal(ix, { code: '123456', db: fakeDb([]) })
  assert.equal(ix.replies[0].content, 'Invalid.')
})

test('nicknameFromEmail builds a display name from the local part', () => {
  assert.equal(nicknameFromEmail('nauraiz.haider@granjur.com'), 'Nauraiz.haider')
  assert.equal(nicknameFromEmail('USAMA@granjur.com'), 'Usama')
  assert.equal(nicknameFromEmail('@granjur.com'), null)
  assert.equal(nicknameFromEmail(''), null)
  assert.equal(nicknameFromEmail(null), null)
})
