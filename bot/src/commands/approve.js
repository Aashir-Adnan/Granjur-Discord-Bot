import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'
import * as flowStore from '../flows/store.js'
import { EPHEMERAL } from '../constants.js'

const ROLE_OPTIONS = [
  'Intern', 'Temp', 'Junior Dev', 'Senior Dev', 'Associate Engineer',
  'Quality Assurance', 'Project Manager', 'Server Manager', 'CEO',
  'Frontend', 'UI/UX', 'Designer', 'Server', 'Full-Stack', 'Database',
]

export const data = new SlashCommandBuilder()
  .setName('approve')
  .setDescription('Approve a user in holding and assign roles — step-by-step')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run `/init` first.' })

  const holding = await db.guildMember.findMany({
    where: { guildConfigId: cfg.id, status: 'holding' },
  })
  if (!holding.length) {
    return interaction.editReply({
      content: 'No users in holding. Users must run **/verify** and complete verification first.',
    })
  }

  flowStore.clear(interaction.user.id, guild.id, 'approve')
  flowStore.set(interaction.user.id, guild.id, 'approve', { step: 1 })

  const members = await guild.members.fetch()
  const options = holding.slice(0, 25).map((m) => {
    const mem = members.get(m.discordId)
    return {
      label: mem?.user?.username || m.discordId,
      value: m.discordId,
      description: m.email || 'No email',
    }
  })

  const embed = new EmbedBuilder()
    .setTitle('Approve user')
    .setDescription('**Step 1:** Select the user to approve.')
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 1 of 3' })

  const select = new StringSelectMenuBuilder()
    .setCustomId('approve_user')
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
  const state = flowStore.get(interaction.user.id, guild.id, 'approve')
  if (!state || state.step !== 1) return interaction.editReply({ content: 'Session expired. Run /approve again.', components: [], embeds: [] }).catch(() => {})

  const userId = interaction.values[0]
  flowStore.set(interaction.user.id, guild.id, 'approve', { ...state, step: 2, targetUserId: userId })

  const member = await guild.members.fetch(userId).catch(() => null)
  const embed = new EmbedBuilder()
    .setTitle('Approve user')
    .setDescription(`**Step 2:** Select roles to assign to **${member?.user?.tag || userId}**.`)
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 2 of 3' })

  const roleOptions = ROLE_OPTIONS.map((r) => ({
    label: r,
    value: r,
    description: `Assign ${r}`,
  }))
  const select = new StringSelectMenuBuilder()
    .setCustomId('approve_roles')
    .setPlaceholder('Select roles (multiple)')
    .setMinValues(1)
    .setMaxValues(roleOptions.length)
    .addOptions(roleOptions)

  await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] })
}

export async function handleRolesSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'approve')
  if (!state || state.step !== 2) return interaction.editReply({ content: 'Session expired.', components: [], embeds: [] }).catch(() => {})

  const roleNames = interaction.values || []
  flowStore.set(interaction.user.id, guild.id, 'approve', { ...state, step: 3, roleNames })

  const member = await guild.members.fetch(state.targetUserId).catch(() => null)
  const embed = new EmbedBuilder()
    .setTitle('Confirm approval')
    .setDescription(`Approve **${member?.user?.tag || state.targetUserId}** and assign: **${roleNames.join(', ')}**?`)
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 3 of 3' })

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('approve_confirm').setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('approve_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  )

  await interaction.editReply({ embeds: [embed], components: [row] })
}

export async function handleConfirm(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'approve')
  if (!state || state.step !== 3) return interaction.editReply({ content: 'Session expired.', components: [] }).catch(() => {})

  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    if (!cfg) return interaction.editReply({ content: 'Server not initialized.', components: [], embeds: [] }).catch(() => {})

    const member = await guild.members.fetch(state.targetUserId).catch(() => null)
    if (!member) return interaction.editReply({ content: 'Member not found.', components: [], embeds: [] }).catch(() => {})

    const dbMember = await db.guildMember.findUnique({
      where: { guildId_discordId: { guildId: guild.id, discordId: state.targetUserId } },
    })
    if (!dbMember || dbMember.status !== 'holding') {
      return interaction.editReply({ content: 'User is not in holding.', components: [], embeds: [] }).catch(() => {})
    }

    const assigned = []
    for (const name of state.roleNames || []) {
      const role = guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase())
      if (role) {
        try {
          await member.roles.add(role)
          assigned.push(role.name)
        } catch (_) {}
      }
    }
    if (cfg.holdingRoleId) await member.roles.remove(cfg.holdingRoleId).catch(() => {})
    if (cfg.verifiedRoleId) await member.roles.add(cfg.verifiedRoleId).catch(() => {})

    const existingRoleIds = ensureStringArray(dbMember.roleIds)
    await db.guildMember.update({
      where: { id: dbMember.id },
      data: { status: 'approved', roleIds: [...new Set([...existingRoleIds, ...assigned])] },
    })

    flowStore.clear(interaction.user.id, guild.id, 'approve')

    const embed = new EmbedBuilder()
      .setTitle('User approved')
      .setDescription(`**${member.user.tag}** — roles: ${assigned.join(', ') || 'none'}. They now have server access.`)
      .setColor(0x57f287)

    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Approval failed: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleCancel(interaction) {
  flowStore.clear(interaction.user.id, interaction.guild?.id, 'approve')
  await interaction.editReply({ content: 'Approval cancelled.', components: [], embeds: [] }).catch(() => {})
}
