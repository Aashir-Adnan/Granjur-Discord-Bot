import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { taskChoiceLabel, holdersOf } from '../utils/taskLabel.js'

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

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const taskId = interaction.options.getString('task').trim()
  const cfg = await getOrCreateGuildConfig(guild.id)
  const task = await db.task.findFirst({ where: { id: taskId, guildConfigId: cfg.id } })
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
  if (assigneesStr !== null && assigneesStr !== undefined) updates.assigneeIds = parseUserIds(assigneesStr)
  const implStatus = interaction.options.getString('implementation_status')
  if (implStatus !== null && implStatus !== undefined) updates.implementationStatus = implStatus

  if (Object.keys(updates).length === 0) {
    return interaction.editReply({
      content: 'Provide at least one field to update (e.g. `status`, `passed_api_tests`, `title`, `assignees`).',
    })
  }

  try {
    await db.task.update({ where: { id: taskId }, data: updates })
    const embed = new EmbedBuilder()
      .setTitle('Task updated')
      .setDescription(`**${task.title || taskId}**`)
      .addFields(Object.entries(updates).map(([k, v]) => ({
        name: k,
        value: Array.isArray(v) ? (v.length ? v.map((id) => `<@${id}>`).join(' ') : 'None') : String(v ?? 'null'),
        inline: true,
      })))
      .setColor(0x57f287)
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
export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'task') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getOrCreateGuildConfig(interaction.guild.id)
    const rows = await db.task.findMany({
      where: { guildConfigId: cfg.id },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    })
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
