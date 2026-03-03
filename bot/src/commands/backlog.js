import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'
import * as flowStore from '../flows/store.js'

const ROLE_OPTIONS = [
  'Intern', 'Temp', 'Junior Dev', 'Senior Dev', 'Associate Engineer',
  'Quality Assurance', 'Project Manager', 'Server Manager', 'CEO',
  'Frontend', 'UI/UX', 'Designer', 'Server', 'Full-Stack', 'Database',
]
const ADD_ROLE_VALUE = '__add_role__'

export const data = new SlashCommandBuilder()
  .setName('backlog')
  .setDescription('(CEO/Server Manager) View incoming users in holding and approve + assign roles via modal')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

export async function execute(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

    const cfg = await getOrCreateGuildConfig(guild.id)
    if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

    const dashboardIds = ensureStringArray(cfg.dashboardRoleIds)
    const member = await guild.members.fetch(interaction.user.id).catch(() => null)
    const canBacklog =
      (dashboardIds.length && member?.roles.cache.some((r) => dashboardIds.includes(r.id))) ||
      member?.permissions.has('Administrator')
    if (!canBacklog) {
      return interaction.editReply({ content: 'Only CEO or Server Manager can view the backlog.' })
    }

    const holding = await db.guildMember.findMany({
      where: { guildConfigId: cfg.id, status: 'holding' },
    })
    if (!holding.length) {
      return interaction.editReply({
        content: '**Backlog empty.** No users in holding. New users appear here after they complete **/verify**.',
      })
    }

    const members = await guild.members.fetch()
    const lines = holding.slice(0, 15).map((m, i) => {
      const mem = members.get(m.discordId)
      const name = mem?.user?.username ?? m.discordId
      const email = m.email || '—'
      const at = m.verifiedAt ? new Date(m.verifiedAt).toLocaleDateString() : '—'
      return `**${i + 1}.** ${name} · ${email} · verified ${at}`
    })

    const embed = new EmbedBuilder()
      .setTitle('Incoming users (holding)')
      .setDescription(
        'Select a user below to **approve and assign roles**.\n\n' +
          (lines.join('\n') || 'No one in holding.')
      )
      .setColor(0xfee75c)
      .setFooter({ text: `${holding.length} waiting · Step 1 of 2` })

    const options = holding.slice(0, 25).map((m) => {
      const mem = members.get(m.discordId)
      return {
        label: (mem?.user?.username || m.discordId).slice(0, 100),
        value: m.discordId,
        description: (m.email || 'No email').slice(0, 100),
      }
    })

    const select = new StringSelectMenuBuilder()
      .setCustomId('backlog_select_user')
      .setPlaceholder('Select user to approve…')
      .addOptions(options)

    await interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(select)],
    })
  } catch (e) {
    const msg = e?.message ?? String(e)
    await interaction.editReply({ content: `Backlog failed: ${msg}` }).catch(() => {})
  }
}

export async function handleBacklogUserSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.', components: [], embeds: [] }).catch(() => {})

  const userId = interaction.values?.[0]
  if (!userId) return

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized.', components: [], embeds: [] }).catch(() => {})

  const dbMember = await db.guildMember.findUnique({
    where: { guildId_discordId: { guildId: guild.id, discordId: userId } },
  })
  if (!dbMember || dbMember.status !== 'holding') {
    return interaction.editReply({ content: 'User is no longer in holding.', components: [], embeds: [] }).catch(() => {})
  }

  const member = await guild.members.fetch(userId).catch(() => null)
  const displayName = (member?.user?.username || userId).slice(0, 32)

  flowStore.set(interaction.user.id, guild.id, 'backlog_approve', { userId, displayName })

  let roles = await db.guildAssignableRole.findMany({ where: { guildConfigId: cfg.id } })
  if (roles.length === 0) {
    for (const name of ROLE_OPTIONS) {
      await db.guildAssignableRole.create({ data: { guildConfigId: cfg.id, name } }).catch(() => {})
    }
    roles = await db.guildAssignableRole.findMany({ where: { guildConfigId: cfg.id } })
  }

  const options = roles.slice(0, 24).map((r) => ({ label: r.name.slice(0, 100), value: r.name }))
  options.push({ label: '+ Add new role', value: ADD_ROLE_VALUE, description: 'Add a role to the list' })

  const embed = new EmbedBuilder()
    .setTitle(`Assign roles · ${displayName}`)
    .setDescription('Select one or more roles to assign, then click **Approve**. You can add new roles with "+ Add new role".')
    .setColor(0xfee75c)
    .setFooter({ text: 'Step 2 of 2' })

  const select = new StringSelectMenuBuilder()
    .setCustomId('backlog_select_roles')
    .setPlaceholder('Select roles (multiple)…')
    .setMinValues(0)
    .setMaxValues(Math.min(25, options.length))
    .addOptions(options)

  const approveBtn = new ButtonBuilder()
    .setCustomId(`backlog_approve_btn:${userId}`)
    .setLabel('Approve')
    .setStyle(ButtonStyle.Success)

  await interaction.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(approveBtn),
    ],
  }).catch(() => {})
}

