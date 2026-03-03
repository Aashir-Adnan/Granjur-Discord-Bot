import {
  SlashCommandBuilder,
  ChannelType,
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
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { createIssue } from '../services/github.js'
import * as flowStore from '../flows/store.js'
import { getOrCreateCategory } from '../utils/categories.js'
import { CATEGORY_BOLD_NAMES } from '../constants.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('bug')
  .setDescription('Create a bug ticket — step-by-step: pick repo, add details, tag members')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
  if (!repos.length) {
    return interaction.editReply({ content: 'No repositories registered. Add repos with **/repos** first.' })
  }

  flowStore.clear(interaction.user.id, guild.id, 'bug')
  flowStore.set(interaction.user.id, guild.id, 'bug', { step: 1 })

  const embed = new EmbedBuilder()
    .setTitle('Create bug ticket')
    .setDescription('**Step 1:** Choose the repository for this bug.')
    .setColor(0xed4245)
    .setFooter({ text: 'Step 1 of 4' })

  const options = repos.slice(0, 25).map((r) => ({
    label: r.name,
    value: r.id,
    description: r.url.slice(0, 100),
  }))
  const select = new StringSelectMenuBuilder()
    .setCustomId('bug_repo')
    .setPlaceholder('Select repository')
    .addOptions(options)

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  })
}

export async function handleRepoSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return

  const repoId = interaction.values[0]
  const cfg = await getOrCreateGuildConfig(guild.id)
  const repo = await db.repository.findFirst({ where: { id: repoId, guildConfigId: cfg.id } })
  if (!repo) return interaction.editReply({ content: 'Repository not found.', components: [], embeds: [] }).catch(() => {})

  flowStore.set(interaction.user.id, guild.id, 'bug', { step: 2, repositoryId: repoId, repo })

  const modal = new ModalBuilder()
    .setCustomId('bug_modal_details')
    .setTitle('Bug details')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Title')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Short bug title')
        .setRequired(true)
        .setMaxLength(200)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Description')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Describe the bug')
        .setRequired(false)
    )
  )
  await interaction.showModal(modal)
}

