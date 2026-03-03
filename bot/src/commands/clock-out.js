import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'

export const data = new SlashCommandBuilder()
  .setName('clock-out')
  .setDescription('Clock out to stop tracking your time')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  const active = await db.clockEntry.findActive(guild.id, interaction.user.id)
  if (!active) {
    return interaction.editReply({ content: 'You are not clocked in. Use **/clock-in** first.' })
  }

  const now = new Date()
  await db.clockEntry.update(active.id, { clockOutAt: now })
  if (cfg.clockedInRoleId) {
    const member = interaction.member ?? await guild.members.fetch(interaction.user.id).catch(() => null)
    if (member) await member.roles.remove(cfg.clockedInRoleId).catch(() => {})
  }
  const mins = Math.round((now - new Date(active.clockInAt)) / 60000)
  await interaction.editReply({ content: `**Clocked out** at ${now.toLocaleString()}. Session: **${mins}** minutes.` })
}
