import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as flowStore from '../flows/store.js'
import { MANAGED_ROLES } from '../utils/roleSync.js'
import { EPHEMERAL, ROLE_CLIENT } from '../constants.js'
import { approveMember, CLIENT_VALUE } from '../services/approval.js'

// The single list, shared with /set-roles so the two cannot drift apart.
const ROLE_OPTIONS = MANAGED_ROLES

export const data = new SlashCommandBuilder()
  .setName('approve')
  .setDescription('Approve a user in holding and assign roles — step-by-step')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run `/init` first.' })

  const holding = await db.guildMember.findMany({
    where: { guildConfigId: cfg.id, status: 'holding' },
  })
  if (!holding.length) {
    const allMembers = await db.guildMember.findMany({
      where: { guildConfigId: cfg.id },
    })
    const pendingCount = allMembers.filter(m => m.status === 'pending').length
    const extra = pendingCount
      ? `\n\n*${pendingCount} user${pendingCount > 1 ? 's are' : ' is'} pending — they need to run **/verify** first.*`
      : ''
    return interaction.editReply({
      content: `No users in holding.${extra}`,
    })
  }

  flowStore.clear(interaction.user.id, guild.id, 'approve')
  flowStore.set(interaction.user.id, guild.id, 'approve', { step: 1 })

  const members = await guild.members.fetch()
  const options = holding.slice(0, 25).map((m) => {
    const mem = members.get(m.discordId)
    return {
      label: `${mem?.user?.username || m.discordId}${m.kind === 'client' ? ' (client)' : ''}`,
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
  const dbMember = await db.guildMember.findUnique({ where: { guildId_discordId: { guildId: guild.id, discordId: userId } } })
  const member = await guild.members.fetch(userId).catch(() => null)
  if (dbMember?.kind === 'client') {
    // An invited client: no staff roles to pick. Straight to the confirmation.
    flowStore.set(interaction.user.id, guild.id, 'approve', { ...state, step: 3, targetUserId: userId, roleNames: [], asClient: true })
    const embed = new EmbedBuilder()
      .setTitle('Confirm approval')
      .setDescription(`Approve **${member?.user?.tag || userId}** as a **client**? They will see only the support channels.`)
      .setColor(0x00b0f4)
      .setFooter({ text: 'Step 2 of 2' })
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('approve_confirm').setLabel('Approve as client').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('approve_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    )
    return interaction.editReply({ embeds: [embed], components: [row] })
  }
  flowStore.set(interaction.user.id, guild.id, 'approve', { ...state, step: 2, targetUserId: userId })

  const embed = new EmbedBuilder()
    .setTitle('Approve user')
    .setDescription(`**Step 2:** Select roles to assign to **${member?.user?.tag || userId}**.`)
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 2 of 3' })

  const roleOptions = [
    { label: ROLE_CLIENT, value: CLIENT_VALUE, description: 'A client: no staff roles, sees only the support channels' },
    ...ROLE_OPTIONS.map((r) => ({
      label: r,
      value: r,
      description: `Assign ${r}`,
    })),
  ]
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
  const asClient = roleNames.includes(CLIENT_VALUE)
  flowStore.set(interaction.user.id, guild.id, 'approve', { ...state, step: 3, roleNames: asClient ? [] : roleNames, asClient })

  const member = await guild.members.fetch(state.targetUserId).catch(() => null)
  const tag = member?.user?.tag || state.targetUserId
  const embed = new EmbedBuilder()
    .setTitle('Confirm approval')
    .setDescription(asClient
      ? `Approve **${tag}** as a **client**? Any staff roles you ticked are ignored — a client holds none.`
      : `Approve **${tag}** and assign: **${roleNames.join(', ')}**?`)
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

    const { asClient, assigned, supportChannelId } = await approveMember({
      guild, member, dbMember, cfg, roleNames: state.roleNames || [], asClient: Boolean(state.asClient),
    })

    flowStore.clear(interaction.user.id, guild.id, 'approve')

    const embed = new EmbedBuilder()
      .setTitle('User approved')
      .setDescription(asClient
        ? `**${member.user.tag}** is approved as a **client**. They can now see ${supportChannelId ? `<#${supportChannelId}>` : 'the support channel'} and the support channels of any project you add them to with **/project-members add … role:Client**.`
        : `**${member.user.tag}** — roles: ${assigned.join(', ') || 'none'}. They now have server access.`)
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
