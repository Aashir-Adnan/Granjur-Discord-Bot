import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { formatDuration } from '../utils/timeTracking.js'
import { closeEntry } from './clock-in.js'

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

  const active = await dbArg.clockEntry.findActive(guild.id, interaction.user.id)
  if (!active) {
    return interaction.editReply({ content: 'You are not clocked in. Use **/clock-in** first.' })
  }

  const note = String(interaction.options?.getString?.('note') ?? '').trim() || null
  const minutes = await closeEntry(dbArg, active, { at: new Date(), note })

  if (cfg.clockedInRoleId) {
    const member = interaction.member ?? await guild.members.fetch(interaction.user.id).catch(() => null)
    if (member) await member.roles.remove(cfg.clockedInRoleId).catch(() => {})
  }

  const session = formatDuration(minutes)
  if (!active.taskId) {
    return interaction.editReply({ content: `**Clocked out** of general work. Session: **${session}**.` })
  }

  const task = await dbArg.task.findFirst({ where: { id: active.taskId, guildConfigId: cfg.id } }).catch(() => null)
  // The total is a SQL SUM, not a sum over a capped list of entries, so a busy
  // task is never understated. The entry just closed is already included.
  let totalLine = ''
  try {
    const rows = await dbArg.clockEntry.sumByTask({ guildConfigId: cfg.id, taskIds: [active.taskId] })
    const total = (rows || []).reduce((n, r) => n + Number(r.minutes || 0), 0)
    totalLine = ` Task total: **${formatDuration(total)}**.`
  } catch (e) {
    console.error('[clock-out] task total:', e?.message ?? e)
  }
  await interaction.editReply({
    content: `**Clocked out** of **${task?.title ?? 'a task'}**. Session: **${session}**.${totalLine}`,
  })
}
