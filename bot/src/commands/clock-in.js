import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { isLeadershipFor, memberProjectIdsOf } from '../utils/timeAccess.js'
import { ClockError, clockIn, closeEntry } from '../services/clock.js'
import { clockableTasks } from '../utils/timeTaskPicker.js'
import { taskChoiceLabel, holdersOf } from '../utils/taskLabel.js'
import { formatDuration } from '../utils/timeTracking.js'

/** The "no task" sentinel: time logged against general work. */
export const GENERAL = '-'

export const data = new SlashCommandBuilder()
  .setName('clock-in')
  .setDescription('Start tracking your time against a task')
  .addStringOption((o) =>
    o.setName('task').setDescription('The task you are working on').setRequired(true).setAutocomplete(true))

// The clock rules live in services/clock.js; this command only words the reply.
// Re-exported so /clock-out, clockWatch and the reminder buttons keep importing it from here.
export { closeEntry }

const NOT_AVAILABLE = 'That task is not available to you.'

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  const picked = String(interaction.options.getString('task') ?? GENERAL).trim() || GENERAL

  let result
  try {
    result = await clockIn({
      db: dbArg,
      cfg,
      guild,
      discordId: interaction.user.id,
      taskId: picked === GENERAL ? null : picked,
      member: interaction.member,
    })
  } catch (e) {
    if (e instanceof ClockError) return interaction.editReply({ content: NOT_AVAILABLE })
    throw e
  }

  const target = result.task ? `**${result.task.title}**` : 'general work'
  if (result.outcome === 'unchanged') {
    const running = formatDuration(result.runningMinutes)
    return interaction.editReply({ content: `You are already clocked in on ${target} (running for **${running}**). Nothing changed.` })
  }
  const content = result.stopped
    ? `Stopped **${result.stopped.title}** (${formatDuration(result.stopped.minutes)}) · started ${target}. Use **/clock-out** when you finish.`
    : `**Clocked in** on ${target}. Use **/clock-out** when you finish.`
  await interaction.editReply({ content })
}

export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  try {
    const cfg = await getConfig(interaction.guild.id)
    const general = { name: 'No task — general work', value: GENERAL }
    const rows = await dbArg.task.findMany({ where: { guildConfigId: cfg.id }, orderBy: { updatedAt: 'desc' }, take: 200 })
    const tasks = clockableTasks(rows, {
      memberProjectIds: await memberProjectIdsOf(dbArg, cfg, interaction.user.id),
      isLeadership: isLeadershipFor(interaction.guild, interaction.member, cfg),
      callerId: interaction.user.id,
    })

    // Members are resolved from cache only — autocomplete has ~3 seconds and a
    // fetch per assignee would blow it. An unresolved id shows as the id.
    const nameFor = (id) => interaction.guild.members.cache.get(id)?.displayName ?? null
    const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } }).catch(() => [])
    const projectNames = new Map((projects || []).map((p) => [String(p.id), String(p.name || '')]))
    const projectNameOf = (t) => projectNames.get(String(t.projectId ?? '')) ?? null

    const term = String(interaction.options.getFocused() || '').trim().toLowerCase()
    const matches = tasks.filter((t) => {
      if (!term) return true
      if (String(t.title || '').toLowerCase().includes(term)) return true
      if (String(t.status || '').toLowerCase() === term) return true
      if (String(projectNameOf(t) || '').toLowerCase().includes(term)) return true
      return holdersOf(t).some((id) => String(nameFor(id) || '').toLowerCase().includes(term))
    })

    const choices = matches.slice(0, 24).map((t) => ({
      name: taskChoiceLabel(t, { nameFor, projectName: projectNameOf(t) }),
      value: t.id,
    }))
    return interaction.respond([general, ...choices]).catch(() => {})
  } catch (e) {
    console.error('[clock-in] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
