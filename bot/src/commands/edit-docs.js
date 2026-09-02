import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as flowStore from '../flows/store.js'
import { slugify, toDocId, sectionOf } from '../utils/docPath.js'

export const data = new SlashCommandBuilder()
  .setName('edit-docs')
  .setDescription('Write a documentation page for a project (stored in the bot database)')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  if (projects.length === 0) {
    return interaction
      .editReply({ content: 'No projects yet. A manager can add one with **/projects**.' })
      .catch(() => {})
  }

  const embed = new EmbedBuilder()
    .setTitle('Write documentation')
    .setDescription(
      'Choose the project this page belongs to. The page is stored in the bot database and appears in **/docs** under that project.'
    )
    .setColor(0x5865f2)

  const select = new StringSelectMenuBuilder()
    .setCustomId('edit_docs_select')
    .setPlaceholder('Select a project…')
    .addOptions(projects.slice(0, 25).map((p) => ({ label: p.name.slice(0, 100), value: p.id })))

  return interaction
    .editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] })
    .catch(() => {})
}

export async function handleEditDocsSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  flowStore.set(interaction.user.id, guild.id, 'edit_docs', { projectId: interaction.values[0] })

  const modal = new ModalBuilder().setCustomId('edit_docs_modal').setTitle('New documentation page')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Page title')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('body')
        .setLabel('Markdown content')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
    )
  )
  return interaction.showModal(modal).catch(() => {})
}

export async function handleEditDocsModal(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const cfg = await getOrCreateGuildConfig(guild.id)
  const state = flowStore.get(interaction.user.id, guild.id, 'edit_docs')
  if (!state?.projectId) {
    return interaction.editReply({ content: 'That flow expired — run /edit-docs again.' }).catch(() => {})
  }

  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  const project = projects.find((p) => p.id === state.projectId)
  if (!project) {
    return interaction.editReply({ content: 'That project no longer exists.' }).catch(() => {})
  }

  const title = interaction.fields.getTextInputValue('title').trim()
  const body = interaction.fields.getTextInputValue('body')
  const projectSlug = project.docsSlug || slugify(project.name)
  const path = `docs/projects/${projectSlug}/${slugify(title)}.md`

  await db.docPage.upsert({
    data: {
      guildConfigId: cfg.id,
      path,
      docId: toDocId(path),
      section: sectionOf(path),
      projectId: project.id,
      title,
      content: body,
      source: 'local',
      blobSha: null,
      size: body.length,
    },
  })

  flowStore.clear(interaction.user.id, guild.id, 'edit_docs')
  return interaction
    .editReply({
      content: `Saved **${title}** under **${project.name}**. Find it in **/docs**. It is stored in the bot only — it is not published to the docs site yet.`,
    })
    .catch(() => {})
}
