import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as flowStore from '../flows/store.js'
import { createTaskTicketChannel } from '../services/taskTicketChannel.js'
import { createIssue } from '../services/github.js'
import { createTask } from '../services/taskCreate.js'
import { CATEGORY_SOFT_CAP } from '../constants.js'
import { EPHEMERAL } from '../constants.js'
import { SCOPE_CHOICES, scopeLabel, isValidScope } from '../utils/taskScope.js'

const FLOW_KEY = 'create_task'

const SESSION_EXPIRED_MSG = 'Session expired or invalid step. Run **/create-task** again.'

/** After deferUpdate() we must use editReply(); after deferReply() use editReply(); only use update() when not yet acknowledged. */
async function respond(interaction, payload) {
  const p = typeof payload === 'string' ? { content: payload, components: [], embeds: [] } : payload
  if (interaction.isMessageComponent?.()) {
    if (interaction.replied || interaction.deferred) {
      return interaction.editReply(p).catch((err) => console.error('[create-task] respond editReply:', err?.message ?? err))
    }
    return interaction.update(p).catch((err) => {
      console.error('[create-task] respond update failed:', err?.message ?? err)
      return interaction.editReply(p).catch((err2) => console.error('[create-task] respond editReply failed:', err2?.message ?? err2))
    })
  }
  if (interaction.replied || interaction.deferred) return interaction.editReply(p).catch((err) => console.error('[create-task] respond editReply:', err?.message ?? err))
  return interaction.reply({ ...p, flags: EPHEMERAL }).catch((err) => console.error('[create-task] respond reply:', err?.message ?? err))
}
const STEP_TYPE = 'type'
const STEP_REPO = 'repo'
const STEP_MODAL = 'modal'
const STEP_SCOPE = 'scope'
const STEP_REPOS_PROJECTS = 'repos_projects'
const STEP_MEMBERS = 'members'
const STEP_CONFIRM = 'confirm'

export const data = new SlashCommandBuilder()
  .setName('create-task')
  .setDescription('Create a task (feature or bug) — pass details in command, then pick repos/projects from lists')
  .addStringOption((o) =>
    o.setName('type').setDescription('Task type').setRequired(false).addChoices({ name: 'Feature', value: 'feature' }, { name: 'Bug', value: 'bug' })
  )
  .addStringOption((o) =>
    o.setName('title').setDescription('Task title').setRequired(false).setMaxLength(200)
  )
  .addStringOption((o) =>
    o.setName('description').setDescription('Task description (optional)').setRequired(false).setMaxLength(2000)
  )
  .addStringOption((o) =>
    o.setName('scope').setDescription('Scope').setRequired(false).addChoices(...SCOPE_CHOICES)
  )
  .addStringOption((o) =>
    o.setName('modules').setDescription('Modules, comma-separated (feature only)').setRequired(false).setMaxLength(500)
  )
  .addStringOption((o) =>
    o.setName('assignees').setDescription('Assignees: @mentions or user IDs, space-separated (feature only)').setRequired(false).setMaxLength(500)
  )
  .addStringOption((o) =>
    o.setName('tagged').setDescription('Members to tag: @mentions or user IDs, space-separated (bug only)').setRequired(false).setMaxLength(500)
  )

