import { PermissionFlagsBits } from 'discord.js'

/**
 * Make a ticket channel read-only: every overwrite that allows sending loses
 * it. Whoever could see the channel still can. One edit per overwrite, each
 * on its own try/catch, so one refused edit does not leave the rest writable.
 * @returns {Promise<{edited: number, failed: number}>}
 */
export async function lockTicketChannel(channel) {
  const out = { edited: 0, failed: 0 }
  const cache = channel?.permissionOverwrites?.cache
  if (!cache?.entries) return out
  for (const [id, overwrite] of cache) {
    if (!overwrite?.allow?.has?.(PermissionFlagsBits.SendMessages)) continue
    try {
      await channel.permissionOverwrites.edit(id, { SendMessages: false })
      out.edited += 1
    } catch (e) {
      out.failed += 1
      console.warn(`[channels] lock ${channel.id} overwrite ${id}:`, e?.message || e)
    }
  }
  return out
}

/**
 * The reverse of `lockTicketChannel`, for a task reopened out of Done: every
 * overwrite that can view the channel and was denied sending may send again.
 * The @everyone overwrite denies ViewChannel, so it is never re-opened.
 * @returns {Promise<{edited: number, failed: number}>}
 */
export async function unlockTicketChannel(channel) {
  const out = { edited: 0, failed: 0 }
  const cache = channel?.permissionOverwrites?.cache
  if (!cache?.entries) return out
  for (const [id, overwrite] of cache) {
    if (!overwrite?.deny?.has?.(PermissionFlagsBits.SendMessages)) continue
    if (!overwrite?.allow?.has?.(PermissionFlagsBits.ViewChannel)) continue
    try {
      await channel.permissionOverwrites.edit(id, { SendMessages: true })
      out.edited += 1
    } catch (e) {
      out.failed += 1
      console.warn(`[channels] unlock ${channel.id} overwrite ${id}:`, e?.message || e)
    }
  }
  return out
}
