import { EmbedBuilder, SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { isLeadershipFor } from '../utils/timeAccess.js'
import { isValidZone } from '../utils/timezone.js'
import { formatDuration, rangeFor, sumByPerson, sumByTask } from '../utils/timeTracking.js'
import { FETCH_LIMIT } from '../services/timePanel.js'
import { autocomplete as taskAutocomplete, GENERAL } from './clock-in.js'
import { projectChoices } from './update-task.js'

export const data = new SlashCommandBuilder()
  .setName('time-report')
  .setDescription("The team's tracked time by person, project and task (CEO and Server Manager only)")
  .addUserOption((o) =>
    o.setName('person').setDescription('Only this person').setRequired(false))
  .addStringOption((o) =>
    o.setName('project').setDescription('Only tasks of this project').setRequired(false).setAutocomplete(true))
  .addStringOption((o) =>
    o.setName('task').setDescription('Only this task (or general work)').setRequired(false).setAutocomplete(true))
  .addStringOption((o) =>
    o.setName('range').setDescription('How far back to look (default: this week)').setRequired(false).addChoices(
      { name: 'Today', value: 'today' },
      { name: 'This week', value: 'week' },
      { name: 'This month', value: 'month' },
      { name: 'All time', value: 'all' },
    ))

export const NOT_LEADERSHIP = "Only CEO and Server Manager can view the team's time."

const LISTED = 10 // rows per list
const NO_TIME = 'No time logged for these filters.'
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
const isClosed = (e) => e && e.minutes !== null && e.minutes !== undefined

/**
 * A list as one field value: the top LISTED lines and an "and N more" tail, at
 * most 1024 characters. When they do not fit, whole lines are dropped from the
 * end (and counted into N) so the tail always survives and no line is cut.
 */
function listField(name, lines) {
  const shown = lines.slice(0, LISTED)
  let value = ''
  for (;;) {
    const hidden = lines.length - shown.length
    value = shown.join('\n') + (hidden ? `${shown.length ? '\n' : ''}…and ${hidden} more` : '')
    if (value.length <= 1024 || !shown.length) break
    shown.pop()
  }
  return { name, value: clip(value, 1024), inline: false }
}

const largestFirst = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])

// ----------------------------------------------------------------- payload ----

/**
 * The report message: ONE embed. Pure apart from building discord.js objects.
 * Only closed entries count. `filters` is `{ label, person?, project?, task? }`
 * (display text); `truncated` and `running` add a note to the description.
 */
export function buildReportPayload({ entries, tasks, projects, filters = {}, nameFor = () => null, truncated = false, running = 0 }) {
  const closed = (entries || []).filter(isClosed)
  const taskById = new Map((tasks || []).map((t) => [String(t.id), t]))
  const projectName = new Map((projects || []).map((p) => [String(p.id), String(p.name || p.id)]))
  const label = filters.label ?? ''

  const grand = closed.reduce((n, e) => n + Number(e.minutes), 0)
  const lines = [`**Total ${label}: ${formatDuration(grand)}**`]
  const scope = [
    filters.person && `person ${filters.person}`,
    filters.project && `project ${filters.project}`,
    filters.task && `task ${filters.task}`,
  ].filter(Boolean)
  if (scope.length) lines.push(`Filtered to ${scope.join(', ')}`)
  if (!closed.length) lines.push(NO_TIME)
  if (truncated) lines.push(`Limited to the latest ${FETCH_LIMIT} entries — narrow the range.`)
  if (running) lines.push(`${running} ${running === 1 ? 'timer' : 'timers'} still running (not counted).`)

  const embed = new EmbedBuilder()
    .setTitle(clip(`Time report — ${label}`, 250))
    .setColor(0x5865f2)
    .setDescription(clip(lines.join('\n'), 4000))
  if (!closed.length) return { embeds: [embed] }

  // Per person.
  const people = largestFirst(sumByPerson(closed)).map(([id, m]) =>
    `• **${clip(nameFor(id) || `<@${id}>`, 60)}** — ${formatDuration(m)}`)
  embed.addFields(listField('By person', people))

  // Per project. A task with no project, or whose row is gone, is "No project";
  // an entry with no task is "General work".
  const perProject = new Map()
  const add = (key, m) => perProject.set(key, (perProject.get(key) ?? 0) + m)
  const byTask = sumByTask(closed)
  for (const [taskId, m] of byTask) {
    if (taskId === null) { add('general', m); continue }
    const projectId = taskById.get(String(taskId))?.projectId
    add(projectId && projectName.has(String(projectId)) ? `p:${projectId}` : 'none', m)
  }
  const projectLabel = (key) => (key === 'general' ? 'General work' : key === 'none' ? 'No project' : projectName.get(key.slice(2)))
  embed.addFields(listField('By project', largestFirst(perProject).map(([key, m]) =>
    `• **${clip(projectLabel(key), 60)}** — ${formatDuration(m)}`)))

  // Top tasks, with the estimate where one is set. General work is not a task.
  const taskLines = largestFirst(byTask).filter(([taskId]) => taskId !== null).map(([taskId, m]) => {
    const task = taskById.get(String(taskId))
    if (!task) return `• **Deleted task** — ${formatDuration(m)}`
    const title = clip(task.title || 'Untitled', 60)
    const estimate = Number(task.estimateMinutes)
    if (!(estimate > 0)) return `• **${title}** — ${formatDuration(m)}`
    const pct = Math.round((m / estimate) * 100)
    return `• **${title}** — ${formatDuration(m)} of ${formatDuration(estimate)} (${pct}%)${m > estimate ? ' — **over**' : ''}`
  })
  if (taskLines.length) embed.addFields(listField('Top tasks', taskLines))

  return { embeds: [embed] }
}

