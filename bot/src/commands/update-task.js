import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'

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
  .setDescription('Update a task by ID — pass field(s) as parameters')
  .addStringOption((o) =>
    o.setName('task_id').setDescription('Task ID (feature or bug)').setRequired(true)
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

  const taskId = interaction.options.getString('task_id').trim()
  const cfg = await getOrCreateGuildConfig(guild.id)
  const task = await db.task.findFirst({ where: { id: taskId, guildConfigId: cfg.id } })
  if (!task) {
    return interaction.editReply({ content: `Task **${taskId}** not found.` })
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
      .setDescription(`**${taskId}**`)
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
