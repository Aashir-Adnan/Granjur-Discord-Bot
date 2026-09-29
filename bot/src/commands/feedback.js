// /feedback: post an improvement idea to #feedback from any channel (roadmap
// sub-project 3, 2026-09-29). People can also type in #feedback directly; this
// is the tidy-card path. The reply is private (the default deferral).

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import { getGuildConfig } from '../db/index.js'
import { findFeedbackChannel } from '../services/feedback.js'

export const FEEDBACK_TYPES = Object.freeze({ bug: 'Bug', idea: 'Idea', process: 'Process', other: 'Other' })
export const FEEDBACK_MAX = 1000
const COLORS = { bug: 0xed4245, idea: 0x57f287, process: 0x5865f2, other: 0x99aab5 }

export const data = new SlashCommandBuilder()
  .setName('feedback')
  .setDescription('Tell us what to improve — posted in #feedback')
  .addStringOption((o) =>
    o.setName('message').setDescription('What should we improve?').setRequired(true).setMaxLength(FEEDBACK_MAX),
  )
  .addStringOption((o) =>
    o
      .setName('type')
      .setDescription('What kind of feedback (default: Other)')
      .setRequired(false)
      .addChoices(...Object.entries(FEEDBACK_TYPES).map(([value, name]) => ({ name, value }))),
  )

export function buildFeedbackEmbed({ type, message, userId, displayName }) {
  const key = Object.hasOwn(FEEDBACK_TYPES, type) ? type : 'other'
  return new EmbedBuilder()
    .setTitle(`${FEEDBACK_TYPES[key]} feedback`)
    .setDescription(message)
    .setColor(COLORS[key])
    .addFields({ name: 'From', value: `<@${userId}> (${displayName})`, inline: false })
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction already deferred (ephemeral)
 * @param {{ getConfig?: (guildId: string) => Promise<object|null> }} [deps]
 */
export async function execute(interaction, { getConfig = getGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const message = (interaction.options.getString('message') ?? '').trim()
  if (!message) return interaction.editReply({ content: 'Write something to send — the message was empty.' })
  if (message.length > FEEDBACK_MAX) {
    return interaction.editReply({ content: `Feedback is limited to ${FEEDBACK_MAX} characters — yours is ${message.length}.` })
  }

  const cfg = await getConfig(guild.id)
  const channel = await findFeedbackChannel(guild, cfg)
  if (!channel) return interaction.editReply({ content: "There's no #feedback channel yet — ask an admin to run /setup." })

  const type = interaction.options.getString('type') ?? 'other'
  const displayName = interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username
  try {
    await channel.send({
      embeds: [buildFeedbackEmbed({ type, message, userId: interaction.user.id, displayName })],
      allowedMentions: { parse: [] },
    })
  } catch (e) {
    console.warn('[feedback] post failed:', e?.message ?? e)
    return interaction.editReply({ content: `I couldn't post in <#${channel.id}> — ask an admin to check my permissions there.` })
  }
  return interaction.editReply({ content: `Thanks — posted in <#${channel.id}>.` })
}
