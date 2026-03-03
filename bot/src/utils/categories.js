import { ChannelType } from 'discord.js'

/**
 * Get an existing category by name or create it. Used for feature/bug ticket channels.
 * After /migrate, categories may have bold names; use orNames to find them.
 * @param {import('discord.js').Guild} guild
 * @param {string} name - Preferred category name (e.g. 'Features', 'Bugs')
 * @param {{ orNames?: string[] }} [opts] - Alternate names (e.g. bold format from migrate)
 * @returns {Promise<import('discord.js').CategoryChannel>}
 */
export async function getOrCreateCategory(guild, name, opts = {}) {
  const names = [name, ...(opts.orNames || [])]
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && names.includes(c.name)
  )
  if (existing) return existing
  return guild.channels.create({
    type: ChannelType.GuildCategory,
    name,
  })
}
