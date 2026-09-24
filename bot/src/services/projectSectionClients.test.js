import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType } from 'discord.js'
import { observeProjectSection, planProjectSection, applyProjectSection, CLIENT_SECTION_KEYS, storedChannels } from './projectSection.js'

const project = { id: 'p1', name: 'Framework', docsSlug: 'framework', discordCategoryId: 'cat', discordRoleId: 'role', discordChannels: { support: 'sup', supportVoice: 'supv' } }

function channel(id, name, { type = ChannelType.GuildText, parentId = 'cat', overwrites = [] } = {}) {
  const cache = new Map(overwrites.map((o) => [o.id, o]))
  const ch = {
    id, name, type, parentId, topic: null, edits: [], deletes: [],
    permissionOverwrites: {
      cache,
      edit: async (mid, allow, opts) => { ch.edits.push({ mid, allow, opts }); cache.set(mid, { id: mid, type: opts?.type }) },
      delete: async (mid) => { ch.deletes.push(mid); cache.delete(mid) },
    },
    edit: async () => ch,
  }
  return ch
}
const role = (id) => ({ id, type: OverwriteType.Role })
const member = (id) => ({ id, type: OverwriteType.Member })

function guildWith(channels) {
  const cache = new Map(channels.map((c) => [c.id, c]))
  return {
    id: 'g1',
    roles: { cache: new Map([['role', { id: 'role', name: 'Framework', members: new Map() }]]) },
    channels: { cache, create: async ({ name, type, parent }) => { const c = channel(`new-${name}`, name, { type, parentId: parent }); cache.set(c.id, c); return c } },
    members: { fetch: async () => new Map() },
  }
}

async function quiet(fn) {
  const real = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = real }
}

test('CLIENT_SECTION_KEYS and storedChannels are exported for the commands', () => {
  assert.deepEqual(CLIENT_SECTION_KEYS, ['support', 'supportVoice'])
  assert.deepEqual(storedChannels({ discordChannels: '{"support":"s"}' }), { support: 's' })
})

test('observe: a client without an overwrite is missing, a member overwrite that is not a client is stale', () => {
  const sup = channel('sup', 'framework-support', { overwrites: [role('g1'), role('role'), member('u-client-a'), member('u-gone')] })
  const supv = channel('supv', 'framework-support-voice', { type: ChannelType.GuildVoice, overwrites: [role('g1'), role('role')] })
  const cat = channel('cat', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, parentId: null })
  const observed = observeProjectSection(guildWith([cat, sup, supv]), project, [], { rolesFetched: true, clientIds: ['u-client-a', 'u-client-b'] })
  assert.deepEqual(observed.clientAccess.support, { missing: ['u-client-b'], stale: ['u-gone'] })
  assert.deepEqual(observed.clientAccess.supportVoice, { missing: ['u-client-a', 'u-client-b'], stale: [] })
})

test('plan: grants and revokes per channel; revokeClients:false suppresses revokes', () => {
  const observed = {
    roleId: 'role', roleCandidate: null, rolesFetched: true, categoryId: 'cat', categoryName: '📂 FRAMEWORK', categoryChannelCount: 12,
    channels: { support: { id: 'sup', name: 'framework-support', parentId: 'cat', overwriteIds: ['g1', 'role'] } },
    tasks: [], takenNames: new Set(),
    clientAccess: { support: { missing: ['u1'], stale: ['u9'] } },
    clientIds: ['u1'],
  }
  const plan = planProjectSection(project, observed, {})
  assert.deepEqual(plan.clients.grant, [{ key: 'support', channelId: 'sup', memberId: 'u1' }])
  assert.deepEqual(plan.clients.revoke, [{ key: 'support', channelId: 'sup', memberId: 'u9' }])
  assert.deepEqual(plan.clients.wanted, ['u1'])
  const grantOnly = planProjectSection(project, observed, { revokeClients: false })
  assert.deepEqual(grantOnly.clients.revoke, [])
})

test('apply: one typed member edit per grant, one delete per revoke, and a freshly created support channel gets every wanted client', async () => {
  const sup = channel('sup', 'framework-support', { overwrites: [role('g1'), role('role'), member('u9')] })
  const cat = channel('cat', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, parentId: null })
  const guild = guildWith([cat, sup])
  const plan = {
    role: { action: 'reuse', id: 'role', name: 'Framework', gateRoleId: 'role' },
    category: { action: 'reuse', id: 'cat', name: '📂 FRAMEWORK' },
    channels: [
      { key: 'support', action: 'reuse', id: 'sup', name: 'framework-support', type: 'text' },
      { key: 'supportVoice', action: 'create', name: 'framework-support-voice', type: 'voice' },
    ],
    tasks: [], voice: { category: [], channels: [] }, warnings: [],
    clients: { wanted: ['u1'], grant: [{ key: 'support', channelId: 'sup', memberId: 'u1' }], revoke: [{ key: 'support', channelId: 'sup', memberId: 'u9' }] },
  }
  const result = await quiet(() => applyProjectSection(guild, project, plan, { db: { project: { update: async () => {} } } }))
  assert.deepEqual(sup.edits.map((e) => [e.mid, e.opts.type]), [['u1', OverwriteType.Member]])
  assert.ok(sup.edits[0].allow.ViewChannel === true && sup.edits[0].allow.Connect === undefined, 'text allow on a text channel')
  assert.deepEqual(sup.deletes, ['u9'])
  const created = guild.channels.cache.get('new-framework-support-voice')
  assert.deepEqual(created.edits.map((e) => e.mid), ['u1'], 'a new support channel is granted to every wanted client')
  assert.equal(created.edits[0].allow.Connect, true)
  assert.deepEqual(result.clientGranted.sort(), ['framework-support', 'framework-support-voice'].sort())
  assert.deepEqual(result.clientRevoked, ['framework-support'])
})

test('observe: omitting clientIds fails closed — no clientAccess, and the plan grants and revokes nothing', () => {
  const sup = channel('sup', 'framework-support', { overwrites: [role('g1'), role('role'), member('u9')] })
  const cat = channel('cat', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, parentId: null })
  const observed = observeProjectSection(guildWith([cat, sup]), project, [], { rolesFetched: true })
  assert.deepEqual(observed.clientAccess, {})
  assert.equal(observed.clientIds, null)
  const plan = planProjectSection(project, observed, {})
  assert.deepEqual(plan.clients, { wanted: [], grant: [], revoke: [] })
})
