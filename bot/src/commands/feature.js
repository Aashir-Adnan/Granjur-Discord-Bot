import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as flowStore from '../flows/store.js'
import { getOrCreateCategory } from '../utils/categories.js'
import { CATEGORY_BOLD_NAMES } from '../constants.js'
import { EPHEMERAL } from '../constants.js'

const SELECT_REPOS_PROJECTS_STEP = 1
const CONFIRM_STEP = 2

export const data = new SlashCommandBuilder()
  .setName('feature')
  .setDescription('Create a feature task — enter details, then confirm (or edit)')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
  const projects = await db.projectSchema.findMany({ where: { guildConfigId: cfg.id } })
  if (!repos.length && !projects.length) {
    return interaction.editReply({
      content: 'No repositories or projects. Add repos with **/repos** or add a project schema with **/project-db**.',
    })
  }

  const embed = new EmbedBuilder()
    .setTitle('Create feature')
    .setDescription('Click the button below to enter the feature details. You can edit and confirm in the next step.')
    .setColor(0x5865f2)
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('feature_show_modal').setLabel('Enter feature details').setStyle(ButtonStyle.Primary)
  )
  await interaction.editReply({ embeds: [embed], components: [row] })
}

function buildFeatureModal() {
  const modal = new ModalBuilder().setCustomId('feature_modal').setTitle('Feature details')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Feature title')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Add dark mode toggle')
        .setRequired(true)
        .setMaxLength(200)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Description (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Optional description')
        .setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('scope')
        .setLabel('Scope (optional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Frontend')
        .setRequired(false)
        .setMaxLength(100)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('modules')
        .setLabel('Modules (optional, comma-separated)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Auth, API')
        .setRequired(false)
        .setMaxLength(500)
    )
  )
  return modal
}

export async function handleShowModalButton(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Invalid.', flags: EPHEMERAL }).catch(() => {})
  await interaction.showModal(buildFeatureModal())
}

export async function handleFeatureEditButton(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Invalid.', flags: EPHEMERAL }).catch(() => {})
  await handleShowModalButton(interaction)
}

export async function handleTitleModal(interaction) {
  const guild = interaction.guild
  if (!guild) return

  const title = (interaction.fields.getTextInputValue('title') || '').trim()
  if (!title) return interaction.editReply({ content: 'Title is required.', components: [] }).catch(() => {})

  const description = (interaction.fields.getTextInputValue('description') || '').trim()
  const scope = (interaction.fields.getTextInputValue('scope') || '').trim().slice(0, 100)
  const modulesText = (interaction.fields.getTextInputValue('modules') || '').trim()

  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    const moduleNames = modulesText ? modulesText.split(',').map((s) => s.trim()).filter(Boolean) : []
    const modules = []
    for (const name of moduleNames.slice(0, 20)) {
      if (!name) continue
      const existing = await db.guildModule.findFirst({ where: { guildConfigId: cfg.id, name } })
      if (!existing) await db.guildModule.create({ data: { guildConfigId: cfg.id, name } })
      modules.push(name)
    }

    const existing = flowStore.get(interaction.user.id, guild.id, 'feature')
    const state = {
      step: SELECT_REPOS_PROJECTS_STEP,
      title,
      description: description || null,
      scope: scope || null,
      repositoryIds: existing?.repositoryIds ?? [],
      projectSchemaIds: existing?.projectSchemaIds ?? [],
      modules,
      assigneeIds: existing?.assigneeIds ?? [],
    }
    flowStore.set(interaction.user.id, guild.id, 'feature', state)
    await showReposProjectsStep(interaction, state, guild)
  } catch (e) {
    console.error('Feature modal error:', e)
    await interaction.editReply({ content: `Something went wrong: ${e?.message ?? String(e)}`, components: [] }).catch(() => {})
  }
}

