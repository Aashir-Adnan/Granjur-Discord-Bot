import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { ensureClientRole, ensureSupportChannels, supportOverwrites } from './clientAccess.js'
import { MANUAL_TITLE } from './clientManual.js'

let nextId = 100
function fakeChannel(name, { type = ChannelType.GuildText, parentId = null, overwrites = [], pinned = [] } = {}) {
  const cache = new Map(overwrites.map((o) => [o.id, o]))
  const ch = {
    id: String(nextId++), name, type, parentId, sent: [], edits: [],
    permissionOverwrites: {
      cache,
      edit: async (id, allow, opts) => { ch.edits.push({ id, allow, opts }); cache.set(id, { id, type: opts?.type }); return ch },
    },
    messages: { fetchPinned: async () => new Map(pinned.map((m, i) => [String(i), m])) },
    send: async (payload) => { const msg = { ...payload, pinned: false, pin: async () => { msg.pinned = true } }; ch.sent.push(msg); return msg },
  }
  return ch
}

function fakeGuild({ roles = [], channels = [] } = {}) {
  const roleCache = new Map(roles.map((r) => [r.id, r]))
  const channelCache = new Map(channels.map((c) => [c.id, c]))
  const guild = {
    id: 'g1',
    roles: {
      cache: roleCache,
      create: async ({ name }) => { const r = { id: `r${nextId++}`, name }; roleCache.set(r.id, r); return r },
    },
    channels: {
      cache: channelCache,
      create: async ({ name, type, parent = null, permissionOverwrites = [] }) => {
        const c = fakeChannel(name, { type, parentId: parent, overwrites: permissionOverwrites })
        channelCache.set(c.id, c)
        return c
      },
    },
  }
  return guild
}

const cfg = (over = {}) => ({ id: 'cfg1', verifiedRoleId: 'r-verified', clientRoleId: null, supportChannelId: null, supportVoiceChannelId: null, ...over })
const recorder = () => { const calls = []; return { calls, update: async (guildId, data) => { calls.push(data) } } }

test('supportOverwrites: @everyone denied, Client and Verified allowed, every entry typed', () => {
  const ows = supportOverwrites({ id: 'g1' }, { clientRoleId: 'rc', verifiedRoleId: 'rv', voice: true })
  assert.deepEqual(ows.map((o) => [o.id, o.type]), [['g1', OverwriteType.Role], ['rc', OverwriteType.Role], ['rv', OverwriteType.Role]])
  assert.deepEqual(ows[0].deny, [PermissionFlagsBits.ViewChannel])
  assert.ok(ows[1].allow.includes(PermissionFlagsBits.Connect))
  const text = supportOverwrites({ id: 'g1' }, { clientRoleId: 'rc', verifiedRoleId: 'rv', voice: false })
  assert.ok(!text[1].allow.includes(PermissionFlagsBits.Connect))
})

test('ensureClientRole creates the role once and stores its id', async () => {
  const guild = fakeGuild()
  const { calls, update } = recorder()
  const role = await ensureClientRole(guild, cfg(), { update })
  assert.equal(role.name, 'Client')
  assert.deepEqual(calls, [{ clientRoleId: role.id }])
  // Second call with the id stored: nothing created, nothing written.
  const again = await ensureClientRole(guild, cfg({ clientRoleId: role.id }), { update })
  assert.equal(again.id, role.id)
  assert.equal(calls.length, 1)
})

test('ensureClientRole adopts a same-named role only when no id is stored, and records it', async () => {
  const existing = { id: 'r-old', name: 'Client' }
  const guild = fakeGuild({ roles: [existing] })
  const { calls, update } = recorder()
  const role = await ensureClientRole(guild, cfg(), { update })
  assert.equal(role.id, 'r-old')
  assert.deepEqual(calls, [{ clientRoleId: 'r-old' }])
})

test('ensureSupportChannels builds the category and both channels, persists ids, pins the manual', async () => {
  const guild = fakeGuild()
  const { calls, update } = recorder()
  const out = await ensureSupportChannels(guild, cfg(), { update, botUserId: 'bot' })
  assert.equal(out.category.name, '🛟 Support')
  assert.equal(out.text.name, 'support')
  assert.equal(out.voice.name, 'support-voice')
  assert.equal(out.voice.type, ChannelType.GuildVoice)
  const last = calls.at(-1)
  assert.equal(last.supportChannelId, out.text.id)
  assert.equal(last.supportVoiceChannelId, out.voice.id)
  assert.equal(out.text.sent.length, 1)
  assert.equal(out.text.sent[0].embeds[0].toJSON().title, MANUAL_TITLE)
  assert.equal(out.text.sent[0].pinned, true)
})

test('ensureSupportChannels reuses stored ids, repairs only a missing overwrite, and does not re-post a pinned manual', async () => {
  const text = fakeChannel('support', {
    overwrites: [{ id: 'g1', type: OverwriteType.Role }, { id: 'r-verified', type: OverwriteType.Role }],
    pinned: [{ author: { id: 'bot' }, embeds: [{ title: MANUAL_TITLE }] }],
  })
  const voice = fakeChannel('support-voice', { type: ChannelType.GuildVoice, overwrites: [{ id: 'g1' }, { id: 'r-client' }, { id: 'r-verified' }] })
  const guild = fakeGuild({ roles: [{ id: 'r-client', name: 'Client' }], channels: [text, voice] })
  const { calls, update } = recorder()
  await ensureSupportChannels(guild, cfg({ clientRoleId: 'r-client', supportChannelId: text.id, supportVoiceChannelId: voice.id }), { update, botUserId: 'bot' })
  assert.deepEqual(text.edits.map((e) => e.id), ['r-client'], 'only the Client allow was missing on the text channel')
  assert.equal(text.edits[0].opts.type, OverwriteType.Role)
  assert.equal(voice.edits.length, 0)
  assert.equal(text.sent.length, 0, 'manual already pinned')
  assert.equal(calls.length, 0, 'nothing to persist')
})

test('a stored channel id that no longer resolves is recreated, never matched by name', async () => {
  const stray = fakeChannel('support') // same name, not ours (no id stored for it)
  const guild = fakeGuild({ roles: [{ id: 'r-client', name: 'Client' }], channels: [stray] })
  const { calls, update } = recorder()
  const out = await ensureSupportChannels(guild, cfg({ clientRoleId: 'r-client', supportChannelId: 'gone', supportVoiceChannelId: null }), { update, botUserId: 'bot' })
  assert.notEqual(out.text.id, stray.id)
  assert.equal(calls.at(-1).supportChannelId, out.text.id)
})
