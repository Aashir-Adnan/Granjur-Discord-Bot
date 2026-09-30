import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { formatDuration } from '../utils/timeTracking.js'
import { ClockError, clockOut } from '../services/clock.js'

export const data = new SlashCommandBuilder()
  .setName('clock-out')
  .setDescription('Stop tracking your time')
  .addStringOption((o) =>
    o.setName('note').setDescription('What you got done (optional)').setRequired(false).setMaxLength(500))

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  let result
  try {
    result = await clockOut({
      db: dbArg,
      cfg,
      guild,
      discordId: interaction.user.id,
      note: interaction.options?.getString?.('note'),
      member: interaction.member,
    })
  } catch (e) {
    if (e instanceof ClockError) return interaction.editReply({ content: 'You are not clocked in. Use **/clock-in** first.' })
    throw e
  }

  const session = formatDuration(result.minutes)
  if (!result.task) {
    return interaction.editReply({ content: `**Clocked out** of general work. Session: **${session}**.` })
  }
  const totalLine = result.taskTotalMinutes === null ? '' : ` Task total: **${formatDuration(result.taskTotalMinutes)}**.`
  await interaction.editReply({
    content: `**Clocked out** of **${result.task.title}**. Session: **${session}**.${totalLine}`,
  })
}
