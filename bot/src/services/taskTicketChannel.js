// One private channel per task, plus a best-effort DM to the people on it.
//
// `/create-task` has always done this for a feature ticket: a channel under the
// Features category that only the assigner and the assignees can see, opened
// with an embed that @-mentions them. A meeting-generated task is the same kind
// of row, so it gets the same treatment — a single ping in a shared channel is
// easy to miss (and, for a `/record` meeting, lands in the voice channel's own
// chat), whereas a new channel plus a DM reaches the person.
import { ChannelType, PermissionFlagsBits, EmbedBuilder, OverwriteType } from 'discord.js'
import { getOrCreateCategory } from '../utils/categories.js'
import { CATEGORY_BOLD_NAMES } from '../constants.js'

const MEMBER_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
]

/**
 * Create the private channel for one task and post its opening embed.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} opts
 * @param {string} opts.taskId          - bot task row id; last 6 chars name the channel
 * @param {string} opts.title
 * @param {string} [opts.description]
 * @param {string[]} opts.memberIds     - everyone who may see the channel; deduped
 * @param {{name: string, value: string, inline?: boolean}[]} [opts.fields]
 * @param {string} [opts.categoryName]  - 'Features' (default) or 'Bugs'
 * @param {string} [opts.namePrefix]    - 'feature' (default) or 'bug'
 * @param {string} [opts.closeHint]     - appended as a "Close" field when given
 * @returns {Promise<import('discord.js').TextChannel>} the created channel
 */
export async function createTaskTicketChannel(guild, opts) {
  const {
    taskId,
    title,
    description,
    memberIds = [],
    fields = [],
    categoryName = 'Features',
    namePrefix = 'feature',
    closeHint = null,
  } = opts

  const members = [...new Set(memberIds.filter(Boolean))]
  const category = await getOrCreateCategory(guild, categoryName, {
    orNames: [CATEGORY_BOLD_NAMES[categoryName]].filter(Boolean),
  })

  const channel = await guild.channels.create({
    name: `${namePrefix}-${String(taskId).slice(-6)}`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `${categoryName === 'Bugs' ? 'Bug' : 'Feature'}: ${String(title || '').slice(0, 100)}`,
    permissionOverwrites: [
      // The guild id is a ROLE (@everyone); every other id here is a USER. Passing
      // type 0 for a user makes Discord discard the overwrite without an error, and
      // the ticket channel ends up visible to nobody — which is what happened to
      // feature-f56be0 on 2026-09-04.
      { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      ...members.map((id) => ({ id, type: OverwriteType.Member, allow: MEMBER_PERMS })),
    ],
  })

  const embed = new EmbedBuilder()
    .setTitle(`Feature: ${String(title || 'Task').slice(0, 200)}`)
    .setDescription((description || 'No description.').slice(0, 1000))
    .addFields(...fields.slice(0, 20), { name: 'Task ID', value: String(taskId), inline: false })
    .setColor(0x5865f2)
  if (closeHint) embed.addFields({ name: 'Close', value: closeHint, inline: false })

  const mentions = members.map((id) => `<@${id}>`).join(' ')
  await channel.send({ content: mentions || null, embeds: [embed] })
  return channel
}

/**
 * DM each user a one-line pointer at their new task. Best effort: a user with
 * DMs closed is skipped silently, because the channel above already reached them.
 * @returns {Promise<number>} how many DMs were delivered
 */
export async function dmTaskAssignees(client, userIds, { title, channelId, note = '' } = {}) {
  const ids = [...new Set((userIds || []).filter(Boolean))]
  let delivered = 0
  for (const id of ids) {
    try {
      const user = await client.users.fetch(id)
      const where = channelId ? ` — discuss it in <#${channelId}>` : ''
      await user.send(
        `You've been assigned **${title}**${where}.${note ? `\n${note}` : ''}`,
      )
      delivered += 1
    } catch (e) {
      // Closed DMs are the common case and are not an error worth a stack trace.
      console.warn(`[taskTicket] DM to ${id} failed:`, e?.message || e)
    }
  }
  return delivered
}
