import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'

export const data = new SlashCommandBuilder()
  .setName('clock-in')
  .setDescription('Clock in to start tracking your time')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  const active = await db.clockEntry.findActive(guild.id, interaction.user.id)
  if (active) {
    return interaction.editReply({ content: `You are already clocked in since **${new Date(active.clockInAt).toLocaleString()}**. Use **/clock-out** first.` })
  }

  await db.clockEntry.create({
    data: {
      guildConfigId: cfg.id,
      discordId: interaction.user.id,
      clockInAt: new Date(),
    },
  })
  if (cfg.clockedInRoleId) {
    const member = interaction.member ?? await guild.members.fetch(interaction.user.id).catch(() => null)
    if (member) await member.roles.add(cfg.clockedInRoleId).catch(() => {})
  }
  await interaction.editReply({ content: `**Clocked in** at ${new Date().toLocaleString()}. Use **/clock-out** when you finish.` })
}
