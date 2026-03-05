import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as flowStore from '../flows/store.js'
import { EPHEMERAL } from '../constants.js'

function parseWhen(whenStr) {
  if (/^\d{4}-\d{2}-\d{2}/.test(whenStr)) return new Date(whenStr)
  const match = whenStr.match(/in\s+(\d+)\s*(day|hour|minute)s?/i)
  if (match) {
    const n = parseInt(match[1], 10)
    const unit = match[2].toLowerCase()
    const d = new Date()
    if (unit.startsWith('day')) d.setDate(d.getDate() + n)
    else if (unit.startsWith('hour')) d.setHours(d.getHours() + n)
    else d.setMinutes(d.getMinutes() + n)
    return d
  }
  return new Date(whenStr)
}

export const data = new SlashCommandBuilder()
  .setName('schedule')
  .setDescription('Schedule a meeting — pass topic & when in command, then pick members from list')
  .addStringOption((o) =>
    o.setName('topic').setDescription('Meeting topic').setRequired(false).setMaxLength(200)
  )
  .addStringOption((o) =>
    o.setName('when').setDescription('When (e.g. 2025-03-01 14:00 or in 2 days)').setRequired(false)
  )

function buildScheduleModal() {
  const modal = new ModalBuilder().setCustomId('schedule_modal').setTitle('Meeting details')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('topic')
        .setLabel('Topic')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Sprint planning')
        .setRequired(true)
        .setMaxLength(200)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('when')
        .setLabel('When (e.g. 2025-03-01 14:00 or in 2 days)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('2025-03-01 14:00')
        .setRequired(true)
    )
  )
  return modal
}

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  await getOrCreateGuildConfig(guild.id)

  const topicOpt = interaction.options.getString('topic')
  const whenOpt = interaction.options.getString('when')

  if (topicOpt && whenOpt) {
    const scheduledAt = parseWhen(whenOpt)
    if (Number.isNaN(scheduledAt.getTime())) {
      return interaction.editReply({
        content: 'Invalid date. Use e.g. `2025-03-01 14:00` or `in 2 days`.',
      }).catch(() => {})
    }
    flowStore.set(interaction.user.id, guild.id, 'schedule', { topic: topicOpt, scheduledAt })
    const members = await guild.members.fetch()
    const options = members
      .filter((m) => !m.user.bot)
      .slice(0, 25)
      .map((m) => ({ label: m.user.username.slice(0, 25), value: m.id, description: m.user.tag.slice(0, 50) }))
    const embed = new EmbedBuilder()
      .setTitle('Schedule meeting')
      .setDescription('Select members to invite.')
      .addFields(
        { name: 'Topic', value: topicOpt.slice(0, 100), inline: true },
        { name: 'When', value: scheduledAt.toISOString(), inline: true }
      )
      .setColor(0x5865f2)
      .setFooter({ text: 'Step 2 — Select invitees' })
    const select = new StringSelectMenuBuilder()
      .setCustomId('schedule_members')
      .setPlaceholder('Select members (optional)')
      .setMinValues(0)
      .setMaxValues(Math.min(25, options.length))
      .addOptions(options.length ? options : [{ label: 'None', value: 'none', description: 'No invitees' }])
    return interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(select)],
    }).catch(() => {})
  }

  const embed = new EmbedBuilder()
    .setTitle('Schedule meeting')
    .setDescription('Click the button below to enter topic and time, or run `/schedule topic:... when:...` to skip the form.')
    .setColor(0x5865f2)
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('schedule_show_modal').setLabel('Enter meeting details').setStyle(ButtonStyle.Primary)
  )
  await interaction.editReply({ embeds: [embed], components: [row] })
}

export async function handleShowModalButton(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.', components: [] }).catch(() => {})

  await interaction.showModal(buildScheduleModal())
}

export async function handleScheduleModal(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const topic = interaction.fields.getTextInputValue('topic')
  const whenStr = interaction.fields.getTextInputValue('when')
  const scheduledAt = parseWhen(whenStr)
  if (Number.isNaN(scheduledAt.getTime())) {
    return interaction.editReply({
      content: 'Invalid date. Use e.g. `2025-03-01 14:00` or `in 2 days`.',
    }).catch(() => {})
  }

  flowStore.set(interaction.user.id, guild.id, 'schedule', { topic, scheduledAt })

  try {
    const members = await guild.members.fetch()
    const options = members
      .filter((m) => !m.user.bot)
      .slice(0, 25)
      .map((m) => ({ label: m.user.username.slice(0, 25), value: m.id, description: m.user.tag.slice(0, 50) }))

    const embed = new EmbedBuilder()
      .setTitle('Schedule meeting')
      .setDescription('**Step 2:** Select members to invite.')
      .addFields(
        { name: 'Topic', value: topic.slice(0, 100), inline: true },
        { name: 'When', value: scheduledAt.toISOString(), inline: true }
      )
      .setColor(0x5865f2)
      .setFooter({ text: 'Step 2 of 3' })

    const select = new StringSelectMenuBuilder()
      .setCustomId('schedule_members')
      .setPlaceholder('Select members (optional)')
      .setMinValues(0)
      .setMaxValues(Math.min(25, options.length))
      .addOptions(options.length ? options : [{ label: 'None', value: 'none', description: 'No invitees' }])

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
  const state = flowStore.get(interaction.user.id, guild.id, 'schedule')
  if (!state) return interaction.editReply({ content: 'Session expired. Run /schedule again.', components: [], embeds: [] }).catch(() => {})

  const memberIds = (interaction.values || []).filter((id) => id !== 'none')
  const taggedMentions = memberIds.map((id) => `<@${id}>`).join(' ') || 'None'

  const embed = new EmbedBuilder()
    .setTitle('Confirm meeting')
    .setDescription('Create this scheduled meeting?')
    .addFields(
      { name: 'Topic', value: state.topic, inline: true },
      { name: 'When', value: state.scheduledAt.toISOString(), inline: true },
      { name: 'Invitees', value: taggedMentions, inline: false }
    )
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 3 of 3' })

  flowStore.set(interaction.user.id, guild.id, 'schedule', { ...state, memberIds })

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('schedule_confirm').setLabel('Schedule').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('schedule_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  )

  await interaction.editReply({ embeds: [embed], components: [row] })
}

export async function handleConfirm(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'schedule')
  if (!state) return interaction.editReply({ content: 'Session expired.', components: [] }).catch(() => {})

  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    await db.scheduledMeeting.create({
      data: {
        guildConfigId: cfg.id,
        topic: state.topic,
        scheduledAt: state.scheduledAt,
        memberIds: state.memberIds || [],
        createdBy: interaction.user.id,
      },
    })

    flowStore.clear(interaction.user.id, guild.id, 'schedule')
    const mentions = (state.memberIds || []).map((id) => `<@${id}>`).join(' ')
    const embed = new EmbedBuilder()
      .setTitle('Meeting scheduled')
      .setDescription(`${state.topic} at ${state.scheduledAt.toISOString()}${mentions ? `\nInvited: ${mentions}` : ''}`)
      .setColor(0x57f287)

    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleCancel(interaction) {
  flowStore.clear(interaction.user.id, interaction.guild?.id, 'schedule')
  await interaction.editReply({ content: 'Cancelled.', components: [], embeds: [] }).catch(() => {})
}