async function showReposProjectsStep(interaction, state, guild) {
  const cfg = await getOrCreateGuildConfig(guild.id)
  const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
  const projects = await db.projectSchema.findMany({ where: { guildConfigId: cfg.id } })

  const repoOptions = repos.slice(0, 25).map((r) => ({
    label: r.name.slice(0, 100),
    value: r.id,
    description: (r.url || '').slice(0, 80),
  }))
  const projectOptions = projects.slice(0, 25).map((p) => ({
    label: (p.projectName || p.projectId || 'Project').slice(0, 100),
    value: p.id,
    description: 'Schema',
  }))

  const embed = new EmbedBuilder()
    .setTitle('Create feature')
    .setDescription('Select **repos** and **projects** (optional). Then click **Next** to confirm.')
    .addFields(
      { name: 'Title', value: state.title?.slice(0, 100) || '—', inline: true },
      { name: 'Scope', value: state.scope || '—', inline: true },
      { name: 'Description', value: (state.description || '—').slice(0, 150), inline: false }
    )
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 1b — Repos & projects' })

  const rows = []
  if (repoOptions.length > 0) {
    const repoSelect = new StringSelectMenuBuilder()
      .setCustomId('feature_select_repos')
      .setPlaceholder('Select repositories (optional, multiple)')
      .setMinValues(0)
      .setMaxValues(repoOptions.length)
      .addOptions(repoOptions)
    rows.push(new ActionRowBuilder().addComponents(repoSelect))
  }
  if (projectOptions.length > 0) {
    const projectSelect = new StringSelectMenuBuilder()
      .setCustomId('feature_select_projects')
      .setPlaceholder('Select projects (optional, multiple)')
      .setMinValues(0)
      .setMaxValues(projectOptions.length)
      .addOptions(projectOptions)
    rows.push(new ActionRowBuilder().addComponents(projectSelect))
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('feature_repos_projects_next').setLabel('Next — confirm').setStyle(ButtonStyle.Primary)
  ))

  const payload = { embeds: [embed], components: rows }
  if (interaction.update) await interaction.update(payload).catch(() => interaction.editReply(payload).catch(() => {}))
  else await interaction.editReply(payload).catch(() => {})
}

export async function handleReposSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'feature')
  if (!state || state.step !== SELECT_REPOS_PROJECTS_STEP) return interaction.editReply({ content: 'Session expired. Run /feature again.', components: [] }).catch(() => {})

  const repositoryIds = interaction.values || []
  const nextState = { ...state, repositoryIds }
  flowStore.set(interaction.user.id, guild.id, 'feature', nextState)
  await showReposProjectsStep(interaction, nextState, guild)
}

export async function handleProjectsSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'feature')
  if (!state || state.step !== SELECT_REPOS_PROJECTS_STEP) return interaction.editReply({ content: 'Session expired. Run /feature again.', components: [] }).catch(() => {})

  const projectSchemaIds = interaction.values || []
  const nextState = { ...state, projectSchemaIds }
  flowStore.set(interaction.user.id, guild.id, 'feature', nextState)
  await showReposProjectsStep(interaction, nextState, guild)
}

export async function handleReposProjectsNext(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'feature')
  if (!state || state.step !== SELECT_REPOS_PROJECTS_STEP) return interaction.editReply({ content: 'Session expired. Run /feature again.', components: [] }).catch(() => {})

  const nextState = { ...state, step: CONFIRM_STEP }
  flowStore.set(interaction.user.id, guild.id, 'feature', nextState)
  await showConfirmStep(interaction, nextState, guild)
}

async function showConfirmStep(interaction, state, guild) {
  const cfg = await getOrCreateGuildConfig(guild.id)
  const membersCollection = await guild.members.fetch()
  const members = Array.from(membersCollection.values())
  const memberOptions = members
    .filter((m) => !m.user.bot)
    .slice(0, 24)
    .map((m) => ({
      label: m.user.username.slice(0, 25),
      value: m.id,
      description: m.user.tag.slice(0, 50),
    }))
  const options = [{ label: 'None', value: 'none', description: 'Only you' }, ...memberOptions].slice(0, 25)

  const mentions = (state.assigneeIds || []).map((id) => `<@${id}>`).join(' ') || 'None'
  const embed = new EmbedBuilder()
    .setTitle('Confirm feature')
    .setDescription('Review below. Change **assignees** if needed, then click **Create ticket** or **Edit** to change details.')
    .addFields(
      { name: 'Title', value: state.title?.slice(0, 100) || '—', inline: true },
      { name: 'Scope', value: state.scope || '—', inline: true },
      { name: 'Assignees', value: mentions, inline: true },
      { name: 'Modules', value: (state.modules?.length ? state.modules.join(', ') : 'None').slice(0, 300), inline: false },
      { name: 'Repos / Projects', value: `${state.repositoryIds?.length || 0} repos, ${state.projectSchemaIds?.length || 0} projects`, inline: false },
      { name: 'Description', value: (state.description || '—').slice(0, 300), inline: false }
    )
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 2 of 2 — Confirm or edit' })

  const select = new StringSelectMenuBuilder()
    .setCustomId('feature_assignees')
    .setPlaceholder('Select assignees (optional)')
    .setMinValues(0)
    .setMaxValues(Math.min(25, options.length))
    .addOptions(options)

  const row1 = new ActionRowBuilder().addComponents(select)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('feature_create').setLabel('Create ticket').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('feature_edit').setLabel('Edit details').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('feature_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  )

  const payload = { embeds: [embed], components: [row1, row2] }
  if (interaction.update) await interaction.update(payload).catch(() => interaction.editReply(payload).catch(() => {}))
  else await interaction.editReply(payload).catch(() => {})
}

export async function handleAssigneesSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return

  const state = flowStore.get(interaction.user.id, guild.id, 'feature')
  if (!state || state.step !== CONFIRM_STEP) return interaction.editReply({ content: 'Session expired. Run /feature again.', components: [] }).catch(() => {})

  const assigneeIds = (interaction.values || []).filter((id) => id !== 'none')
  const nextState = { ...state, assigneeIds }
  flowStore.set(interaction.user.id, guild.id, 'feature', nextState)
  await showConfirmStep(interaction, nextState, guild)
}

