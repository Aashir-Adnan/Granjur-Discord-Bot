// #feedback: where staff tell us what to improve (roadmap sub-project 3,
// 2026-09-29). Found by the id stored on guildconfig, falling back to a
// #feedback inside the Feedback category. Verified only — clients never hold
// Verified, so they never see it.

import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { CATEGORY_FEEDBACK, CHANNEL_FEEDBACK } from '../constants.js'
import { FEEDBACK_TOPIC } from './globalLayout.js'
import { getChannelPinnedMessage } from '../config/commands.js'
import { updateGuildConfig } from '../db/index.js'

const REASON = 'Granjur feedback channel'

export function feedbackOverwrites(guild, verifiedRoleId) {
  return [
    { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: verifiedRoleId,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages],
    },
  ]
}

const cached = (guild) => [...(guild.channels?.cache?.values?.() ?? [])]

/** A stored id, cache first then a fetch: a cold cache must not read as "gone". */
async function resolveChannel(guild, id) {
  if (!id) return null
  return guild.channels?.cache?.get?.(id) ?? (await guild.channels?.fetch?.(id).catch(() => null)) ?? null
}

function feedbackCategory(guild) {
  return cached(guild).find((c) => c?.type === ChannelType.GuildCategory && c.name === CATEGORY_FEEDBACK) ?? null
}

export async function findFeedbackChannel(guild, cfg) {
  const stored = await resolveChannel(guild, cfg?.feedbackChannelId)
  if (stored && stored.type === ChannelType.GuildText) return stored
  const category = feedbackCategory(guild)
  if (!category) return null
  return cached(guild).find((c) => c?.type === ChannelType.GuildText && c.name === CHANNEL_FEEDBACK && c.parentId === category.id) ?? null
}

/** Idempotent: creates the Feedback category and #feedback only when missing, and stores the id. */
export async function ensureFeedbackChannel(guild, cfg, { update = updateGuildConfig } = {}) {
  if (!cfg?.verifiedRoleId) throw new Error('No Verified role is configured — run /init first.')
  let channel = await findFeedbackChannel(guild, cfg)
  let created = false
  if (!channel) {
    const permissionOverwrites = feedbackOverwrites(guild, cfg.verifiedRoleId)
    const category = feedbackCategory(guild) ?? await guild.channels.create({
      name: CATEGORY_FEEDBACK, type: ChannelType.GuildCategory, permissionOverwrites, reason: REASON,
    })
    channel = await guild.channels.create({
      name: CHANNEL_FEEDBACK, type: ChannelType.GuildText, parent: category.id, topic: FEEDBACK_TOPIC, permissionOverwrites, reason: REASON,
    })
    created = true
    const pinned = getChannelPinnedMessage(CHANNEL_FEEDBACK)
    if (pinned) {
      try {
        const sent = await channel.send({ content: pinned })
        await sent.pin().catch(() => {})
      } catch (e) {
        console.warn('[feedback] could not pin the default message:', e?.message ?? e)
      }
    }
  }
  if (cfg.feedbackChannelId !== channel.id) await update(guild.id, { feedbackChannelId: channel.id })
  return { channel, created }
}