/** Parse space-separated @mentions or Discord user IDs (17–19 digit snowflakes) into array of IDs. */
function parseUserIds(str) {
  if (!str || !str.trim()) return []
  const ids = new Set()
  const re = /<@!?(\d+)>|(\d{17,19})/g
  let m
  while ((m = re.exec(str)) !== null) ids.add(m[1] || m[2])
  return [...ids]
}

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  if (!repos.length && !projects.length) {
    return interaction.editReply({
      content: 'No repositories or projects. Add repos with **/repos** or a project with **/projects**.',
    })
  }

  const typeOpt = interaction.options.getString('type')
  const titleOpt = interaction.options.getString('title')
  const descriptionOpt = (interaction.options.getString('description') || '').trim() || null
  const scopeOpt = interaction.options.getString('scope') // constrained to the five choices, or null
  const modulesOpt = (interaction.options.getString('modules') || '').trim()
  const assigneesOpt = interaction.options.getString('assignees')
  const taggedOpt = interaction.options.getString('tagged')

  flowStore.clear(interaction.user.id, guild.id, FLOW_KEY)

  // If type + title provided in command, skip type step and modal; go to repos/project or repo step
  if (typeOpt && titleOpt) {
    const taskType = typeOpt
    const moduleNames = modulesOpt ? modulesOpt.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20) : []
    const modules = []
    for (const name of moduleNames) {
      const existing = await db.guildModule.findFirst({ where: { guildConfigId: cfg.id, name } })
      if (!existing) await db.guildModule.create({ data: { guildConfigId: cfg.id, name } })
      modules.push(name)
    }
    const state = {
      step: taskType === 'feature' ? STEP_REPOS_PROJECTS : STEP_REPO,
      taskType,
      title: titleOpt.trim(),
      description: descriptionOpt,
      scope: scopeOpt || null,
      modules: taskType === 'feature' ? modules : [],
      assigneeIds: taskType === 'feature' ? parseUserIds(assigneesOpt || '') : undefined,
      taggedMemberIds: taskType === 'bug' ? parseUserIds(taggedOpt || '') : undefined,
    }
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, state)
    if (taskType === 'feature') {
      // Scope may already be known (given in the command); proceedAfterScope
      // asks for it first only when it is not.
      await proceedAfterScope(interaction, state, guild)
    } else {
      if (!repos.length) return interaction.editReply({ content: 'No repositories. Add with **/repos** first.', components: [] })
      const embed = new EmbedBuilder()
        .setTitle('Create bug task')
        .setDescription('Select the **repository** for this bug.')
        .setColor(0xed4245)
        .setFooter({ text: 'Step — Repository' })
      const options = repos.slice(0, 25).map((r) => ({ label: r.name, value: r.id, description: (r.url || '').slice(0, 100) }))
      const select = new StringSelectMenuBuilder().setCustomId('create_task_repo').setPlaceholder('Select repository').addOptions(options)
      await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] })
    }
    return
  }

  // Otherwise: if only type provided, go to modal (feature) or repo (bug)
  if (typeOpt) {
    const isFeature = typeOpt === 'feature'
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, { step: isFeature ? STEP_MODAL : STEP_REPO, taskType: typeOpt })
    if (isFeature) {
      const embed = new EmbedBuilder()
        .setTitle('Create feature task')
        .setDescription('Click **Enter details** to open the form (title, description, scope, modules).')
        .setColor(0x5865f2)
        .setFooter({ text: 'Step 2 — Details' })
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('create_task_show_modal').setLabel('Enter details').setStyle(ButtonStyle.Primary)
      )
      await interaction.editReply({ embeds: [embed], components: [row] })
    } else {
      if (!repos.length) return interaction.editReply({ content: 'No repositories. Add with **/repos** first.', components: [] })
      const embed = new EmbedBuilder()
        .setTitle('Create bug task')
        .setDescription('**Step 1:** Choose the repository for this bug.')
        .setColor(0xed4245)
        .setFooter({ text: 'Step 2 — Repository' })
      const options = repos.slice(0, 25).map((r) => ({ label: r.name, value: r.id, description: (r.url || '').slice(0, 100) }))
      const select = new StringSelectMenuBuilder().setCustomId('create_task_repo').setPlaceholder('Select repository').addOptions(options)
      await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] })
    }
    return
  }

  flowStore.set(interaction.user.id, guild.id, FLOW_KEY, { step: STEP_TYPE })
  const embed = new EmbedBuilder()
    .setTitle('Create task')
    .setDescription('Choose whether this task is a **feature** or a **bug**. You can also run `/create-task type:feature title:Your title description:...` to skip this.')
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 1 — Type' })
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('create_task_type_feature').setLabel('Feature').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('create_task_type_bug').setLabel('Bug').setStyle(ButtonStyle.Danger)
  )
  await interaction.editReply({ embeds: [embed], components: [row] })
}