export async function handleCreate(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'feature')
  if (!state || state.step !== CONFIRM_STEP) return interaction.editReply({ content: 'Session expired. Run /feature again.', components: [] }).catch(() => {})

  const cfg = await getOrCreateGuildConfig(guild.id)

  try {
    const assigneeIds = state.assigneeIds || []
    const uniqueParticipants = [interaction.user.id, ...assigneeIds].filter(Boolean)
    const uniqueSet = [...new Set(uniqueParticipants)]

    const firstRepoId = state.repositoryIds?.[0] ?? null
    const firstProjectSchema = state.projectSchemaIds?.[0] ? await db.projectSchema.findFirst({ where: { id: state.projectSchemaIds[0] } }) : null
    const projectId = firstProjectSchema?.projectId ?? null
    const projectName = firstProjectSchema?.projectName ?? null

    const feature = await db.feature.create({
      data: {
        guildConfigId: cfg.id,
        repositoryId: firstRepoId,
        projectId,
        projectName,
        title: state.title,
        description: state.description ?? null,
        createdBy: interaction.user.id,
        assigneeIds,
        status: 'open',
        modules: state.modules || [],
        scope: state.scope ?? null,
        implementationStatus: 'not_started',
      },
    })

    if (state.repositoryIds?.length) {
      await db.featureRepositories.add(feature.id, state.repositoryIds)
    }
    if (state.projectSchemaIds?.length) {
      await db.featureProjectSchemas.add(feature.id, state.projectSchemaIds)
    }

    await db.ticketDoc.create({
      data: {
        guildConfigId: cfg.id,
        ticketType: 'feature',
        taskId: feature.id,
        title: state.title?.slice(0, 512) || 'Feature',
        content: null,
      },
    })

    const category = await getOrCreateCategory(guild, 'Features', { orNames: [CATEGORY_BOLD_NAMES['Features']].filter(Boolean) })
    const overwrites = [
      { id: guild.id, type: 0, deny: [PermissionFlagsBits.ViewChannel] },
      ...uniqueSet.map((id) => ({ id, type: 0, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
    ]
    const channel = await guild.channels.create({
      name: `feature-${feature.id.slice(-6)}`,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Feature: ${state.title?.slice(0, 100) || 'Feature'} | Only assigner + assignees`,
      permissionOverwrites: overwrites,
    })

    await db.feature.update({ where: { id: feature.id }, data: { discordChannelId: channel.id } })

    const assigneeMentions = assigneeIds.map((id) => `<@${id}>`).join(' ')
    const allMentions = uniqueSet.map((id) => `<@${id}>`).join(' ')
    const scopeMod = [state.scope, (state.modules?.length ? state.modules.join(', ') : null)].filter(Boolean).join(' · ')
    const embed = new EmbedBuilder()
      .setTitle(`Feature: ${state.title?.slice(0, 200)}`)
      .setDescription((state.description || 'No description.').slice(0, 1000))
      .addFields(
        { name: 'Status', value: 'open', inline: true },
        { name: 'Assignees', value: assigneeMentions || 'None', inline: true },
        { name: 'Scope / Modules', value: scopeMod || '—', inline: false },
        { name: 'Task ID', value: feature.id, inline: false },
        { name: 'Close', value: 'Use **/close-feature** in this channel when done, then upload an MD file describing the feature.', inline: false }
      )
      .setFooter({ text: `Feature ID: ${feature.id}` })
      .setColor(0x5865f2)
    await channel.send({ content: allMentions || null, embeds: [embed] })

    flowStore.clear(interaction.user.id, guild.id, 'feature')

    const doneEmbed = new EmbedBuilder()
      .setTitle('Feature ticket created')
      .setDescription(`Private channel: ${channel}\nOnly you and assignees can see it. Use **/close-feature** there when done.`)
      .setColor(0x57f287)
    await interaction.editReply({ embeds: [doneEmbed], components: [] }).catch(() => {})
  } catch (e) {
    console.error('Feature create error:', e)
    await interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleCancel(interaction) {
  if (interaction.guild) flowStore.clear(interaction.user.id, interaction.guild.id, 'feature')
  await interaction.editReply({ content: 'Feature ticket cancelled.', components: [], embeds: [] }).catch(() => {})
}