// ------------------------------------------------------------------ command ----

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig, now = new Date() } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  // The team's time is for leadership only, and is refused before any read.
  if (!isLeadershipFor(guild, interaction.member, cfg)) {
    return interaction.editReply({ content: NOT_LEADERSHIP })
  }

  const nameFor = (id) => guild.members.cache.get(id)?.displayName ?? null
  const person = interaction.options.getUser('person')
  const projectId = interaction.options.getString('project')
  const taskOption = interaction.options.getString('task')
  const generalOnly = taskOption === GENERAL
  const taskId = taskOption && !generalOnly ? taskOption : null
  const range = rangeFor(interaction.options.getString('range') ?? 'week', now, isValidZone(cfg.timezone) ? cfg.timezone : 'UTC')

  const where = { guildConfigId: cfg.id, since: range.since, until: range.until }
  if (person) where.discordId = person.id
  if (taskId) where.taskId = taskId
  const rows = (await dbArg.clockEntry.findMany({ where, take: FETCH_LIMIT })) || []

  const ids = [...new Set(rows.map((e) => e.taskId).filter(Boolean).map(String))]
  const [tasks, projects] = await Promise.all([
    ids.length ? dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids } }) : [],
    dbArg.project.findMany({ where: { guildConfigId: cfg.id } }),
  ])

  // The project and general-work filters run here, on the fetched rows.
  const projectOf = new Map((tasks || []).map((t) => [String(t.id), t.projectId ? String(t.projectId) : null]))
  const entries = rows.filter((e) => {
    if (generalOnly && e.taskId) return false
    if (projectId && (!e.taskId || projectOf.get(String(e.taskId)) !== String(projectId))) return false
    return true
  })

  const taskTitle = (tasks || []).find((t) => String(t.id) === String(taskId))?.title
  const filters = {
    label: range.label,
    person: person ? nameFor(person.id) || `<@${person.id}>` : null,
    project: projectId ? ((projects || []).find((p) => String(p.id) === String(projectId))?.name ?? 'unknown') : null,
    task: generalOnly ? 'general work' : taskId ? (taskTitle ?? 'unknown') : null,
  }

  return interaction.editReply(buildReportPayload({
    entries, tasks: tasks || [], projects: projects || [], filters, nameFor,
    truncated: rows.length === FETCH_LIMIT,
    running: entries.filter((e) => !isClosed(e)).length,
  }))
}

/** `project` offers projects, `task` the clock-in picker; nothing else has choices. */
export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  // Leadership only, decided before any database read: autocomplete never passes
  // through the command role gate, so without this every member could list projects.
  try {
    const cfg = await getConfig(interaction.guild.id)
    if (!cfg || !isLeadershipFor(interaction.guild, interaction.member, cfg)) return interaction.respond([]).catch(() => {})
  } catch (e) {
    console.error('[time-report] autocomplete gate:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
  const focused = interaction.options.getFocused(true)
  if (focused.name === 'task') return taskAutocomplete(interaction, { db: dbArg, getConfig })
  if (focused.name === 'project') {
    try {
      const cfg = await getConfig(interaction.guild.id)
      const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
      return interaction.respond(projectChoices(projects, focused.value, { withDetach: false })).catch(() => {})
    } catch (e) {
      console.error('[time-report] project autocomplete:', e?.message ?? e)
      return interaction.respond([]).catch(() => {})
    }
  }
  return interaction.respond([]).catch(() => {})
}
