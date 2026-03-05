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
  .setName('project-db')
  .setDescription('View or save project database schema — select project or pass project_id + schema to skip form')
  .addStringOption((o) =>
    o.setName('project_id').setDescription('Project ID or name (use with schema to save without form)').setRequired(false).setMaxLength(100)
  )
  .addStringOption((o) =>
    o.setName('schema').setDescription('Schema content (SQL or text) to save').setRequired(false).setMaxLength(4000)
  )

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  const projectIdOpt = interaction.options.getString('project_id')
  const schemaOpt = interaction.options.getString('schema')
  if (projectIdOpt && projectIdOpt.trim() && schemaOpt !== null && schemaOpt !== undefined && schemaOpt.trim()) {
    try {
      await db.projectSchema.upsert({
        where: { guildConfigId_projectId: { guildConfigId: cfg.id, projectId: projectIdOpt.trim() } },
        create: { guildConfigId: cfg.id, projectId: projectIdOpt.trim(), projectName: projectIdOpt.trim(), schemaContent: schemaOpt.trim() },
        update: { schemaContent: schemaOpt.trim(), projectName: projectIdOpt.trim() },
      })
      return interaction.editReply({
        content: `Project **${projectIdOpt.trim()}** — schema saved (${schemaOpt.trim().length} chars).`,
      })
    } catch (e) {
      return interaction.editReply({ content: `Failed to save: ${e?.message ?? String(e)}` })
    }
  }

  const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
  const schemas = await db.projectSchema.findMany({ where: { guildConfigId: cfg.id } })

  const options = []
  schemas.forEach((s) => {
    options.push({
      label: `Schema: ${s.projectName || s.projectId}`,
      value: `schema:${s.projectId}`,
      description: 'Stored schema',
    })
  })
  repos.forEach((r) => {
    const name = r.name
    if (!options.some((o) => o.value === `repo:${r.id}`)) {
      options.push({
        label: `Project: ${name}`,
        value: `repo:${r.id}`,
        description: r.url.slice(0, 60),
      })
    }
  })
  if (!options.length) {
    return interaction.editReply({
      content: 'No projects or schemas. Add repos with **/repos** or save a schema (select "New project" in a moment).',
    })
  }
  options.push({ label: '+ New project (paste schema)', value: 'new', description: 'Store schema for a new project' })

  const embed = new EmbedBuilder()
    .setTitle('Project database schema')
    .setDescription('**Step 1:** Select a project to view its schema, or create a new one.')
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 1 of 2' })

  const select = new StringSelectMenuBuilder()
    .setCustomId('project_db_select')
    .setPlaceholder('Select project')
    .addOptions(options.slice(0, 25))

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  })
}

export async function handleProjectSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const value = interaction.values?.[0]
  if (!value) return

  if (value === 'new') {
    const modal = new ModalBuilder().setCustomId('project_db_schema_modal').setTitle('New project schema')
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('project_id').setLabel('Project ID or name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('schema').setLabel('Schema (SQL or text)').setStyle(TextInputStyle.Paragraph).setPlaceholder('CREATE TABLE...').setRequired(true)
      )
    )
    await interaction.showModal(modal)
    return
  }

  let schemaContent = null
  let projectName = value

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (value.startsWith('schema:')) {
    const projectId = value.slice('schema:'.length)
    const s = await db.projectSchema.findFirst({
      where: { guildConfigId: cfg.id, projectId },
    })
    if (s) {
      schemaContent = s.schemaContent
      projectName = s.projectName || s.projectId
    }
  } else if (value.startsWith('repo:')) {
    const repoId = value.slice('repo:'.length)
    const repo = await db.repository.findFirst({
      where: { guildConfigId: cfg.id, id: repoId },
    })
    if (repo) {
      projectName = repo.name
      const s = await db.projectSchema.findFirst({
        where: { guildConfigId: cfg.id, projectId: repo.id },
      })
      schemaContent = s?.schemaContent || `No schema stored for ${repo.name}. Use "New project" to paste one.`
    }
  }

  if (!schemaContent) {
    return interaction.editReply({ content: 'No schema found.', components: [], embeds: [] }).catch(() => {})
  }

  const embed = new EmbedBuilder()
    .setTitle(`Schema: ${projectName}`)
    .setDescription(`\`\`\`sql\n${schemaContent.slice(0, 3900)}${schemaContent.length > 3900 ? '\n...' : ''}\n\`\`\``)
    .setColor(0x5865f2)
    .setFooter({ text: `${schemaContent.length} chars` })

  await interaction.editReply({ embeds: [embed], components: [] })
}

export async function handleSchemaModal(interaction) {
  const guild = interaction.guild
  if (!guild) return
  try {
    const projectId = interaction.fields.getTextInputValue('project_id').trim()
    const schemaContent = interaction.fields.getTextInputValue('schema').trim()

    const cfg = await getOrCreateGuildConfig(guild.id)
    await db.projectSchema.upsert({
      where: { guildConfigId_projectId: { guildConfigId: cfg.id, projectId } },
      create: { guildConfigId: cfg.id, projectId, projectName: projectId, schemaContent },
      update: { schemaContent, projectName: projectId },
    })

    const embed = new EmbedBuilder()
      .setTitle('Schema saved')
      .setDescription(`Project **${projectId}** — ${schemaContent.length} chars stored.`)
      .setColor(0x57f287)

    await interaction.editReply({ embeds: [embed] }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}` }).catch(() => {})
  }
}
