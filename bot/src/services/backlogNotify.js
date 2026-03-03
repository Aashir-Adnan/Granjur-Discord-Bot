import { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'

/**
 * Notify the admin channel when a user enters holding (backlog update).
 * Tags server owner and roles from dashboardRoleIds (CEO, Server Manager, etc.).
 * No-op if adminChannelId is not set.
 */
export async function notifyBacklogUpdate(guild, member, email) {
  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg?.adminChannelId) return

  const channel = await guild.channels.fetch(cfg.adminChannelId).catch(() => null)
  if (!channel?.isTextBased()) return

  const mentionParts = []
  if (guild.ownerId) {
    mentionParts.push(`<@${guild.ownerId}>`)
  }
  const dashboardIds = ensureStringArray(cfg.dashboardRoleIds)
  for (const roleId of dashboardIds) {
    mentionParts.push(`<@&${roleId}>`)
  }
  const mentions = mentionParts.length ? mentionParts.join(' ') + ' ' : ''

  const text = `${mentions}**Backlog update:** ${member.user.tag} (${email || 'no email'}) entered **Holding**. Use **/backlog** to review and assign roles.`
  await channel.send({ content: text }).catch(() => {})
}
