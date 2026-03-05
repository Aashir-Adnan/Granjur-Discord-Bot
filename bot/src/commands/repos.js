import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as flowStore from '../flows/store.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('repos')
  .setDescription('Manage repositories — add or list (use options to skip form)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('list').setDescription('List all repositories'))
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Add a repository (pass name & url in command to skip form)')
      .addStringOption((o) => o.setName('name').setDescription('Display name').setRequired(false).setMaxLength(100))
      .addStringOption((o) => o.setName('url').setDescription('Repository URL').setRequired(false))
      .addStringOption((o) => o.setName('project').setDescription('Project name (optional)').setRequired(false))
  )

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const sub = interaction.options.getSubcommand(false)
  if (sub === 'list') {
    const cfg = await getOrCreateGuildConfig(guild.id)
    const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
    const embed = new EmbedBuilder()
      .setTitle('Repositories')
      .setDescription(repos.length ? repos.map((r) => `• **${r.name}**: ${r.url}`).join('\n') : 'No repositories. Use **/repos add** to add one.')
      .setColor(0x5865f2)
    return interaction.editReply({ embeds: [embed], components: [] })
  }

  if (sub === 'add') {
    const nameOpt = interaction.options.getString('name')
    const urlOpt = interaction.options.getString('url')
    const projectOpt = interaction.options.getString('project') || null
    if (nameOpt && urlOpt) {
      const url = urlOpt.replace(/\/$/, '')
      flowStore.set(interaction.user.id, guild.id, 'repos_add', { name: nameOpt, url, project: projectOpt })
      const embed = new EmbedBuilder()
        .setTitle('Confirm add repository')
        .setDescription(`**${nameOpt}**\n${url}${projectOpt ? `\nProject: ${projectOpt}` : ''}`)
        .setColor(0x5865f2)
        .setFooter({ text: 'Step 2 of 2' })
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('repos_confirm_add').setLabel('Add').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('repos_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      )
      return interaction.editReply({ embeds: [embed], components: [row] })
    }
    const embed = new EmbedBuilder()
      .setTitle('Add repository')
      .setDescription('Click **Add repository** to open the form, or run `/repos add name:... url:...` to skip it.')
      .setColor(0x5865f2)
      .setFooter({ text: 'Step 1 of 2' })
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('repos_add').setLabel('Add repository').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('repos_list').setLabel('List repositories').setStyle(ButtonStyle.Secondary)
    )
    return interaction.editReply({ embeds: [embed], components: [row] })
  }

  const embed = new EmbedBuilder()
    .setTitle('Repositories')
    .setDescription('**Step 1:** Add a new repository or view the list. Use **/repos list** or **/repos add name:... url:...**.')
    .setColor(0x5865f2)
    .setFooter({ text: 'Step 1 of 2' })

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('repos_add').setLabel('Add repository').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('repos_list').setLabel('List repositories').setStyle(ButtonStyle.Secondary)
  )
  await interaction.editReply({ embeds: [embed], components: [row] })
}

export async function handleChoice(interaction) {
  const guild = interaction.guild
  if (!guild) return

  if (interaction.customId === 'repos_list') {
    const cfg = await getOrCreateGuildConfig(guild.id)
    const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
    const embed = new EmbedBuilder()
      .setTitle('Repositories')
      .setDescription(repos.length ? repos.map((r) => `• **${r.name}**: ${r.url}`).join('\n') : 'No repositories. Click **Add repository** to add one.')
      .setColor(0x5865f2)
    await interaction.editReply({ embeds: [embed], components: [] })
    return
  }

  if (interaction.customId === 'repos_add') {
    const modal = new ModalBuilder().setCustomId('repos_modal').setTitle('Add repository')
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('name').setLabel('Display name').setStyle(TextInputStyle.Short).setPlaceholder('e.g. frontend').setRequired(true).setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('url').setLabel('Repository URL').setStyle(TextInputStyle.Short).setPlaceholder('https://github.com/org/repo').setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('project').setLabel('Project name (optional)').setStyle(TextInputStyle.Short).setPlaceholder('My Project').setRequired(false)
      )
    )
    await interaction.showModal(modal)
  }
}

export async function handleAddModal(interaction) {
  const guild = interaction.guild
  if (!guild) return

  try {
    const g = await getOrCreateGuildConfig(guild.id)
    const name = interaction.fields.getTextInputValue('name')
    const url = interaction.fields.getTextInputValue('url').replace(/\/$/, '')
    const project = interaction.fields.getTextInputValue('project') || null

    flowStore.set(interaction.user.id, guild.id, 'repos_add', { name, url, project })

    const embed = new EmbedBuilder()
      .setTitle('Confirm add repository')
      .setDescription(`**${name}**\n${url}${project ? `\nProject: ${project}` : ''}`)
      .setColor(0x5865f2)
      .setFooter({ text: 'Step 2 of 2' })

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('repos_confirm_add').setLabel('Add').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('repos_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    )

    await interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}` }).catch(() => {})
  }
}

export async function handleConfirmAdd(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const state = flowStore.get(interaction.user.id, guild.id, 'repos_add')
  if (!state) return interaction.editReply({ content: 'Session expired.', components: [] }).catch(() => {})

  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    await db.repository.create({
      data: {
        guildConfigId: cfg.id,
        name: state.name,
        url: state.url,
      },
    })

    flowStore.clear(interaction.user.id, guild.id, 'repos_add')

    const embed = new EmbedBuilder()
      .setTitle('Repository added')
      .setDescription(`**${state.name}**: ${state.url}${state.project ? ` (${state.project})` : ''}`)
      .setColor(0x57f287)

    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleCancel(interaction) {
  flowStore.clear(interaction.user.id, interaction.guild?.id, 'repos_add')
  await interaction.editReply({ content: 'Cancelled.', components: [], embeds: [] }).catch(() => {})
}
