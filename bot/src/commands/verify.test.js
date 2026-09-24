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

// --- client entry ------------------------------------------------------------

function otpHarness({ email, me = null, invites = [] }) {
  const upserts = []
  const deleted = []
  const db = {
    verificationOtp: {
      findValidByCode: async () => ({ email }),
      delete: async () => {},
    },
    guildMember: {
      findUnique: async () => me,
      upsert: async (args) => { upserts.push(args); return { id: 'm1' } },
    },
    pendingInvite: {
      findByEmail: async (_cfgId, e) => invites.filter((r) => r.email === e),
      deleteByCode: async (_cfgId, code) => { deleted.push(code) },
    },
  }
  const ix = recordingInteraction({ guild: { id: 'g1', members: { fetch: async () => { throw new Error('offline') } } } })
  return { db, ix, upserts, deleted, getConfig: async () => ({ id: 'cfg1', holdingRoleId: null }), notify: async () => {} }
}

test('an invited client verifies with an outside email: the row is marked client and the invite is claimed', async () => {
  const h = otpHarness({ email: 'ali@acme.com', invites: [{ inviteCode: 'inv1', email: 'ali@acme.com', kind: 'client' }] })
  await handleOtpModal(h.ix, { code: '111111', db: h.db, getConfig: h.getConfig, notify: h.notify })
  assert.equal(h.upserts.length, 1)
  assert.equal(h.upserts[0].create.kind, 'client')
  assert.equal(h.upserts[0].update.kind, 'client')
  assert.equal(h.upserts[0].update.status, 'holding')
  assert.deepEqual(h.deleted, ['inv1'])
  assert.match(h.ix.replies.at(-1).content, /Verified/)
})

test('an allowed-domain email with a client invite still verifies as a client', async () => {
  const h = otpHarness({ email: 'sam@granjur.com', invites: [{ inviteCode: 'inv2', email: 'sam@granjur.com', kind: 'client' }] })
  await handleOtpModal(h.ix, { code: '111111', db: h.db, getConfig: h.getConfig, notify: h.notify })
  assert.equal(h.upserts[0].update.kind, 'client')
})

test('a staff email leaves kind alone', async () => {
  const h = otpHarness({ email: 'sam@granjur.com' })
  await handleOtpModal(h.ix, { code: '111111', db: h.db, getConfig: h.getConfig, notify: h.notify })
  assert.equal(h.upserts[0].update.kind, undefined)
  assert.equal(h.upserts[0].create.kind, undefined)
})
