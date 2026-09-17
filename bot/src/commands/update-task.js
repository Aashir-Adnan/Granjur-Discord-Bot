import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { taskChoiceLabel, holdersOf, idList } from '../utils/taskLabel.js'
import { wouldCycle, openBlockers, blockerWarning } from '../utils/taskDeps.js'
import { notifyTaskUpdate } from '../services/taskUpdateNotify.js'

/** Parse space-separated @mentions or Discord user IDs into array of IDs. */
function parseUserIds(str) {
  if (!str || !str.trim()) return []
  const ids = new Set()
  const re = /<@!?(\d+)>|(\d{17,19})/g
  let m
  while ((m = re.exec(str)) !== null) ids.add(m[1] || m[2])
  return [...ids]
}

const STATUS_CHOICES = [
  { name: 'Open', value: 'open' },
  { name: 'Pending', value: 'pending' },
  { name: 'In progress', value: 'in_progress' },
  { name: 'Resolved', value: 'resolved' },
  { name: 'Closed', value: 'closed' },
  { name: 'Done', value: 'done' },
]

export const data = new SlashCommandBuilder()
  .setName('update-task')
  .setDescription('Update a task — pick it from the list, then set any field')
  .addStringOption((o) =>
    o
      .setName('task')
      .setDescription('Start typing a title — pick the task from the list')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((o) =>
    o.setName('status').setDescription('New status').setRequired(false).addChoices(...STATUS_CHOICES)
  )
  .addIntegerOption((o) =>
    o.setName('passed_api_tests').setDescription('Number of API tests passed (null = N/A)').setRequired(false).setMinValue(0)
  )
  .addIntegerOption((o) =>
    o.setName('passed_qa_tests').setDescription('Number of QA tests passed').setRequired(false).setMinValue(0)
  )
  .addIntegerOption((o) =>
    o.setName('passed_acceptance_criteria').setDescription('Number of AC passed').setRequired(false).setMinValue(0)
  )
  .addStringOption((o) =>
    o.setName('title').setDescription('New title').setRequired(false).setMaxLength(200)
  )
  .addStringOption((o) =>
    o.setName('description').setDescription('New description').setRequired(false).setMaxLength(2000)
  )
  .addStringOption((o) =>
    o.setName('assignees').setDescription('Assignees: @mentions or user IDs, space-separated').setRequired(false).setMaxLength(500)
  )
  .addStringOption((o) =>
    o.setName('implementation_status').setDescription('Implementation status').setRequired(false).addChoices(
      { name: 'Not started', value: 'not_started' },
      { name: 'In progress', value: 'in_progress' },
      { name: 'Done', value: 'done' }
    )
  )
  .addStringOption((o) =>
    o
      .setName('project')
      .setDescription('Attach the task to a project (start typing a project name)')
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addUserOption((o) => o.setName('add_assignee').setDescription('Add one more assignee').setRequired(false))
  .addUserOption((o) => o.setName('remove_assignee').setDescription('Take one assignee off the task').setRequired(false))
  .addStringOption((o) => o.setName('blocked_by').setDescription('This task cannot proceed until that task is done (pick from the list)').setRequired(false).setAutocomplete(true))
  .addStringOption((o) => o.setName('unblock').setDescription('Remove a blocker from this task (pick from the list)').setRequired(false).setAutocomplete(true))

/** Sentinel value for "detach from any project" in the project picker. */
export const NO_PROJECT = 'none'

/** Next assignee list, or null when no assignee option was given. Pure. */
export function nextAssignees(current, { replace, add, remove } = {}) {
  if (replace === undefined && !add && !remove) return null
  const out = new Set(idList(replace !== undefined ? replace : current))
  if (add) out.add(String(add))
  if (remove) out.delete(String(remove))
  return [...out]
}

/**
 * Record / remove one dependency for `task`. Validates before writing, so a
 * refused change leaves the table untouched.
 * @returns {{ lines: string[], error: string|null }}
 */
export async function applyDependencyChange({ db: dbArg, cfg, task, blockedById = null, unblockId = null, actorId = null }) {
  const lines = []
  if (blockedById) {
    if (String(blockedById) === String(task.id)) return { lines, error: 'A task cannot be blocked by itself.' }
    const [blocker] = await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids: [blockedById] } })
    if (!blocker) return { lines, error: `No task matches **${String(blockedById).slice(0, 80)}**. Start typing a title and pick one from the list.` }
    const deps = await dbArg.taskDependency.findManyForGuild({ where: { guildConfigId: cfg.id } })
    if (wouldCycle(task.id, blocker.id, deps)) {
      const b = blocker.title || blocker.id
      const t = task.title || task.id
      return { lines, error: `**${b}** already depends on **${t}**, so **${t}** cannot be blocked by **${b}**.` }
    }
    await dbArg.taskDependency.add({ data: { guildConfigId: cfg.id, taskId: task.id, blockedByTaskId: blocker.id, createdBy: actorId } })
    lines.push(`**Blocked by:** ${blocker.title || blocker.id}`)
  }
  if (unblockId) {
    const [blocker] = await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids: [unblockId] } })
    const { removed } = await dbArg.taskDependency.remove({ where: { taskId: task.id, blockedByTaskId: String(unblockId) } })
    const name = blocker?.title || unblockId
    lines.push(removed > 0 ? `**Unblocked:** ${name}` : `**Unblock:** ${name} was not blocking this task`)
  }
  return { lines, error: null }
}