export async function handleTypeButton(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleTypeButton: no guild')
      return
    }
    const isFeature = interaction.customId === 'create_task_type_feature'
    const taskType = isFeature ? 'feature' : 'bug'
    const cfg = await getOrCreateGuildConfig(guild.id)

    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, { step: isFeature ? STEP_MODAL : STEP_REPO, taskType })

    if (isFeature) {
    const embed = new EmbedBuilder()
      .setTitle('Create feature task')
      .setDescription('Click **Enter details** to open the form (title, description, scope, modules).')
      .setColor(0x5865f2)
      .setFooter({ text: 'Step 2 — Details' })
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('create_task_show_modal').setLabel('Enter details').setStyle(ButtonStyle.Primary)
    )
    await interaction.update({ embeds: [embed], components: [row] }).catch(() => interaction.editReply({ embeds: [embed], components: [row] }))
  } else {
    const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
    if (!repos.length) return interaction.update({ content: 'No repositories. Add with **/repos** first.', components: [] }).catch(() => {})
    const embed = new EmbedBuilder()
      .setTitle('Create bug task')
      .setDescription('**Step 1:** Choose the repository for this bug.')
      .setColor(0xed4245)
      .setFooter({ text: 'Step 2 — Repository' })
    const options = repos.slice(0, 25).map((r) => ({ label: r.name, value: r.id, description: (r.url || '').slice(0, 100) }))
    const select = new StringSelectMenuBuilder().setCustomId('create_task_repo').setPlaceholder('Select repository').addOptions(options)
    await interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] }).catch((e) => {
      console.error('[create-task] handleTypeButton bug update:', e?.message ?? e)
      interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] }).catch(() => {})
    })
  }
  } catch (e) {
    console.error('[create-task] handleTypeButton error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

function buildTaskModal(isFeature) {
  const modal = new ModalBuilder()
    .setCustomId('create_task_modal')
    .setTitle(isFeature ? 'Feature details' : 'Bug details')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setPlaceholder(isFeature ? 'e.g. Add dark mode' : 'Short bug title').setRequired(true).setMaxLength(200)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('description').setLabel('Description (optional)').setStyle(TextInputStyle.Paragraph).setPlaceholder('Optional').setRequired(false)
    )
  )
  if (isFeature) {
    // Scope is a fixed choice now, not typed text — a modal can only hold text
    // inputs, so it is asked as its own select-menu step (STEP_SCOPE) after
    // this modal is submitted, not inside it.
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('modules').setLabel('Modules (comma-separated, optional)').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Auth, API').setRequired(false).setMaxLength(500)
      )
    )
  }
  return modal
}

/** The scope step's picker. Exported for its test. */
export function scopeRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('create_task_scope')
    .setPlaceholder('Select scope')
    .addOptions(SCOPE_CHOICES.map((c) => ({ label: c.name, value: c.value })))
  return new ActionRowBuilder().addComponents(menu)
}

async function showScopeStep(interaction, state, guild) {
  try {
    const isFeature = state.taskType === 'feature'
    const embed = new EmbedBuilder()
      .setTitle(isFeature ? 'Create feature task' : 'Create bug task')
      .setDescription('Pick the **scope** this task belongs to.')
      .addFields({ name: 'Title', value: state.title?.slice(0, 100) || '—', inline: true })
      .setColor(isFeature ? 0x5865f2 : 0xed4245)
      .setFooter({ text: 'Step — Scope' })
    await respond(interaction, { embeds: [embed], components: [scopeRow()] })
  } catch (e) {
    console.error('[create-task] showScopeStep error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleScopeSelect(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleScopeSelect: no guild')
      return
    }
    const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
    if (!state || state.step !== STEP_SCOPE) {
      console.error('[create-task] handleScopeSelect: wrong step or no state', state?.step)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }
    const scope = interaction.values?.[0]
    if (!isValidScope(scope)) {
      console.error('[create-task] handleScopeSelect: invalid scope value', scope)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }
    await proceedAfterScope(interaction, { ...state, scope }, guild)
  } catch (e) {
    console.error('[create-task] handleScopeSelect error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

/**
 * The single decision point for "what comes right after title/description are
 * known": ask for scope first when it is not yet set (every path that can
 * reach here funnels through this — the fast slash-command path, the modal,
 * and a bug's repo-select when its title arrived via the fast path too), then
 * continue to the type's real next step. Centralizing this avoids repeating
 * the same `if (!state.scope)` branch at every one of those call sites.
 */
async function proceedAfterScope(interaction, state, guild) {
  if (!state.scope) {
    const next = { ...state, step: STEP_SCOPE }
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, next)
    return showScopeStep(interaction, next, guild)
  }
  if (state.taskType === 'feature') {
    const next = { ...state, step: STEP_REPOS_PROJECTS }
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, next)
    return showReposProjectsStep(interaction, next, guild)
  }
  if (state.taggedMemberIds?.length !== undefined) {
    const next = { ...state, step: STEP_CONFIRM }
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, next)
    return showConfirmStep(interaction, next, guild)
  }
  const next = { ...state, step: STEP_MEMBERS }
  flowStore.set(interaction.user.id, guild.id, FLOW_KEY, next)
  return showMembersStep(interaction, next, guild)
}

