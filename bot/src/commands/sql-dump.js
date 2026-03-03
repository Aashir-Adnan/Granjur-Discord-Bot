import { SlashCommandBuilder } from 'discord.js'
import { getOrCreateGuildConfig } from '../db/index.js'

export const data = new SlashCommandBuilder()
  .setName('sql-dump')
  .setDescription('View, search, or edit versioned SQL dumps for projects (versioning + who changed what)')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  await interaction.editReply({
    content:
      '**SQL dump** — Versioned SQL dumps per project are planned. For now, use **#sql-dumps** and **/project-db** to view or store schema. Full versioning (who changed what) will be added in a future update.',
  })
}