/** Same ids, ignoring order. Pure. */
function sameIds(a, b) {
  const x = new Set(idList(a))
  const y = new Set(idList(b))
  return x.size === y.size && [...x].every((id) => y.has(id))
}

const WARNING_MAX = 1500

export async function execute(interaction, { db: dbArg = db, notify = notifyTaskUpdate, getConfig = getOrCreateGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const taskId = interaction.options.getString('task').trim()
  const cfg = await getConfig(guild.id)
  const task = await dbArg.task.findFirst({ where: { id: taskId, guildConfigId: cfg.id } })
  if (!task) {
    // Reached by typing free text instead of picking a suggestion: the option
    // carries whatever was typed, not an id.
    return interaction.editReply({
      content: `No task matches **${taskId.slice(0, 80)}**. Start typing a title and pick one from the list.`,
    })
  }

  const updates = {}
  const status = interaction.options.getString('status')
  if (status !== null && status !== undefined) updates.status = status
  const passedApi = interaction.options.getInteger('passed_api_tests')
  if (passedApi !== null && passedApi !== undefined) updates.passedApiTests = passedApi
  const passedQa = interaction.options.getInteger('passed_qa_tests')
  if (passedQa !== null && passedQa !== undefined) updates.passedQaTests = passedQa
  const passedAc = interaction.options.getInteger('passed_acceptance_criteria')
  if (passedAc !== null && passedAc !== undefined) updates.passedAcceptanceCriteria = passedAc
  const title = interaction.options.getString('title')
  if (title !== null && title !== undefined) updates.title = title.trim()
  const description = interaction.options.getString('description')
  if (description !== null && description !== undefined) updates.description = description.trim() || null
  const assigneesStr = interaction.options.getString('assignees')
  const assignees = nextAssignees(task.assigneeIds, {
    replace: assigneesStr !== null && assigneesStr !== undefined ? parseUserIds(assigneesStr) : undefined,
    add: interaction.options.getUser('add_assignee')?.id,
    remove: interaction.options.getUser('remove_assignee')?.id,
  })
  if (assignees && !sameIds(assignees, task.assigneeIds)) updates.assigneeIds = assignees
  const implStatus = interaction.options.getString('implementation_status')
  if (implStatus !== null && implStatus !== undefined) updates.implementationStatus = implStatus
  const projectOpt = interaction.options.getString('project')
  if (projectOpt !== null && projectOpt !== undefined) {
    if (projectOpt === NO_PROJECT) {
      updates.projectId = null
      updates.projectName = null
    } else {
      // The picker's value is a project id; free text typed past the
      // suggestions arrives as-is and must not be written as an id.
      const row = await dbArg.project.findFirst({ where: { id: projectOpt } }).catch(() => null)
      if (!row || row.guildConfigId !== cfg.id) {
        return interaction.editReply({ content: `No project matches **${projectOpt.slice(0, 80)}**. Start typing a project name and pick one from the list.` })
      }
      updates.projectId = row.id
      updates.projectName = row.name
    }
  }

  const blockedById = interaction.options.getString('blocked_by')?.trim() || null
  const unblockId = interaction.options.getString('unblock')?.trim() || null
  const hasUpdates = Object.keys(updates).length > 0
  if (!hasUpdates && !blockedById && !unblockId) {
    return interaction.editReply({ content: 'Provide at least one field to update (e.g. `status`, `add_assignee`, `blocked_by`).' })
  }

  try {
    // Every refusal returns here, before the task row is written, so a refused
    // dependency never leaves a half-applied update.
    const dep = await applyDependencyChange({ db: dbArg, cfg, task, blockedById, unblockId, actorId: interaction.user.id })
    if (dep.error) return interaction.editReply({ content: dep.error })

    let notified = { channelId: task.discordChannelId || null, created: false, dmed: [] }
    let warning = ''
    if (hasUpdates) {
      await dbArg.task.update({ where: { id: taskId }, data: updates })

      if (updates.status && updates.status !== task.status && updates.status !== 'open' && updates.status !== 'pending') {
        // The write already succeeded; a failure here must not report "Update failed".
        try {
          const rows = await dbArg.taskDependency.findByTask({ where: { taskId: task.id } })
          const blockers = rows.length
            ? await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids: rows.map((r) => r.blockedByTaskId) } })
            : []
          const byId = Object.fromEntries(blockers.map((b) => [b.id, b]))
          warning = blockerWarning(openBlockers(task.id, rows, byId))
          if (warning.length > WARNING_MAX) warning = `${warning.slice(0, WARNING_MAX - 1)}…`
        } catch (e) {
          console.error('[update-task] blocker warning:', e?.message ?? e)
          warning = ''
        }
      }

      // The write is what matters; notification is best-effort and must never
      // turn a successful update into a failed command.
      try {
        notified = await notify({
          client: interaction.client,
          guild,
          task,
          before: task,
          updates,
          actorId: interaction.user.id,
          warning,
          db: dbArg,
        })
      } catch (e) {
        console.error('[update-task] notify:', e?.message ?? e)
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('Task updated')
      .setDescription(warning ? `**${task.title || taskId}**\n${warning}` : `**${task.title || taskId}**`)
      .addFields(Object.entries(updates).map(([k, v]) => ({
        name: k,
        value: Array.isArray(v) ? (v.length ? v.map((id) => `<@${id}>`).join(' ') : 'None') : String(v ?? 'null'),
        inline: true,
      })))
      .setColor(0x57f287)
    if (dep.lines.length) {
      let depValue = dep.lines.join('\n')
      if (depValue.length > 1024) depValue = `${depValue.slice(0, 1023)}…`
      embed.addFields({ name: 'Dependencies', value: depValue, inline: false })
    }
    if (notified.channelId) {
      embed.addFields({
        name: notified.created ? 'Channel created' : 'Task channel',
        value: `<#${notified.channelId}>`,
        inline: false,
      })
    }
    if (notified.dmed.length) {
      embed.setFooter({ text: `Notified ${notified.dmed.length} member(s) by DM` })
    }
    return interaction.editReply({ embeds: [embed] })
  } catch (e) {
    console.error('[update-task]', e)
    return interaction.editReply({ content: `Update failed: ${e?.message ?? String(e)}` })
  }
}