export async function handleBacklogRoleSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.', components: [], embeds: [] }).catch(() => {})

  const state = flowStore.get(interaction.user.id, guild.id, 'backlog_approve')
  const userId = state?.userId
  if (!userId) return interaction.editReply({ content: 'Session expired. Run **/backlog** again.', components: [], embeds: [] }).catch(() => {})

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized.', components: [], embeds: [] }).catch(() => {})

  const values = interaction.values || []
  if (values.includes(ADD_ROLE_VALUE)) {
    const modal = new ModalBuilder()
      .setCustomId(`backlog_add_role_modal:${userId}`)
      .setTitle('Add role')
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Role name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. DevOps')
          .setRequired(true)
          .setMaxLength(100)
      )
    )
    return interaction.showModal(modal)
  }

  const selectedRoles = values.filter((v) => v !== ADD_ROLE_VALUE)
  flowStore.set(interaction.user.id, guild.id, 'backlog_approve', { ...state, selectedRoles })

  const embed = new EmbedBuilder()
    .setTitle(`Assign roles · ${state.displayName || 'User'}`)
    .setDescription(
      (selectedRoles.length ? `**Selected:** ${selectedRoles.join(', ')}\n\n` : '') +
        'Click **Approve** to assign these roles and approve the user, or change your selection above.'
    )
    .setColor(0xfee75c)
    .setFooter({ text: 'Step 2 of 2' })

  const approveBtn = new ButtonBuilder()
    .setCustomId(`backlog_approve_btn:${userId}`)
    .setLabel('Approve')
    .setStyle(ButtonStyle.Success)

  let roles = await db.guildAssignableRole.findMany({ where: { guildConfigId: cfg.id } })
  const options = roles.slice(0, 24).map((r) => ({ label: r.name.slice(0, 100), value: r.name }))
  options.push({ label: '+ Add new role', value: ADD_ROLE_VALUE, description: 'Add a role to the list' })

  const select = new StringSelectMenuBuilder()
    .setCustomId('backlog_select_roles')
    .setPlaceholder('Select roles (multiple)…')
    .setMinValues(0)
    .setMaxValues(Math.min(25, options.length))
    .addOptions(options)

  await interaction.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(approveBtn),
    ],
  }).catch(() => {})
}

