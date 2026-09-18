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
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('edit-docs')
  .setDescription('Write a documentation page for a project (stored in the bot database)')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' }).catch(() => {})

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
  if (!guild) return interaction.reply({ content: 'Use this in a server.', flags: EPHEMERAL }).catch(() => {})
  flowStore.set(interaction.user.id, guild.id, 'edit_docs', { projectId: interaction.values[0] })

  const modal = new ModalBuilder().setCustomId('edit_docs_modal').setTitle('New documentation page')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Page title')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(200)
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
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' }).catch(() => {})
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
  const titleSlug = slugify(title)
  // A punctuation-only or wholly non-ASCII title slugifies to an empty string,
  // which would put every such page at the same path and silently overwrite the
  // last one.
  if (!titleSlug) {
    return interaction
      .editReply({
        content:
          'That title has no letters or digits to build a page address from. Use a title containing letters or digits.',
      })
      .catch(() => {})
  }
  const path = `docs/projects/${projectSlug}/${titleSlug}.md`
  const docId = toDocId(path)

  try {
    const existing = await db.docPage.findByDocId({ guildConfigId: cfg.id, docId })
    if (existing && existing.source === 'repo') {
      return interaction
        .editReply({
          content: `**${existing.title}** already lives at that path as a page synced from the documentation repository, so it can't be edited here. Choose a different title.`,
        })
        .catch(() => {})
    }

    // The read above is only there for the good error message: a sync can land
    // between it and this write. `upsertLocal` refuses to clobber a repo row in
    // the statement itself, so the race cannot replace an official page.
    await db.docPage.upsertLocal({
      data: {
        guildConfigId: cfg.id,
        path,
        docId,
        section: sectionOf(path),
        projectId: project.id,
        title,
        content: body,
        blobSha: null,
        size: body.length,
      },
    })

    flowStore.clear(interaction.user.id, guild.id, 'edit_docs')
    const verb = existing ? 'Updated' : 'Saved'
    return interaction
      .editReply({
        content: `${verb} **${title}** under **${project.name}**. Find it in **/docs**. It is stored in the bot only — it is not published to the docs site yet.`,
      })
      .catch(() => {})
  } catch (e) {
    return interaction
      .editReply({ content: `Could not save that page: ${e?.message ?? String(e)}` })
      .catch(() => {})
  }
}