/**
 * Task picker. A task id is a 25-character hex string; nobody should have to
 * read one off a dashboard and retype it, so the choice shows title, status and
 * holder while the value stays the id.
 */
/** Project picker choices: "No project" first, then names matching the typed text. Pure. */
export function projectChoices(projects, term, { withDetach = true } = {}) {
  const t = String(term || '').trim().toLowerCase()
  const head = { name: 'No project — detach from any project', value: NO_PROJECT }
  const rest = (projects || [])
    .filter((p) => !t || String(p.name || '').toLowerCase().includes(t))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
    .map((p) => ({ name: String(p.name || p.id).slice(0, 100), value: String(p.id) }))
  return (withDetach ? [head, ...rest] : rest).slice(0, 25)
}

export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const focused = interaction.options.getFocused(true)
  if (focused.name === 'project') {
    try {
      const cfg = await getConfig(interaction.guild.id)
      const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
      return interaction.respond(projectChoices(projects, focused.value)).catch(() => {})
    } catch (e) {
      console.error('[update-task] project autocomplete:', e?.message ?? e)
      return interaction.respond([]).catch(() => {})
    }
  }
  if (!['task', 'blocked_by', 'unblock'].includes(focused.name)) return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getConfig(interaction.guild.id)
    let rows = await dbArg.task.findMany({ where: { guildConfigId: cfg.id }, orderBy: { updatedAt: 'desc' }, take: 200 })
    if (focused.name === 'unblock') {
      // With a real task picked, offer only its current blockers — an empty
      // list when it has none. Fall back to all tasks only when `task` is
      // empty or not a known id.
      const taskId = String(interaction.options.getString('task') || '').trim()
      const known = taskId ? await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids: [taskId] } }) : []
      if (known.length) {
        const deps = await dbArg.taskDependency.findByTask({ where: { taskId } })
        const ids = deps.map((d) => d.blockedByTaskId)
        rows = ids.length ? await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids } }) : []
      }
    }
    // Members are resolved from cache only — autocomplete has ~3 seconds and a
    // fetch per assignee would blow it. An unresolved id shows as the id.
    const nameFor = (id) => interaction.guild.members.cache.get(id)?.displayName ?? null

    const term = String(focused.value || '').trim().toLowerCase()
    const matches = rows.filter((t) => {
      if (!term) return true
      if (String(t.title || '').toLowerCase().includes(term)) return true
      if (String(t.id).toLowerCase().startsWith(term)) return true
      if (String(t.status || '').toLowerCase() === term) return true
      return holdersOf(t).some((id) => String(nameFor(id) || '').toLowerCase().includes(term))
    })

    return interaction
      .respond(matches.slice(0, 25).map((t) => ({ name: taskChoiceLabel(t, { nameFor }), value: t.id })))
      .catch(() => {})
  } catch (e) {
    console.error('[update-task] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
