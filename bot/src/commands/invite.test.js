import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleInviteModal, parseEmails, isValidEmail } from './invite.js'

// The slash-command path (`/invite emails:a@b.com`) used to hand handleInviteModal
// a `{ ...interaction }` spread with a stubbed `fields`. That drops every method,
// because discord.js keeps editReply/reply and the `guild` getter on the prototype
// rather than as own properties — so the handler blew up with
// "interaction.editReply is not a function" before it did anything.
//
// The fix is to pass the emails as a value instead of faking an interaction.
// These tests pin that: handleInviteModal must work on an interaction that has no
// `fields` at all, which is exactly what a slash command gives you.

const recordingInteraction = () => {
  const replies = []
  return {
    replies,
    guild: { id: 'g1', name: 'Granjur' },
    editReply: async (payload) => {
      replies.push(payload)
      return {}
    },
    // deliberately no `fields` — a ChatInputCommandInteraction has none
  }
}

test('handleInviteModal accepts emails directly, with no fields on the interaction', async () => {
  const ix = recordingInteraction()
  await handleInviteModal(ix, 'not-an-email, also-not-one')

  assert.equal(ix.replies.length, 1)
  assert.match(ix.replies[0].content, /No valid email/i)
  // the invalid addresses are surfaced rather than silently dropped
  assert.equal(ix.replies[0].embeds.length, 1)
})

test('a real interaction keeps working through the modal path', async () => {
  const ix = recordingInteraction()
  ix.fields = { getTextInputValue: (k) => (k === 'emails' ? 'still-bad' : '') }
  await handleInviteModal(ix)

  assert.equal(ix.replies.length, 1)
  assert.match(ix.replies[0].content, /No valid email/i)
})

test('parseEmails splits on commas, semicolons and newlines, and de-duplicates', () => {
  assert.deepEqual(parseEmails('a@x.com, b@x.com'), ['a@x.com', 'b@x.com'])
  assert.deepEqual(parseEmails('a@x.com;b@x.com'), ['a@x.com', 'b@x.com'])
  assert.deepEqual(parseEmails('a@x.com\nb@x.com'), ['a@x.com', 'b@x.com'])
  assert.deepEqual(parseEmails('  A@X.com \n a@x.com '), ['a@x.com'], 'case-folded and de-duplicated')
  assert.deepEqual(parseEmails(''), [])
  assert.deepEqual(parseEmails(null), [])
})

test('isValidEmail rejects the shapes people actually paste', () => {
  assert.equal(isValidEmail('someone@granjur.com'), true)
  assert.equal(isValidEmail('no-at-sign'), false)
  assert.equal(isValidEmail('missing@domain'), false)
  assert.equal(isValidEmail('two @spaces.com'), false)
  assert.equal(isValidEmail(''), false)
})

test('client:true writes kind=client on every pending invite and says so in the reply', async () => {
  const created = []
  const db = {
    pendingInvite: { create: async ({ data }) => { created.push(data); return data } },
  }
  const ix = recordingInteraction()
  ix.guild.channels = { fetch: async () => new Map([['c1', { id: 'c1', isTextBased: () => true, isThread: () => false }]]) }
  ix.guild.invites = { create: async () => ({ code: 'code1', url: 'https://discord.gg/code1' }) }
  ix.client = { users: { fetch: async () => null } }
  await handleInviteModal(ix, 'ali@acme.com', {
    client: true, db, getConfig: async () => ({ id: 'cfg1', onboardingChannelId: null }),
    sendEmail: async () => ({ ok: true }), findMemberByEmail: async () => null,
  })
  assert.equal(created.length, 1)
  assert.equal(created[0].kind, 'client')
  assert.match(JSON.stringify(ix.replies.at(-1)), /as clients/)
})
