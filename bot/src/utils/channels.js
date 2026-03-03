import { PermissionFlagsBits } from 'discord.js'

const DELETION_DELAY_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Lock a ticket channel so no one can send messages, then schedule deletion.
 * Call this after sending the final "closed/resolved" message.
 * @param {import('discord.js').TextChannel} channel
 * @param {number} [delayMs] - Delay before deletion (default 5 minutes)
 */
export async function lockChannelAndScheduleDeletion(channel, delayMs = DELETION_DELAY_MS) {
  try {
    for (const [id, overwrite] of channel.permissionOverwrites.cache) {
      if (overwrite.allow.has(PermissionFlagsBits.SendMessages)) {
        await channel.permissionOverwrites.edit(id, { SendMessages: false }).catch(() => {})
      }
    }
  } catch (e) {
    console.error('[channels] lockChannelAndScheduleDeletion lock error:', e?.message)
  }
  setTimeout(() => {
    channel.delete().catch((e) => console.error('[channels] delete error:', e?.message))
  }, delayMs)
}
