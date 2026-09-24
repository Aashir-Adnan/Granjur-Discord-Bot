// The Client role and the global support pair: created on demand (the live
// server will never be re-inited), found by stored id first, repaired
// presence-only, one overwrite edit at a time — never a whole-array replace.
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { updateGuildConfig } from '../db/index.js'
import {
  ROLE_CLIENT, ROLE_COLORS, CATEGORY_SUPPORT, CHANNEL_SUPPORT, CHANNEL_SUPPORT_VOICE,
  CATEGORY_RULES, CHANNEL_ANNOUNCEMENTS_ALL,
} from '../constants.js'
import { clientManual, MANUAL_TITLE } from './clientManual.js'

const F = PermissionFlagsBits
export const CLIENT_TEXT_ALLOW = [F.ViewChannel, F.SendMessages, F.ReadMessageHistory]
export const CLIENT_VOICE_ALLOW = [...CLIENT_TEXT_ALLOW, F.Connect, F.Speak, F.UseVAD, F.Stream]
/** The same sets as the `{ Flag: true }` objects `permissionOverwrites.edit` takes. */
export const CLIENT_TEXT_ALLOW_OBJ = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }
export const CLIENT_VOICE_ALLOW_OBJ = { ...CLIENT_TEXT_ALLOW_OBJ, Connect: true, Speak: true, UseVAD: true, Stream: true }

const REASON = 'Client support'

/** A role by stored id, else by name — the id wins so a hand-rename still resolves. */
function findRole(guild, id, name) {
  const cache = guild?.roles?.cache
  if (!cache) return null
  if (id && cache.get?.(id)) return cache.get(id)
  for (const role of cache.values()) if (role?.name === name) return role
  return null
}

export async function ensureClientRole(guild, cfg, { update = updateGuildConfig } = {}) {
  const existing = findRole(guild, cfg?.clientRoleId, ROLE_CLIENT)
  if (existing) {
    if (existing.id !== cfg?.clientRoleId) await update(guild.id, { clientRoleId: existing.id })
    return existing
  }
  const role = await guild.roles.create({ name: ROLE_CLIENT, color: ROLE_COLORS[ROLE_CLIENT] ?? 0x00b0f4, mentionable: false, reason: REASON })
  await update(guild.id, { clientRoleId: role.id })
  return role
}

/**
 * The overwrite set for a support channel or its category. `@everyone` is the
 * guild id and a ROLE; the wrong type makes Discord drop the entry silently.
 */
export function supportOverwrites(guild, { clientRoleId, verifiedRoleId, voice }) {
  const allow = voice ? CLIENT_VOICE_ALLOW : CLIENT_TEXT_ALLOW
  const out = [{ id: guild.id, type: OverwriteType.Role, deny: [F.ViewChannel] }]
  if (clientRoleId) out.push({ id: clientRoleId, type: OverwriteType.Role, allow })
  if (verifiedRoleId) out.push({ id: verifiedRoleId, type: OverwriteType.Role, allow })
  return out
}

/** A stored id, cache first then a fetch: a cold cache must not read as "gone". */
async function resolveChannel(guild, id) {
  if (!id) return null
  return guild.channels?.cache?.get?.(id) ?? await guild.channels?.fetch?.(id).catch(() => null) ?? null
}

/**
 * A channel by stored id only. A stored id that no longer resolves is
 * "missing", not "find it by name" — but a COLD CACHE is not "no longer
 * resolves": reading only the cache made a restart look like a deleted channel
 * and built a duplicate beside the real one, so the fetch is the second try.
 */
async function byStoredId(guild, id, type) {
  const ch = await resolveChannel(guild, id)
  return ch && ch.type === type ? ch : null
}

/** Name fallback ONLY when nothing is stored: a bare `support` channel under our category. */
function byName(guild, name, type, categoryId) {
  for (const ch of guild.channels?.cache?.values?.() ?? []) {
    if (ch?.name === name && ch.type === type && (!categoryId || ch.parentId === categoryId)) return ch
  }
  return null
}

function findCategory(guild) {
  for (const ch of guild.channels?.cache?.values?.() ?? []) {
    if (ch?.type === ChannelType.GuildCategory && ch.name === CATEGORY_SUPPORT) return ch
  }
  return null
}

const FLAG_NAMES = new Map(Object.entries(PermissionFlagsBits).map(([name, bit]) => [bit, name]))
const flagName = (bit) => FLAG_NAMES.get(bit)

/** Presence-only repair: add whichever required ids the channel lacks, one edit each. */
async function repairOverwrites(channel, required) {
  const cache = channel?.permissionOverwrites?.cache
  if (!cache?.has) return
  for (const o of required) {
    if (cache.has(o.id)) continue
    const allow = Object.fromEntries((o.allow ?? []).map((bit) => [flagName(bit), true]))
    const deny = Object.fromEntries((o.deny ?? []).map((bit) => [flagName(bit), false]))
    await channel.permissionOverwrites.edit(o.id, { ...allow, ...deny }, { type: o.type, reason: REASON })
  }
}

/**
 * The three places /init grants `@everyone: ViewChannel` — the onboarding
 * channel, the whole Rules category and #announcements-all. A client is an
 * ordinary guild member, so `@everyone` reaches them: without this the "you
 * see the support pair and nothing else" rule is not true. Denied on the
 * `Client` role, PRESENCE-ONLY (one id per edit, never a whole-array replace)
 * so a hand-made overwrite on any of them is left exactly as it is.
 *
 * A member still in Holding is unaffected — they do not hold `Client` yet, and
 * the onboarding channel is the one place they need.
 *
 * @returns {Promise<string[]>} the names of the channels newly denied.
 */
