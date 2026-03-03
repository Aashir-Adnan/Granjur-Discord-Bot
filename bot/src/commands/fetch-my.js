import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('fetch-my')
  .setDescription('Get your bugs, features, and meetings — select what to fetch')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)

  const embed = new EmbedBuilder()
    .setTitle('Fetch my items')
    .setDescription('**Step 1:** Select what you want to see.')
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 1 of 2' })

  const select = new StringSelectMenuBuilder()
    .setCustomId('fetch_my_select')
    .setPlaceholder('Select category')
    .addOptions(
      { label: 'Bugs / tickets', value: 'bugs', description: 'Tickets you created or are tagged in' },
      { label: 'Features', value: 'features', description: 'Features you created' },
      { label: 'Meeting schedules', value: 'meetings', description: 'Your scheduled meetings' },
      { label: 'All', value: 'all', description: 'Bugs, features, and meetings' }
    )

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  })
}

export async function handleFetchSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const value = interaction.values?.[0]
  if (!value) return

  const cfg = await getOrCreateGuildConfig(guild.id)
  const userId = interaction.user.id
  const [bugsRaw, features, schedulesRaw] = await Promise.all([
    value === 'bugs' || value === 'all'
      ? db.bugTicket.findMany({
          where: { guildConfigId: cfg.id },
          orderBy: { createdAt: 'desc' },
          take: 50,
        })
      : [],
    value === 'features' || value === 'all'
      ? db.feature.findMany({
          where: { guildConfigId: cfg.id, createdBy: userId },
          orderBy: { createdAt: 'desc' },
          take: 15,
        })
      : [],
    value === 'meetings' || value === 'all'
      ? db.scheduledMeeting.findMany({
          where: { guildConfigId: cfg.id },
          orderBy: { scheduledAt: 'asc' },
          take: 50,
        })
      : [],
  ])
  const bugs = (bugsRaw || []).filter((b) => b.createdBy === userId || ensureStringArray(b.taggedMemberIds).includes(userId)).slice(0, 15)
  const schedules = (schedulesRaw || []).filter((s) => s.createdBy === userId || ensureStringArray(s.memberIds).includes(userId)).slice(0, 15)

  const fields = []
  if (bugs.length) {
    fields.push({
      name: 'Your bugs / tickets',
      value: bugs.map((b) => `• [${b.status}] ${(b.title || b.id).slice(0, 50)} ${b.discordChannelId ? `<#${b.discordChannelId}>` : ''}`).join('\n').slice(0, 1024),
      inline: false,
    })
  }
  if (features.length) {
    fields.push({
      name: 'Your features',
      value: features.map((f) => `• [${f.status}] ${f.title.slice(0, 60)}`).join('\n').slice(0, 1024),
      inline: false,
    })
  }
  if (schedules.length) {
    fields.push({
      name: 'Your meeting schedules',
      value: schedules.map((s) => `• ${s.scheduledAt.toISOString().slice(0, 16)} — ${s.topic.slice(0, 50)}`).join('\n').slice(0, 1024),
      inline: false,
    })
  }

  const embed = new EmbedBuilder()
    .setTitle('Your items')
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 2 of 2' })
  if (fields.length) embed.addFields(fields)
  else embed.setDescription('No items in this category.')

  await interaction.editReply({ embeds: [embed], components: [] })
}
