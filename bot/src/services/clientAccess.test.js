import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { ensureClientRole, ensureSupportChannels, supportOverwrites, everyoneCanView } from './clientAccess.js'
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

// `uncached` channels exist in the guild but not in `channels.cache` — a cold
// cache after a restart, where a stored id must still resolve through a fetch.
function fakeGuild({ roles = [], channels = [], uncached = [] } = {}) {
  const roleCache = new Map(roles.map((r) => [r.id, r]))
  const channelCache = new Map(channels.map((c) => [c.id, c]))
  const fetchable = new Map([...channels, ...uncached].map((c) => [c.id, c]))
  const guild = {
    id: 'g1',
    roles: {
      cache: roleCache,
      create: async ({ name }) => { const r = { id: `r${nextId++}`, name }; roleCache.set(r.id, r); return r },
    },
    channels: {
      cache: channelCache,
      fetch: async (id) => fetchable.get(id) ?? null,
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
  // Clients attach documents and screenshots: the six text bits, on both channels.
  for (const bit of [PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AddReactions]) {
    assert.ok(ows[1].allow.includes(bit))
  }
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

// The six-bit text allow: /setup upgrades an entry of ours that has the old
// three bits, and leaves one that already has all six alone.
const P = PermissionFlagsBits
const OLD_TEXT = P.ViewChannel | P.SendMessages | P.ReadMessageHistory
const SIX = OLD_TEXT | P.AttachFiles | P.EmbedLinks | P.AddReactions
const NEW_FLAGS = { AttachFiles: true, EmbedLinks: true, AddReactions: true }

function supportPairWith(textEntries, voiceEntries) {
  const everyone = { id: 'g1', type: OverwriteType.Role, allow: 0n, deny: P.ViewChannel }
  const text = fakeChannel('support', {
    overwrites: [everyone, ...textEntries],
    pinned: [{ author: { id: 'bot' }, embeds: [{ title: MANUAL_TITLE }] }],
  })
  const voice = fakeChannel('support-voice', { type: ChannelType.GuildVoice, overwrites: [everyone, ...voiceEntries] })
  const guild = fakeGuild({ roles: [{ id: 'r-client', name: 'Client' }], channels: [text, voice] })
  const conf = cfg({ clientRoleId: 'r-client', supportChannelId: text.id, supportVoiceChannelId: voice.id })
  return { text, voice, guild, conf }
}

test('/setup upgrades a three-bit Client entry on the support channel with just the missing bits, typed', async () => {
  const { text, guild, conf } = supportPairWith(
    [
      { id: 'r-client', type: OverwriteType.Role, allow: OLD_TEXT, deny: P.CreatePublicThreads },
      { id: 'r-verified', type: OverwriteType.Role, allow: SIX, deny: 0n },
    ],
    [
      { id: 'r-client', type: OverwriteType.Role, allow: SIX | P.Connect | P.Speak | P.UseVAD | P.Stream, deny: 0n },
      { id: 'r-verified', type: OverwriteType.Role, allow: SIX | P.Connect | P.Speak | P.UseVAD | P.Stream, deny: 0n },
    ]
  )
  const { update } = recorder()
  await ensureSupportChannels(guild, conf, { update, botUserId: 'bot' })
  // One merge edit (permissionOverwrites.edit changes only the flags it names),
  // so the deny and everything already allowed stay exactly as they were.
  assert.deepEqual(text.edits, [{ id: 'r-client', allow: NEW_FLAGS, opts: { type: OverwriteType.Role, reason: 'Client support' } }])
})

test('/setup leaves a six-bit Client entry alone, and never re-allows a bit the entry denies', async () => {
  const { text, voice, guild, conf } = supportPairWith(
    [
      { id: 'r-client', type: OverwriteType.Role, allow: SIX, deny: 0n },
      // Someone decided the Verified role may not react here: that stays.
      { id: 'r-verified', type: OverwriteType.Role, allow: SIX & ~P.AddReactions, deny: P.AddReactions },
    ],
    [
      { id: 'r-client', type: OverwriteType.Role, allow: SIX | P.Connect | P.Speak | P.UseVAD | P.Stream, deny: 0n },
      { id: 'r-verified', type: OverwriteType.Role, allow: SIX | P.Connect | P.Speak | P.UseVAD | P.Stream, deny: 0n },
    ]
  )
  const { update } = recorder()
  await ensureSupportChannels(guild, conf, { update, botUserId: 'bot' })
  assert.deepEqual(text.edits, [])
  assert.deepEqual(voice.edits, [])
})

test('a stored channel id that no longer resolves is recreated, never matched by name', async () => {
  const stray = fakeChannel('support') // same name, not ours (no id stored for it)
  const guild = fakeGuild({ roles: [{ id: 'r-client', name: 'Client' }], channels: [stray] })
  const { calls, update } = recorder()
  const out = await ensureSupportChannels(guild, cfg({ clientRoleId: 'r-client', supportChannelId: 'gone', supportVoiceChannelId: null }), { update, botUserId: 'bot' })
  assert.notEqual(out.text.id, stray.id)
  assert.equal(calls.at(-1).supportChannelId, out.text.id)
})

// --- the @everyone-visible channels -----------------------------------------
// /init grants `@everyone: ViewChannel` on the onboarding channel, the whole
// Rules category and #announcements-all. A client is in the guild, so those
// three are the only places the "sees the support pair and nothing else" rule
// leaks — closed here, presence-only, one id per edit.

// What actually makes a channel visible to a client is an `@everyone` allow —
// whoever created it. The fakes carry the real overwrite so the deny is derived
// from it, not from a list of names.
const everyoneAllow = () => ({ id: 'g1', type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] })
const everyoneDeny = () => ({ id: 'g1', type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] })

function publicGuild() {
  const rules = fakeChannel('📜 Rules', { type: ChannelType.GuildCategory, overwrites: [everyoneAllow()] })
  const rulesChild = fakeChannel('rules', { parentId: rules.id, overwrites: [everyoneAllow()] })
  const onboarding = fakeChannel('start-here', { overwrites: [everyoneAllow()] })
  const annCat = fakeChannel('📢 Announcements', { type: ChannelType.GuildCategory, overwrites: [everyoneDeny()] })
  const annAll = fakeChannel('announcements-all', { parentId: annCat.id, overwrites: [everyoneAllow()] })
  // Not made by /init at all — the daily report's channel — and a team channel.
  const timeReports = fakeChannel('time-reports', { overwrites: [everyoneAllow()] })
  const teamChat = fakeChannel('backend-chat', { overwrites: [everyoneDeny()] })
  const guild = fakeGuild({
    roles: [{ id: 'r-client', name: 'Client' }],
    channels: [rules, rulesChild, onboarding, annCat, annAll, timeReports, teamChat],
  })
  return { guild, rules, rulesChild, onboarding, annAll, annCat, timeReports, teamChat }
}

const publicCfg = (g) => cfg({ clientRoleId: 'r-client', onboardingChannelId: g.onboarding.id })

test('ensureSupportChannels denies Client on the onboarding channel, the Rules category and its children, and #announcements-all', async () => {
  const g = publicGuild()
  const { update } = recorder()
  const out = await ensureSupportChannels(g.guild, publicCfg(g), { update, botUserId: 'bot' })
  const denied = [g.onboarding, g.rules, g.rulesChild, g.annAll, g.timeReports]
  for (const ch of denied) {
    assert.deepEqual(ch.edits.map((e) => e.id), ['r-client'], `${ch.name} got exactly one Client deny`)
    assert.deepEqual(ch.edits[0].allow, { ViewChannel: false })
    assert.equal(ch.edits[0].opts.type, OverwriteType.Role, 'every overwrite carries an explicit type')
  }
  assert.equal(g.annCat.edits.length, 0, 'the Announcements category itself is not @everyone-visible')
  assert.equal(g.teamChat.edits.length, 0, 'a channel @everyone cannot see needs no deny')
  assert.equal(out.text.edits.filter((e) => e.allow?.ViewChannel === false).length, 0, 'the support pair is never denied to clients')
  assert.deepEqual(out.denied.sort(), ['announcements-all', 'rules', 'start-here', 'time-reports', '📜 Rules'].sort())
})

test('the public-channel deny is presence-only: a second run edits nothing', async () => {
  const g = publicGuild()
  const { update } = recorder()
  await ensureSupportChannels(g.guild, publicCfg(g), { update, botUserId: 'bot' })
  for (const ch of [g.onboarding, g.rules, g.rulesChild, g.annAll, g.timeReports]) ch.edits.length = 0
  const out = await ensureSupportChannels(g.guild, publicCfg(g), { update, botUserId: 'bot' })
  for (const ch of [g.onboarding, g.rules, g.rulesChild, g.annAll, g.timeReports]) {
    assert.equal(ch.edits.length, 0, `${ch.name} already carries an overwrite for the role`)
  }
  assert.deepEqual(out.denied, [])
})

test('a stored channel id missing from a cold cache is fetched, not duplicated', async () => {
  const text = fakeChannel('support', {
    overwrites: [{ id: 'g1' }, { id: 'r-client' }, { id: 'r-verified' }],
    pinned: [{ author: { id: 'bot' }, embeds: [{ title: MANUAL_TITLE }] }],
  })
  const voice = fakeChannel('support-voice', { type: ChannelType.GuildVoice, overwrites: [{ id: 'g1' }, { id: 'r-client' }, { id: 'r-verified' }] })
  const guild = fakeGuild({ roles: [{ id: 'r-client', name: 'Client' }], uncached: [text, voice] })
  const { calls, update } = recorder()
  const out = await ensureSupportChannels(
    guild,
    cfg({ clientRoleId: 'r-client', supportChannelId: text.id, supportVoiceChannelId: voice.id }),
    { update, botUserId: 'bot' },
  )
  assert.equal(out.text.id, text.id, 'the stored text channel was reused')
  assert.equal(out.voice.id, voice.id, 'the stored voice channel was reused')
  assert.equal(calls.length, 0, 'nothing to persist — no duplicate was made')
  assert.equal(text.sent.length, 0)
})

test('pinned messages that cannot be read do NOT count as "no manual pinned"', async () => {
  const text = fakeChannel('support', { overwrites: [{ id: 'g1' }, { id: 'r-client' }, { id: 'r-verified' }] })
  text.messages.fetchPinned = async () => { throw new Error('Missing Access') }
  const voice = fakeChannel('support-voice', { type: ChannelType.GuildVoice, overwrites: [{ id: 'g1' }, { id: 'r-client' }, { id: 'r-verified' }] })
  const guild = fakeGuild({ roles: [{ id: 'r-client', name: 'Client' }], channels: [text, voice] })
  const { update } = recorder()
  const warned = []
  const originalWarn = console.warn
  console.warn = (...a) => warned.push(a)
  try {
    await ensureSupportChannels(guild, cfg({ clientRoleId: 'r-client', supportChannelId: text.id, supportVoiceChannelId: voice.id }), { update, botUserId: 'bot' })
  } finally {
    console.warn = originalWarn
  }
  assert.equal(text.sent.length, 0, 'the manual is not re-posted on every call')
  assert.equal(warned.length, 1, 'the failure is logged instead')
})

test('everyoneCanView: the channel overwrite decides, else the guild @everyone role', () => {
  const g = { id: 'g1', roles: { everyone: { permissions: { has: (bit) => bit === PermissionFlagsBits.ViewChannel } } } }
  assert.equal(everyoneCanView(g, fakeChannel('a', { overwrites: [everyoneAllow()] })), true)
  assert.equal(everyoneCanView(g, fakeChannel('b', { overwrites: [everyoneDeny()] })), false)
  assert.equal(everyoneCanView(g, fakeChannel('c')), true, 'no overwrite: the role allows it')
  const noRole = { id: 'g1', roles: {} }
  assert.equal(everyoneCanView(noRole, fakeChannel('d')), false, 'no overwrite and no readable role: not visible')
  assert.equal(everyoneCanView(noRole, fakeChannel('e', { overwrites: [{ id: 'g1', type: OverwriteType.Role }] })), false, 'a neutral overwrite decides nothing')
})