export async function handleDetailsModal(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'bug')
  if (!state || state.step !== 2) return interaction.editReply({ content: 'Session expired. Run /bug again.' }).catch(() => {})

  const title = interaction.fields.getTextInputValue('title')
  const description = interaction.fields.getTextInputValue('description') || ''

  flowStore.set(interaction.user.id, guild.id, 'bug', {
    ...state,
    step: 3,
    title,
    description,
  })

  try {
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
      .setTitle('Create bug ticket')
      .setDescription('**Step 3:** Optionally tag members to notify.')
      .addFields(
        { name: 'Repository', value: state.repo?.name || '—', inline: true },
        { name: 'Title', value: title.slice(0, 100), inline: true },
        { name: 'Description', value: description.slice(0, 200) || '—', inline: false }
      )
      .setColor(0xed4245)
      .setFooter({ text: 'Step 3 of 4' })

    const select = new StringSelectMenuBuilder()
      .setCustomId('bug_members')
      .setPlaceholder('Select members to tag (optional)')
      .setMinValues(0)
      .setMaxValues(Math.min(25, options.length))
      .addOptions(options.length ? options : [{ label: 'No members', value: 'none', description: 'Skip' }])

    await interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(select)],
    }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}` }).catch(() => {})
  }
}

export async function handleMembersSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'bug')
  if (!state || state.step !== 3) return interaction.editReply({ content: 'Session expired.', components: [], embeds: [] }).catch(() => {})

  const memberIds = (interaction.values || []).filter((id) => id !== 'none')
  flowStore.set(interaction.user.id, guild.id, 'bug', { ...state, step: 4, taggedMemberIds: memberIds })

  const taggedMentions = memberIds.map((id) => `<@${id}>`).join(' ') || 'None'
  const embed = new EmbedBuilder()
    .setTitle('Confirm bug ticket')
    .setDescription('Review and create the ticket. A new channel will be created.')
    .addFields(
      { name: 'Repository', value: state.repo?.name || '—', inline: true },
      { name: 'Title', value: state.title || '—', inline: true },
      { name: 'Description', value: (state.description || '—').slice(0, 500), inline: false },
      { name: 'Tagged', value: taggedMentions, inline: false }
    )
    .setColor(0xed4245)
    .setFooter({ text: 'Step 4 of 4' })

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bug_create').setLabel('Create ticket').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('bug_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  )

  await interaction.editReply({ embeds: [embed], components: [row] })
}

export async function handleCreate(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'bug')
  if (!state || state.step !== 4) return interaction.editReply({ content: 'Session expired.', components: [] }).catch(() => {})

  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    const taggedIds = state.taggedMemberIds || []
    const taggedMentions = taggedIds.map((id) => `<@${id}>`).join(' ')

    const ticket = await db.bugTicket.create({
      data: {
        guildConfigId: cfg.id,
        repositoryId: state.repositoryId,
        title: state.title,
        description: state.description || null,
        status: 'pending',
        taggedMemberIds: taggedIds,
        createdBy: interaction.user.id,
      },
    })

    let issueUrl = ''
    if (state.repo?.url) {
      try {
        const body = [
          state.description || '',
          `\n---\n**Tagged:** ${taggedMentions || 'none'}`,
          `**Repos:** ${state.repo.url}`,
          `**Ticket ID:** ${ticket.id}`,
        ].join('\n')
        const res = await createIssue(state.repo.url, state.title, body)
        if (res?.url) {
          issueUrl = res.url
          await db.bugTicket.update({
            where: { id: ticket.id },
            data: { externalIssueUrl: res.url, externalIssueNumber: res.number },
          })
        }
      } catch (_) {}
    }

    const participantIds = [interaction.user.id, ...taggedIds]
    const uniqueParticipants = [...new Set(participantIds)]
    const category = await getOrCreateCategory(guild, 'Bugs', { orNames: [CATEGORY_BOLD_NAMES['Bugs']].filter(Boolean) })
    const overwrites = [
      { id: guild.id, type: 0, deny: [PermissionFlagsBits.ViewChannel] },
      ...uniqueParticipants.map((id) => ({ id, type: 0, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
    ]
    const channel = await guild.channels.create({
      name: `bug-${ticket.id.slice(-6)}`,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Bug: ${state.title} | Repo: ${state.repo?.name || '—'} | Only assigner + assignees`,
      permissionOverwrites: overwrites,
    })
    await db.bugTicket.update({ where: { id: ticket.id }, data: { discordChannelId: channel.id } })

    await db.ticketDoc.create({
      data: {
        guildConfigId: cfg.id,
        ticketType: 'bug',
        taskId: ticket.id,
        title: (state.title || 'Bug').slice(0, 512),
        content: null,
      },
    })

    const embed = new EmbedBuilder()
      .setTitle(`Bug: ${state.title}`)
      .setDescription((state.description || 'No description.').slice(0, 1000))
      .addFields(
        { name: 'Status', value: 'pending', inline: true },
        { name: 'Tagged', value: taggedMentions || 'None', inline: true },
        { name: 'Repository', value: state.repo?.url || '—', inline: false },
        { name: 'Resolve', value: 'Use **/resolve-bug** in this channel when fixed, then upload an MD file describing the solution.', inline: false },
        ...(issueUrl ? [{ name: 'Issue', value: issueUrl, inline: false }] : [])
      )
      .setFooter({ text: `Ticket ID: ${ticket.id}` })
      .setColor(0xed4245)

    const allMentions = uniqueParticipants.map((id) => `<@${id}>`).join(' ')
    await channel.send({ content: allMentions || null, embeds: [embed] })

    flowStore.clear(interaction.user.id, guild.id, 'bug')

    const doneEmbed = new EmbedBuilder()
      .setTitle('Bug ticket created')
      .setDescription(`Channel: ${channel}\n${issueUrl ? `Issue: ${issueUrl}` : ''}`)
      .setColor(0x57f287)

    await interaction.editReply({ embeds: [doneEmbed], components: [] }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleCancel(interaction) {
  const guild = interaction.guild
  if (guild) flowStore.clear(interaction.user.id, guild.id, 'bug')
  await interaction.editReply({ content: 'Bug ticket cancelled.', components: [], embeds: [] }).catch(() => {})
}