export async function denyClientOnPublicChannels(guild, cfg, clientRoleId) {
  if (!clientRoleId) return []
  const all = [...(guild.channels?.cache?.values?.() ?? [])]
  const rulesCategory = all.find((ch) => ch?.type === ChannelType.GuildCategory && ch.name === CATEGORY_RULES) ?? null

  const targets = new Map()
  const add = (ch) => { if (ch?.id && !targets.has(ch.id)) targets.set(ch.id, ch) }

  add(await resolveChannel(guild, cfg?.onboardingChannelId))
  if (rulesCategory) {
    add(rulesCategory)
    for (const ch of all) if (ch?.parentId === rulesCategory.id) add(ch)
  }
  for (const ch of all) if (ch?.type === ChannelType.GuildText && ch.name === CHANNEL_ANNOUNCEMENTS_ALL) add(ch)

  const denied = []
  for (const ch of targets.values()) {
    const cache = ch.permissionOverwrites?.cache
    if (!cache?.has || cache.has(clientRoleId)) continue
    try {
      await ch.permissionOverwrites.edit(clientRoleId, { ViewChannel: false }, { type: OverwriteType.Role, reason: REASON })
      denied.push(ch.name)
    } catch (e) {
      console.warn(`[clientAccess] denying Client on #${ch.name}:`, e?.message || e)
    }
  }
  return denied
}

async function ensureManualPinned(text, botUserId) {
  let pinned = null
  if (typeof text?.messages?.fetchPinned === 'function') {
    try {
      pinned = await text.messages.fetchPinned()
    } catch (e) {
      // "The pins could not be read" is NOT "there are no pins". Read as the
      // latter, every /init, /setup and first-client approval posted and
      // pinned the manual again.
      console.warn(`[clientAccess] pinned messages in #${text?.name} could not be read; leaving the manual alone:`, e?.message || e)
      return
    }
  }
  const have = pinned && [...pinned.values()].some((m) =>
    (!botUserId || m?.author?.id === botUserId) && (m?.embeds ?? []).some((e) => (e?.title ?? e?.data?.title) === MANUAL_TITLE))
  if (have) return
  const msg = await text.send({ embeds: [clientManual()] })
  await msg?.pin?.().catch(() => {})
}

/**
 * Idempotent. Creates whatever is missing, repairs whatever lacks an overwrite,
 * pins the manual if it is not pinned, and persists any id that changed.
 * @returns {Promise<{role: object, category: object, text: object, voice: object, denied: string[]}>}
 */
export async function ensureSupportChannels(guild, cfg, { update = updateGuildConfig, botUserId = null } = {}) {
  const role = await ensureClientRole(guild, cfg, { update })
  const ids = { clientRoleId: role.id, verifiedRoleId: cfg?.verifiedRoleId ?? null }

  let text = await byStoredId(guild, cfg?.supportChannelId, ChannelType.GuildText)
  let voice = await byStoredId(guild, cfg?.supportVoiceChannelId, ChannelType.GuildVoice)
  let category = (text?.parentId && guild.channels.cache.get(text.parentId))
    || (voice?.parentId && guild.channels.cache.get(voice.parentId))
    || findCategory(guild)
  if (!category) {
    category = await guild.channels.create({
      name: CATEGORY_SUPPORT, type: ChannelType.GuildCategory,
      permissionOverwrites: supportOverwrites(guild, { ...ids, voice: true }), reason: REASON,
    })
  } else {
    await repairOverwrites(category, supportOverwrites(guild, { ...ids, voice: true }))
  }

  if (!text && !cfg?.supportChannelId) text = byName(guild, CHANNEL_SUPPORT, ChannelType.GuildText, category.id)
  if (!text) {
    text = await guild.channels.create({
      name: CHANNEL_SUPPORT, type: ChannelType.GuildText, parent: category.id,
      topic: 'Talk to the team here. The pinned message explains the commands you can use.',
      permissionOverwrites: supportOverwrites(guild, { ...ids, voice: false }), reason: REASON,
    })
  } else {
    await repairOverwrites(text, supportOverwrites(guild, { ...ids, voice: false }))
  }

  if (!voice && !cfg?.supportVoiceChannelId) voice = byName(guild, CHANNEL_SUPPORT_VOICE, ChannelType.GuildVoice, category.id)
  if (!voice) {
    voice = await guild.channels.create({
      name: CHANNEL_SUPPORT_VOICE, type: ChannelType.GuildVoice, parent: category.id,
      permissionOverwrites: supportOverwrites(guild, { ...ids, voice: true }), reason: REASON,
    })
  } else {
    await repairOverwrites(voice, supportOverwrites(guild, { ...ids, voice: true }))
  }

  await ensureManualPinned(text, botUserId)

  const denied = await denyClientOnPublicChannels(guild, cfg, role.id)

  const changed = {}
  if (text.id !== cfg?.supportChannelId) changed.supportChannelId = text.id
  if (voice.id !== cfg?.supportVoiceChannelId) changed.supportVoiceChannelId = voice.id
  if (Object.keys(changed).length) await update(guild.id, changed)

  return { role, category, text, voice, denied }
}