export async function handleBacklogAddRoleModal(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.' }).catch(() => {})

  const customId = interaction.customId || ''
  const userId = customId.startsWith('backlog_add_role_modal:') ? customId.slice('backlog_add_role_modal:'.length) : null
  if (!userId) return interaction.editReply({ content: 'Invalid session.' }).catch(() => {})

  const name = (interaction.fields.getTextInputValue('name') || '').trim().slice(0, 100)
  if (!name) return interaction.editReply({ content: 'Role name cannot be empty.', components: [] }).catch(() => {})

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized.', components: [] }).catch(() => {})

  const existing = await db.guildAssignableRole.findFirst({ where: { guildConfigId: cfg.id, name } })
  if (!existing) await db.guildAssignableRole.create({ data: { guildConfigId: cfg.id, name } })

  const state = flowStore.get(interaction.user.id, guild.id, 'backlog_approve')
  if (!state?.userId) return interaction.editReply({ content: 'Session expired. Run **/backlog** again.', components: [] }).catch(() => {})

  const roles = await db.guildAssignableRole.findMany({ where: { guildConfigId: cfg.id } })
  const options = roles.slice(0, 24).map((r) => ({ label: r.name.slice(0, 100), value: r.name }))
  options.push({ label: '+ Add new role', value: ADD_ROLE_VALUE, description: 'Add a role to the list' })

  const embed = new EmbedBuilder()
    .setTitle(`Assign roles · ${state.displayName || 'User'}`)
    .setDescription(`Added **${name}**. Select roles to assign, then click **Approve**.`)
    .setColor(0xfee75c)
    .setFooter({ text: 'Step 2 of 2' })

  const select = new StringSelectMenuBuilder()
    .setCustomId('backlog_select_roles')
    .setPlaceholder('Select roles (multiple)…')
    .setMinValues(0)
    .setMaxValues(Math.min(25, options.length))
    .addOptions(options)

  const approveBtn = new ButtonBuilder()
    .setCustomId(`backlog_approve_btn:${userId}`)
    .setLabel('Approve')
    .setStyle(ButtonStyle.Success)

  await interaction.editReply({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(approveBtn),
    ],
  }).catch(() => {})
}

export async function handleBacklogApproveButton(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.', components: [] }).catch(() => {})

  const customId = interaction.customId || ''
  const userId = customId.startsWith('backlog_approve_btn:') ? customId.slice('backlog_approve_btn:'.length) : null
  if (!userId) return interaction.editReply({ content: 'Invalid session.', components: [] }).catch(() => {})

  const state = flowStore.get(interaction.user.id, guild.id, 'backlog_approve')
  if (!state || state.userId !== userId) return interaction.editReply({ content: 'Session expired. Run **/backlog** again.', components: [] }).catch(() => {})

  const modal = new ModalBuilder()
    .setCustomId(`backlog_approve_modal:${userId}`)
    .setTitle('Confirm approval')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('notes')
        .setLabel('Notes (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500)
    )
  )
  await interaction.showModal(modal)
}

export async function handleBacklogApproveModal(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.' }).catch(() => {})

  const customId = interaction.customId || ''
  const userId = customId.startsWith('backlog_approve_modal:') ? customId.slice('backlog_approve_modal:'.length) : null
  if (!userId) return interaction.editReply({ content: 'Invalid session.' }).catch(() => {})

  const state = flowStore.get(interaction.user.id, guild.id, 'backlog_approve')
  const roleNames = Array.isArray(state?.selectedRoles) ? state.selectedRoles : []
  const notes = (interaction.fields.getTextInputValue('notes') || '').trim()

  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    if (!cfg) return interaction.editReply({ content: 'Server not initialized.' }).catch(() => {})

    const dbMember = await db.guildMember.findUnique({
      where: { guildId_discordId: { guildId: guild.id, discordId: userId } },
    })
    if (!dbMember || dbMember.status !== 'holding') {
      return interaction.editReply({ content: 'User is no longer in holding.' }).catch(() => {})
    }

    const member = await guild.members.fetch(userId).catch(() => null)
    if (!member) return interaction.editReply({ content: 'Member not found in server.' }).catch(() => {})

    const assigned = []
    for (const name of roleNames) {
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

    flowStore.clear(interaction.user.id, guild.id, 'backlog_approve')

    const embed = new EmbedBuilder()
      .setTitle('User approved')
      .setDescription(
        `**${member.user.tag}** is now approved.\n\n` +
          `**Roles assigned:** ${assigned.length ? assigned.join(', ') : 'none'}\n` +
          (notes ? `**Notes:** ${notes.slice(0, 200)}` : '')
      )
      .setColor(0x57f287)
      .setFooter({ text: 'They now have server access.' })

    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {})
  } catch (e) {
    const msg = e?.message ?? String(e)
    await interaction.editReply({ content: `Approval failed: ${msg}` }).catch(() => {})
  }
}
