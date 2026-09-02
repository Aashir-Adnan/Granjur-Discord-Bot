import {
  SlashCommandBuilder,
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
import * as flowStore from '../flows/store.js'
import { slugify } from '../utils/docPath.js'

export const data = new SlashCommandBuilder()
  .setName('projects')
  .setDescription('(CEO/Server Manager) List projects, add a project, link a repo')

async function listPayload(cfg) {
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  const counts = await db.docPage.countsByProject({ guildConfigId: cfg.id })
  const byId = new Map(counts.map((c) => [c.projectId, Number(c.n)]))

  const embed = new EmbedBuilder()
    .setTitle('Projects')
    .setColor(0x5865f2)
    .setDescription(
      projects.length
        ? projects
            .map((p) => `**${p.name}** — \`${p.docsSlug || slugify(p.name)}\` — ${byId.get(p.id) || 0} doc page(s)`)
            .join('\n')
        : '_No projects yet._'
    )

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('projects_add').setLabel('Add project').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('projects_link_repo').setLabel('Link repo').setStyle(ButtonStyle.Secondary)
  )

  return { embeds: [embed], components: [row], content: null }
}

export async function execute(interaction) {
  if (!interaction.guild) return interaction.editReply({ content: 'Use this in a server.' })
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  return interaction.editReply(await listPayload(cfg)).catch(() => {})
}

export async function handleAddButton(interaction) {
  const modal = new ModalBuilder().setCustomId('projects_add_modal').setTitle('Add project')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Project name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('slug')
        .setLabel('Docs folder under docs/projects/ (optional)')
        .setPlaceholder('leave blank to derive from the name')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('paths')
        .setLabel('Extra doc paths, comma separated (optional)')
        .setPlaceholder('hms-documentation')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
    )
  )
  return interaction.showModal(modal).catch(() => {})
}

export async function handleAddModal(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const cfg = await getOrCreateGuildConfig(guild.id)
  const name = interaction.fields.getTextInputValue('name').trim()
  const slug = (interaction.fields.getTextInputValue('slug') || '').trim() || slugify(name)
  const paths = (interaction.fields.getTextInputValue('paths') || '')
    .split(',')
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)

  const existing = await db.project.findByName({ guildConfigId: cfg.id, name })
  if (existing) {
    return interaction.editReply({ content: `**${name}** already exists.` }).catch(() => {})
  }

  await db.project.create({
    data: { guildConfigId: cfg.id, name, docsSlug: slug, docsPaths: paths },
  })

  return interaction
    .editReply({
      content: `Added **${name}** (docs folder \`docs/projects/${slug}/\`${paths.length ? `, plus ${paths.map((p) => `\`${p}\``).join(', ')}` : ''}). Run **/setup** → **Sync docs now** to attribute its pages.`,
    })
    .catch(() => {})
}

export async function handleLinkRepo(interaction) {
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
  if (repos.length === 0) {
    return interaction.editReply({ content: 'No repositories yet — add one with **/repos**.', components: [] }).catch(() => {})
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('projects_link_repo_select')
    .setPlaceholder('Choose a repository…')
    .addOptions(
      repos.slice(0, 25).map((r) => ({
        label: (r.name || '').slice(0, 100),
        value: r.id,
        description: (r.url || '').slice(0, 100),
      }))
    )
  return interaction
    .editReply({ content: 'Which repository?', embeds: [], components: [new ActionRowBuilder().addComponents(select)] })
    .catch(() => {})
}

export async function handleLinkRepoSelect(interaction) {
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  flowStore.set(interaction.user.id, interaction.guild.id, 'projects_link', { repositoryId: interaction.values[0] })
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  if (projects.length === 0) {
    return interaction.editReply({ content: 'No projects yet — add one first.', components: [] }).catch(() => {})
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('projects_link_project_select')
    .setPlaceholder('Choose a project…')
    .addOptions(projects.slice(0, 25).map((p) => ({ label: p.name.slice(0, 100), value: p.id })))
  return interaction
    .editReply({ content: 'Link it to which project?', components: [new ActionRowBuilder().addComponents(select)] })
    .catch(() => {})
}

export async function handleLinkProjectSelect(interaction) {
  const state = flowStore.get(interaction.user.id, interaction.guild.id, 'projects_link')
  if (!state?.repositoryId) {
    return interaction.editReply({ content: 'That selection expired — start again with /projects.', components: [] }).catch(() => {})
  }
  await db.projectRepos.add({ data: { project_id: interaction.values[0], repository_id: state.repositoryId } })
  flowStore.clear(interaction.user.id, interaction.guild.id, 'projects_link')
  return interaction.editReply({ content: 'Linked.', components: [] }).catch(() => {})
}
