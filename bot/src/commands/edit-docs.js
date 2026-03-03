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
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('edit-docs')
  .setDescription('Edit project or repo documentation (README) — stored in database')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
  const schemas = await db.projectSchema.findMany({ where: { guildConfigId: cfg.id } })

  const options = []
  schemas.forEach((s) => {
    options.push({
      label: `Project: ${(s.projectName || s.projectId).slice(0, 100)}`,
      value: `schema:${s.projectId}`,
      description: 'Stored project',
    })
  })
  repos.forEach((r) => {
    options.push({
      label: `Repo: ${(r.name || '').slice(0, 100)}`,
      value: `repo:${r.id}`,
      description: (r.url || '').slice(0, 80),
    })
  })
  if (options.length === 0) {
    return interaction.editReply({ content: 'No projects or repos. Add repos with **/repos** or add a schema with **/project-db**.' })
  }

  const embed = new EmbedBuilder()
    .setTitle('Edit documentation')
    .setDescription('Select a project or repo to edit its README/documentation.')
    .setColor(0x5865f2)

  const select = new StringSelectMenuBuilder()
    .setCustomId('edit_docs_select')
    .setPlaceholder('Select project or repo…')
    .addOptions(options.slice(0, 25))

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  })
}

export async function handleEditDocsSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const value = interaction.values?.[0]
  if (!value) return

  flowStore.set(interaction.user.id, guild.id, 'edit_docs', { value })

  const modal = new ModalBuilder()
    .setCustomId('edit_docs_modal')
    .setTitle('Edit README / documentation')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('readme')
        .setLabel('README or documentation (Markdown)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Paste or type the content…')
        .setRequired(true)
        .setMaxLength(4000)
    )
  )
  await interaction.showModal(modal)
}

export async function handleEditDocsModal(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.' }).catch(() => {})

  const state = flowStore.get(interaction.user.id, guild.id, 'edit_docs')
  if (!state?.value) return interaction.editReply({ content: 'Session expired. Run **/edit-docs** again.' }).catch(() => {})

  const readme = interaction.fields.getTextInputValue('readme')?.trim() || ''

  try {
    if (state.value.startsWith('schema:')) {
      const projectId = state.value.slice('schema:'.length)
      const cfg = await getOrCreateGuildConfig(guild.id)
      const existing = await db.projectSchema.findFirst({
        where: { guildConfigId: cfg.id, projectId },
      })
      if (!existing) return interaction.editReply({ content: 'Project not found.' }).catch(() => {})

      await db.projectSchema.upsert({
        where: { guildConfigId_projectId: { guildConfigId: cfg.id, projectId } },
        create: {
          guildConfigId: cfg.id,
          projectId,
          projectName: existing.projectName || projectId,
          schemaContent: existing.schemaContent,
          readme,
        },
        update: { readme },
      })
    } else if (state.value.startsWith('repo:')) {
      const cfg = await getOrCreateGuildConfig(guild.id)
      const repoId = state.value.slice('repo:'.length)
      const repo = await db.repository.findFirst({
        where: { guildConfigId: cfg.id, id: repoId },
      })
      if (!repo) return interaction.editReply({ content: 'Repo not found.' }).catch(() => {})

      await db.projectSchema.upsert({
        where: { guildConfigId_projectId: { guildConfigId: cfg.id, projectId: repo.id } },
        create: {
          guildConfigId: cfg.id,
          projectId: repo.id,
          projectName: repo.name,
          schemaContent: '(no schema)',
          readme,
        },
        update: { readme },
      })
    }
    flowStore.clear(interaction.user.id, guild.id, 'edit_docs')
    await interaction.editReply({ content: 'Documentation updated. Use **#documentation** or **Refresh list** to view.' }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}` }).catch(() => {})
  }
}
