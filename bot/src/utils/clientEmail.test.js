import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientEmailAccess } from './clientEmail.js'

const fake = ({ me = null, invites = [] } = {}) => ({
  guildMember: { findUnique: async () => me },
  pendingInvite: { findByEmail: async (_cfgId, email) => invites.filter((r) => r.email === email) },
})
const cfg = { id: 'cfg1' }

test('a member row marked client with this email is allowed, nothing to claim', async () => {
  const db = fake({ me: { kind: 'client', email: 'Ali@Acme.com' } })
  assert.deepEqual(await clientEmailAccess({ db, cfg, guildId: 'g1', discordId: 'u1', email: 'ali@acme.com' }), { allowed: true, claim: null })
})

test('an unclaimed client invite for the email is allowed and returned to be claimed', async () => {
  const invite = { inviteCode: 'abc', email: 'ali@acme.com', kind: 'client' }
  const db = fake({ invites: [invite] })
  assert.deepEqual(await clientEmailAccess({ db, cfg, guildId: 'g1', discordId: 'u1', email: 'ALI@acme.com' }), { allowed: true, claim: invite })
})

test('a staff invite, a different email, or no row at all is not allowed', async () => {
  assert.deepEqual(await clientEmailAccess({ db: fake({ invites: [{ email: 'ali@acme.com', kind: 'staff' }] }), cfg, guildId: 'g1', discordId: 'u1', email: 'ali@acme.com' }), { allowed: false, claim: null })
  assert.deepEqual(await clientEmailAccess({ db: fake({ me: { kind: 'client', email: 'other@acme.com' } }), cfg, guildId: 'g1', discordId: 'u1', email: 'ali@acme.com' }), { allowed: false, claim: null })
  assert.deepEqual(await clientEmailAccess({ db: fake(), cfg, guildId: 'g1', discordId: 'u1', email: '' }), { allowed: false, claim: null })
})
