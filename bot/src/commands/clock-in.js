import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'
import { memberPassesRoleGate, LEADERSHIP_ROLE_NAMES } from '../utils/roleGate.js'
import { clockableTasks } from '../utils/timeTaskPicker.js'
import { taskChoiceLabel, holdersOf } from '../utils/taskLabel.js'
import { entryMinutes, formatDuration } from '../utils/timeTracking.js'

/** The "no task" sentinel: time logged against general work. */
export const GENERAL = '-'

export const data = new SlashCommandBuilder()
  .setName('clock-in')
  .setDescription('Start tracking your time against a task')
  .addStringOption((o) =>
    o.setName('task').setDescription('The task you are working on').setRequired(true).setAutocomplete(true))

/** Close an open entry, writing its duration. Shared with /clock-out. */
export async function closeEntry(dbArg, entry, { at = new Date(), note = null, source } = {}) {
  const minutes = entryMinutes(entry.clockInAt, at)
  const data = { clockOutAt: at, minutes }
  if (note) data.note = note
  if (source) data.source = source
  await dbArg.clockEntry.update(entry.id, data)
  return minutes
}

const NOT_AVAILABLE = 'That task is not available to you.'

function isLeadershipFor(interaction, cfg) {
  return memberPassesRoleGate(
    interaction.guild,
    interaction.member,
    ensureStringArray(cfg.dashboardRoleIds),
    LEADERSHIP_ROLE_NAMES,
  )
}

async function memberProjectIdsOf(dbArg, cfg, discordId) {
  const rows = await dbArg.projectMember.findByMember({ where: { guildConfigId: cfg.id, discordId } })
  return (rows || []).map((r) => r.projectId)
}

/** A task's title for a reply, or a plain fallback when it cannot be found. */
async function titleOf(dbArg, cfg, taskId) {
  if (!taskId) return 'general work'
  const task = await dbArg.task.findFirst({ where: { id: taskId, guildConfigId: cfg.id } }).catch(() => null)
  return task?.title ?? 'a task'
}

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  const picked = String(interaction.options.getString('task') ?? GENERAL).trim() || GENERAL
  const userId = interaction.user.id

  // Resolve the chosen task, and refuse one the caller may not clock into. A
  // task that does not exist and one the caller cannot use get the same
  // message, so this cannot be used to probe for tasks.
  let task = null
  if (picked !== GENERAL) {
    task = await dbArg.task.findFirst({ where: { id: picked, guildConfigId: cfg.id } })
    const allowed = task
      ? clockableTasks([task], {
          memberProjectIds: await memberProjectIdsOf(dbArg, cfg, userId),
          isLeadership: isLeadershipFor(interaction, cfg),
          callerId: userId,
        }).length > 0
      : false
    if (!allowed) return interaction.editReply({ content: NOT_AVAILABLE })
  }
  const taskId = task ? task.id : null

  const active = await dbArg.clockEntry.findActive(guild.id, userId)
  const now = new Date()

  if (active && (active.taskId ?? null) === taskId) {
    const running = formatDuration(entryMinutes(active.clockInAt, now))
    const label = task ? `**${task.title}**` : 'general work'
    return interaction.editReply({ content: `You are already clocked in on ${label} (running for **${running}**). Nothing changed.` })
  }

  let stopped = null
  if (active) {
    const minutes = await closeEntry(dbArg, active, { at: now })
    stopped = `**${await titleOf(dbArg, cfg, active.taskId ?? null)}** (${formatDuration(minutes)})`
  }

  await dbArg.clockEntry.create({
    data: {
      guildConfigId: cfg.id,
      discordId: userId,
      clockInAt: now,
      taskId,
      source: 'timer',
    },
  })

  // Switching tasks keeps the person clocked in, so the role is left alone.
  if (!active && cfg.clockedInRoleId) {
    const member = interaction.member ?? await guild.members.fetch(userId).catch(() => null)
    if (member) await member.roles.add(cfg.clockedInRoleId).catch(() => {})
  }

  const target = task ? `**${task.title}**` : 'general work'
  const content = stopped
    ? `Stopped ${stopped} · started ${target}. Use **/clock-out** when you finish.`
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
      isLeadership: isLeadershipFor(interaction, cfg),
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
