import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'
import { getCommits } from '../services/github.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('evaluate')
  .setDescription('(Senior roles) View bugs, features, and commits for a user — select user')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  const member = await guild.members.fetch(interaction.user.id).catch(() => null)
  const seniorIds = ensureStringArray(cfg.seniorRoleIds)
  const isSenior =
    (seniorIds.length && member?.roles.cache.some((r) => seniorIds.includes(r.id))) ||
    member?.permissions.has('Administrator')
  if (!isSenior) {
    return interaction.editReply({ content: 'Only Senior Dev, CEO, or Server Manager can use this command.' })
  }

  const members = await guild.members.fetch()
  const options = members
    .filter((m) => !m.user.bot)
    .slice(0, 25)
    .map((m) => ({
      label: m.user.username.slice(0, 25),
      value: m.id,
      description: m.user.tag.slice(0, 50),
    }))

  const embed = new EmbedBuilder()
    .setTitle('Evaluate user')
    .setDescription('**Step 1:** Select the user to evaluate.')
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 1 of 2' })

  const select = new StringSelectMenuBuilder()
    .setCustomId('evaluate_user')
    .setPlaceholder('Select user')
    .addOptions(options)

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  })
}

export async function handleUserSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const userId = interaction.values?.[0]
  if (!userId) return

  const cfg = await getOrCreateGuildConfig(guild.id)
  const target = await guild.members.fetch(userId).catch(() => null)
  const bugsRaw = await db.bugTicket.findMany({
    where: { guildConfigId: cfg.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const bugs = bugsRaw.filter((b) => b.createdBy === userId || ensureStringArray(b.taggedMemberIds).includes(userId)).slice(0, 15)
  const features = await db.feature.findMany({
    where: { guildConfigId: cfg.id, createdBy: userId },
    orderBy: { createdAt: 'desc' },
    take: 15,
  })

  const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
  let commits = []
  const dbMember = await db.guildMember.findUnique({
    where: { guildId_discordId: { guildId: guild.id, discordId: userId } },
  })
  const authorFilter = dbMember?.email || undefined
  for (const r of repos.slice(0, 5)) {
    try {
      const c = await getCommits(r.url, authorFilter)
      commits = commits.concat(c || [])
    } catch (_) {}
  }
  commits = commits.slice(0, 20)

  const embed = new EmbedBuilder()
    .setTitle(`Evaluation: ${target?.user?.tag || userId}`)
    .setColor(0x5865f2)
    .addFields(
      { name: 'Bugs (involved)', value: String(bugs.length), inline: true },
      { name: 'Features (created)', value: String(features.length), inline: true },
      { name: 'Commits (from GitHub)', value: String(commits.length), inline: true },
      {
        name: 'Recent bugs',
        value: bugs.slice(0, 5).map((b) => `• [${b.status}] ${(b.title || b.id).slice(0, 50)}`).join('\n') || '—',
        inline: false,
      },
      {
        name: 'Recent features',
        value: features.slice(0, 5).map((f) => `• [${f.status}] ${f.title.slice(0, 50)}`).join('\n') || '—',
        inline: false,
      },
      {
        name: 'Recent commits',
        value: commits.slice(0, 5).map((c) => `• ${(c.message || c.sha || '').slice(0, 50)}`).join('\n') || '—',
        inline: false,
      }
    )
    .setFooter({ text: 'Step 2 of 2' })

  await interaction.editReply({ embeds: [embed], components: [] })
}