export async function handleShowModalButton(interaction) {
  try {
    if (!interaction.guild) {
      console.error('[create-task] handleShowModalButton: no guild')
      return
    }
    const state = flowStore.get(interaction.user.id, interaction.guild.id, FLOW_KEY)
    if (!state || state.taskType !== 'feature') {
      console.error('[create-task] handleShowModalButton: missing state or not feature', state?.step, state?.taskType)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }
    await interaction.showModal(buildTaskModal(true))
  } catch (e) {
    console.error('[create-task] handleShowModalButton error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleTaskModal(interaction) {
  try {
    // Defer here when index.js skips defer for create_task_modal (avoids 40060 already acknowledged)
    if (!interaction.deferred && !interaction.replied) {
      try {
        await interaction.deferReply({ flags: EPHEMERAL })
      } catch (e) {
        if (e.code === 40060) return // already acknowledged (duplicate or race)
        console.error('[create-task] handleTaskModal defer:', e?.message ?? e)
        return
      }
    }
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleTaskModal: no guild')
      await respond(interaction, { content: 'Use this in a server.', components: [] }).catch(() => {})
      return
    }
    const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
    if (!state) {
      console.error('[create-task] handleTaskModal: no state')
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }

    const title = (interaction.fields.getTextInputValue('title') || '').trim()
    if (!title) {
      await respond(interaction, { content: 'Title is required.', components: [] }).catch(() => {})
      return
    }

  const description = (interaction.fields.getTextInputValue('description') || '').trim()
  const isFeature = state.taskType === 'feature'

  const nextState = { ...state, title, description }
  if (isFeature) {
    const modulesText = (interaction.fields.getTextInputValue('modules') || '').trim()
    const moduleNames = modulesText ? modulesText.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20) : []
    const modules = []
    const cfg = await getOrCreateGuildConfig(guild.id)
    for (const name of moduleNames) {
      const existing = await db.guildModule.findFirst({ where: { guildConfigId: cfg.id, name } })
      if (!existing) await db.guildModule.create({ data: { guildConfigId: cfg.id, name } })
      modules.push(name)
    }
    nextState.modules = modules
  }
  // Neither modal ever asks for scope (it is a fixed choice, not text), so it
  // is always still unset here — proceedAfterScope shows the select step next.
  await proceedAfterScope(interaction, nextState, guild)
  } catch (e) {
    console.error('[create-task] handleTaskModal error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleRepoSelect(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleRepoSelect: no guild')
      return
    }
    const repoId = interaction.values?.[0]
    if (!repoId) {
      await respond(interaction, { content: 'No repository selected.', components: [] }).catch(() => {})
      return
    }
    const cfg = await getOrCreateGuildConfig(guild.id)
    const repo = await db.repository.findFirst({ where: { id: repoId, guildConfigId: cfg.id } })
    if (!repo) {
      await respond(interaction, { content: 'Repository not found.', components: [] }).catch(() => {})
      return
    }

    const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
    if (!state || state.taskType !== 'bug') {
      console.error('[create-task] handleRepoSelect: missing state or not bug', state?.step, state?.taskType)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }

    const nextState = { ...state, repositoryId: repoId, repo }
    // If title was already set (e.g. from command), skip the modal — proceedAfterScope
    // asks for scope first if it is not already known, then decides tagged/members/confirm.
    if (state.title) {
      await proceedAfterScope(interaction, nextState, guild)
    } else {
      nextState.step = STEP_MODAL
      flowStore.set(interaction.user.id, guild.id, FLOW_KEY, nextState)
      await interaction.showModal(buildTaskModal(false))
    }
  } catch (e) {
    console.error('[create-task] handleRepoSelect error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

async function showReposProjectsStep(interaction, state, guild) {
  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
    const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
    const repoOptions = repos.slice(0, 25).map((r) => ({ label: r.name.slice(0, 100), value: r.id, description: (r.url || '').slice(0, 80) }))
    const projectOptions = projects.slice(0, 25).map((p) => ({ label: String(p.name || 'Project').slice(0, 100), value: p.id, description: p.docsSlug ? `docs: ${p.docsSlug}`.slice(0, 100) : 'Project' }))

    const embed = new EmbedBuilder()
    .setTitle('Create feature task')
    .setDescription('Select **repos** and **projects** (optional). Then click **Next** to confirm.')
    .addFields(
      { name: 'Title', value: state.title?.slice(0, 100) || '—', inline: true },
      { name: 'Scope', value: scopeLabel(state.scope) || '—', inline: true },
      { name: 'Description', value: (state.description || '—').slice(0, 150), inline: false }
    )
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 3 — Repos & projects' })

  const rows = []
  if (repoOptions.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('create_task_select_repos').setPlaceholder('Repositories (optional)').setMinValues(0).setMaxValues(repoOptions.length).addOptions(repoOptions)))
  if (projectOptions.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('create_task_select_projects').setPlaceholder('Projects (optional)').setMinValues(0).setMaxValues(projectOptions.length).addOptions(projectOptions)))
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('create_task_repos_next').setLabel('Next — confirm').setStyle(ButtonStyle.Primary)))

    await respond(interaction, { embeds: [embed], components: rows })
  } catch (e) {
    console.error('[create-task] showReposProjectsStep error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleReposSelect(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleReposSelect: no guild')
      return
    }
    const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
    if (!state || state.step !== STEP_REPOS_PROJECTS) {
      console.error('[create-task] handleReposSelect: wrong step or no state', state?.step)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }
    const nextState = { ...state, repositoryIds: interaction.values || [] }
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, nextState)
    await showReposProjectsStep(interaction, nextState, guild)
  } catch (e) {
    console.error('[create-task] handleReposSelect error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleProjectsSelect(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleProjectsSelect: no guild')
      return
    }
    const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
    if (!state || state.step !== STEP_REPOS_PROJECTS) {
      console.error('[create-task] handleProjectsSelect: wrong step or no state', state?.step)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }
    const nextState = { ...state, projectIds: interaction.values || [] }
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, nextState)
    await showReposProjectsStep(interaction, nextState, guild)
  } catch (e) {
    console.error('[create-task] handleProjectsSelect error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleReposNext(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleReposNext: no guild')
      return
    }
    const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
    if (!state || state.step !== STEP_REPOS_PROJECTS) {
      console.error('[create-task] handleReposNext: wrong step or no state', state?.step)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }
    const nextState = { ...state, step: STEP_CONFIRM }
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, nextState)
    await showConfirmStep(interaction, nextState, guild)
  } catch (e) {
    console.error('[create-task] handleReposNext error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

async function showMembersStep(interaction, state, guild) {
  try {
    const membersCollection = await guild.members.fetch()
    const members = Array.from(membersCollection.values())
      .filter((m) => !m.user.bot)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .slice(0, 24)
    const options = members.map((m) => ({ label: m.displayName.slice(0, 100), value: m.id, description: `@${m.user.username}`.slice(0, 100) }))

    const embed = new EmbedBuilder()
    .setTitle('Create bug task')
    .setDescription('Select members to **tag** (optional). Then click **Next**.')
    .addFields(
      { name: 'Title', value: state.title?.slice(0, 100) || '—', inline: true },
      { name: 'Repo', value: state.repo?.name || '—', inline: true }
    )
    .setColor(0xed4245)
    .setFooter({ text: 'Step 4 — Tag members' })

  const select = new StringSelectMenuBuilder().setCustomId('create_task_members').setPlaceholder('Tag members (optional)').setMinValues(0).setMaxValues(options.length).addOptions(options)
  const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('create_task_members_next').setLabel('Next — confirm').setStyle(ButtonStyle.Primary))

    await respond(interaction, { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), row2] })
  } catch (e) {
    console.error('[create-task] showMembersStep error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleMembersSelect(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleMembersSelect: no guild')
      return
    }
    const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
    if (!state || state.step !== STEP_MEMBERS) {
      console.error('[create-task] handleMembersSelect: wrong step or no state', state?.step)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }
    const nextState = { ...state, taggedMemberIds: interaction.values || [] }
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, nextState)
    await showMembersStep(interaction, nextState, guild)
  } catch (e) {
    console.error('[create-task] handleMembersSelect error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleMembersNext(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleMembersNext: no guild')
      return
    }
    const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
    if (!state || state.step !== STEP_MEMBERS) {
      console.error('[create-task] handleMembersNext: wrong step or no state', state?.step)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }
    const nextState = { ...state, step: STEP_CONFIRM }
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, nextState)
    await showConfirmStep(interaction, nextState, guild)
  } catch (e) {
    console.error('[create-task] handleMembersNext error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

/** The confirm step's assignee picker. Exported for its test. */
export function assigneeRow(state = {}) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId('create_task_assignees')
    .setPlaceholder('Assignees (optional) — pick anyone on the server')
    .setMinValues(0)
    .setMaxValues(25)
  const current = (state.assigneeIds || []).filter(Boolean).slice(0, 25)
  if (current.length) menu.setDefaultUsers(current)
  return new ActionRowBuilder().addComponents(menu)
}

async function showConfirmStep(interaction, state, guild) {
  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    const isFeature = state.taskType === 'feature'

    const embed = new EmbedBuilder()
    .setTitle(`Confirm ${isFeature ? 'feature' : 'bug'} task`)
    .setDescription('Review and click **Create**. Criteria (API/QA/AC) can be updated later with **/update-task**.')
    .addFields(
      { name: 'Title', value: state.title?.slice(0, 100) || '—', inline: true },
      { name: 'Type', value: isFeature ? 'Feature' : 'Bug', inline: true },
      { name: 'Scope', value: scopeLabel(state.scope) || '—', inline: true },
      { name: 'Description', value: (state.description || '—').slice(0, 200), inline: false }
    )
    .setColor(isFeature ? 0x5865f2 : 0xed4245)
    .setFooter({ text: 'Step — Confirm & create' })

  if (isFeature) {
    const assignees = state.assigneeIds || []
    embed.addFields(
      { name: 'Assignees', value: assignees.length ? assignees.map((id) => `<@${id}>`).join(' ') : 'None', inline: true },
      { name: 'Repos / Projects', value: `${state.repositoryIds?.length || 0} repos, ${state.projectIds?.length || 0} projects`, inline: true }
    )
  } else {
    const tagged = state.taggedMemberIds || []
    embed.addFields({ name: 'Tagged', value: tagged.length ? tagged.map((id) => `<@${id}>`).join(' ') : 'None', inline: true })
  }

  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('create_task_create').setLabel('Create task').setStyle(ButtonStyle.Success),
    ...(isFeature ? [new ButtonBuilder().setCustomId('create_task_edit').setLabel('Edit details').setStyle(ButtonStyle.Secondary)] : []),
    new ButtonBuilder().setCustomId('create_task_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  )
  const components = isFeature ? [assigneeRow(state), rowButtons] : [rowButtons]
  await respond(interaction, { embeds: [embed], components })
  } catch (e) {
    console.error('[create-task] showConfirmStep error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

async function handleMetricSelect(interaction, key) {
  try {
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleMetricSelect: no guild')
      return
    }
    const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
    if (!state || state.step !== STEP_CONFIRM) {
      console.error('[create-task] handleMetricSelect: wrong step or no state', state?.step)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }
    const value = interaction.values?.[0]
    const nextState = { ...state, [key]: value === 'yes' }
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, nextState)
    await showConfirmStep(interaction, nextState, guild)
  } catch (e) {
    console.error('[create-task] handleMetricSelect error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleMetricApi(interaction) { return handleMetricSelect(interaction, 'hasApiTest') }
export async function handleMetricQa(interaction) { return handleMetricSelect(interaction, 'hasQaTest') }
export async function handleMetricAc(interaction) { return handleMetricSelect(interaction, 'hasAc') }

export async function handleAssigneesSelect(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleAssigneesSelect: no guild')
      return
    }
    const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
    if (!state || state.step !== STEP_CONFIRM) {
      console.error('[create-task] handleAssigneesSelect: wrong step or no state', state?.step)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }
    const assigneeIds = (interaction.values || []).filter((id) => id !== 'none')
    const nextState = { ...state, assigneeIds }
    flowStore.set(interaction.user.id, guild.id, FLOW_KEY, nextState)
    await showConfirmStep(interaction, nextState, guild)
  } catch (e) {
    console.error('[create-task] handleAssigneesSelect error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleEditButton(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) {
      console.error('[create-task] handleEditButton: no guild')
      return
    }
    const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
    if (!state || state.taskType !== 'feature') {
      console.error('[create-task] handleEditButton: missing state or not feature', state?.taskType)
      await respond(interaction, { content: SESSION_EXPIRED_MSG, components: [] }).catch(() => {})
      return
    }
    await interaction.showModal(buildTaskModal(true))
  } catch (e) {
    console.error('[create-task] handleEditButton error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

/**
 * What the reply says about where the new channel went, and why it is not in
 * the project's section when it is not. Spec §4 and §11 both require the reply
 * to say so: a channel diverted to the global Features category otherwise looks
 * exactly like one that landed where the project asked for it. Pure.
 *
 * @param {string} mention  the channel, as `<#id>`
 * @param {{name?: string}|null} project  the project the task was filed under
 * @param {'cap'|'missing'|null} fellBack  why it is not in that project's section
 */
export function channelPlacementNote(mention, project, fellBack) {
  const close = 'Use **/close-feature** there when done.'
  const name = project?.name ?? null
  if (!name) return `Channel: ${mention}\n${close}`
  if (fellBack === 'cap') {
    return `Channel: ${mention}\n**${name}**'s section is at Discord's ${CATEGORY_SOFT_CAP}-channel cap, so this went to the global **Features** category instead.\n${close}`
  }
  if (fellBack === 'missing') {
    return `Channel: ${mention}\n**${name}** has no Discord section yet, so this went to the global **Features** category. Run **/project-setup** for it to give it one.\n${close}`
  }
  return `Channel: ${mention} — in **${name}**'s section.\n${close}`
}

/**
 * `db`, `getConfig` and `createChannel` are seams. The root `.env` points at
 * the PRODUCTION database (`.claude/rules/tests-never-touch-production.md`), so
 * the largest user-visible branch in this command could not be tested at all
 * while it reached for the module-level `db` and `getOrCreateGuildConfig`.
 */
export async function handleCreate(
  interaction,
  { db: dbArg = db, getConfig = getOrCreateGuildConfig, createChannel = createTaskTicketChannel, openIssue = createIssue } = {}
) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, FLOW_KEY)
  if (!state || state.step !== STEP_CONFIRM) return respond(interaction, { content: 'Session expired. Run **/create-task** again.', components: [] })

  const cfg = await getConfig(guild.id)
  const isFeature = state.taskType === 'feature'

  try {
    // Tasks belong to the real `project` table (Framework, Badar HMS, CSAAS),
    // not `projectschema`, which is a dump-versioning table with no rows.
    const firstProject = isFeature && state.projectIds?.[0]
      ? await dbArg.project.findFirst({ where: { id: state.projectIds[0] } })
      : null
    const fields = {
      type: isFeature ? 'feature' : 'bug',
      title: state.title,
      description: state.description ?? null,
      scope: state.scope ?? null,
      modules: state.modules || [],
      holderIds: isFeature ? (state.assigneeIds || []) : (state.taggedMemberIds || []),
      repositoryIds: isFeature ? (state.repositoryIds || []) : [],
      tracks: { apiTests: state.hasApiTest === true, qaTests: state.hasQaTest === true, acceptanceCriteria: state.hasAc === true },
    }
    const { channel, fellBack, issueUrl } = await createTask({
      db: dbArg, guild, cfg, fields,
      project: firstProject,
      // Carries state.repositoryId even without state.repo, as the old code wrote it.
      repo: isFeature || (!state.repositoryId && !state.repo)
        ? null
        : { ...(state.repo || {}), id: state.repositoryId ?? state.repo?.id ?? null },
      actor: { discordId: interaction.user.id },
      createChannel, openIssue,
    })
    flowStore.clear(interaction.user.id, guild.id, FLOW_KEY)
    if (isFeature) {
      await respond(interaction, {
        embeds: [new EmbedBuilder().setTitle('Feature task created').setDescription(channelPlacementNote(`<#${channel.id}>`, firstProject, fellBack)).setColor(0x57f287)],
        components: [],
      })
    } else {
      await respond(interaction, {
        embeds: [new EmbedBuilder().setTitle('Bug task created').setDescription(`Channel: ${channel}${issueUrl ? `\nIssue: ${issueUrl}` : ''}`).setColor(0x57f287)],
        components: [],
      })
    }
  } catch (e) {
    console.error('Create-task error:', e)
    await respond(interaction, { content: `Failed: ${e?.message ?? String(e)}`, components: [], embeds: [] })
  }
}

export async function handleCancel(interaction) {
  try {
    if (interaction.guild) flowStore.clear(interaction.user.id, interaction.guild.id, FLOW_KEY)
    await respond(interaction, { content: 'Task creation cancelled.', components: [], embeds: [] })
  } catch (e) {
    console.error('[create-task] handleCancel error:', e)
    await respond(interaction, { content: `Error: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}
