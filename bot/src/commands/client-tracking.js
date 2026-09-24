import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { holdersOf } from '../utils/taskLabel.js'
import { myRequestsLines, requestStatusLabel, timelineLines } from '../utils/clientRequestView.js'
import { managedProjectIds } from '../utils/clientRoles.js'

/** The projects this member manages as a client manager; never throws. */
async function managedFor(dbArg, cfg, userId) {
  const rows = await Promise.resolve()
    .then(() => dbArg.projectMember.findByMember({ where: { guildConfigId: cfg.id, discordId: userId } }))
    .catch(() => [])
  return new Set(managedProjectIds(rows))
}

/**
 * What a member may see: their own requests, plus — for a client manager —
 * every request on a project they manage. A task with no `requestedBy` is a
 * team task and never a request, whoever asks.
 */
const canSee = (task, userId, managed) =>
  Boolean(task?.requestedBy) && (String(task.requestedBy) === String(userId) || managed.has(String(task.projectId ?? '')))

async function visibleRequests(dbArg, cfg, userId, take) {
  const managed = await managedFor(dbArg, cfg, userId)
  const own = await dbArg.task.findMany({ where: { guildConfigId: cfg.id, requestedBy: userId }, orderBy: { createdAt: 'desc' }, take })
  const seen = new Map((own ?? []).map((t) => [String(t.id), t]))
  for (const projectId of managed) {
    const tasks = await dbArg.task.findMany({ where: { guildConfigId: cfg.id, projectId }, orderBy: { createdAt: 'desc' }, take })
    for (const t of tasks ?? []) if (canSee(t, userId, managed) && !seen.has(String(t.id))) seen.set(String(t.id), t)
  }
  const tasks = [...seen.values()]
    .sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0))
    .slice(0, take)
  return { tasks, managed }
}

export const data = [
  new SlashCommandBuilder().setName('my-requests').setDescription('Your issues and requests, and where each stands'),
  new SlashCommandBuilder().setName('request-report').setDescription('A report on one of your requests')
    .addStringOption((o) => o.setName('request').setDescription('Start typing a title').setRequired(true).setAutocomplete(true)),
]

const NOT_YOURS = 'That is not one of your requests.'
const ts = (d) => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:D>` : '—')

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })
  const cfg = await getConfig(guild.id)
  const nameFor = (id) => guild.members?.cache?.get?.(id)?.displayName ?? null

  if (interaction.commandName === 'my-requests') {
    const { tasks } = await visibleRequests(dbArg, cfg, interaction.user.id, 25)
    const lines = myRequestsLines(tasks, { me: interaction.user.id, nameFor })
    const embed = new EmbedBuilder()
      .setTitle('Your requests')
      .setDescription(lines.join('\n') || 'You have not raised anything yet. Use **/report-issue** or **/request-feature**.')
      .setColor(0x00b0f4)
      .setFooter({ text: '"Waiting on you" means the team needs something from you — answer in that request\'s channel.' })
    return interaction.editReply({ embeds: [embed] })
  }

  // request-report. The refusal is the same whether the id is someone else's
  // or nobody's: a different message would confirm the id exists.
  const id = interaction.options.getString('request')
  const task = id ? await dbArg.task.findFirst({ where: { id, guildConfigId: cfg.id } }) : null
  const managed = await managedFor(dbArg, cfg, interaction.user.id)
  if (!task || !canSee(task, interaction.user.id, managed)) return interaction.editReply({ content: NOT_YOURS })

  const rows = await dbArg.taskActivity.findByTask({ where: { taskId: task.id } }).catch(() => [])
  const handlers = holdersOf(task).map((h) => nameFor(h) || `<@${h}>`)
  const timeline = timelineLines(rows, { nameFor })
  const embed = new EmbedBuilder()
    .setTitle(`${task.type === 'bug' ? 'Issue' : task.type === 'task' ? 'Support task' : 'Request'}: ${task.title}`)
    .setColor(task.status === 'pending' ? 0xfee75c : 0x00b0f4)
    .addFields(
      { name: 'Status', value: requestStatusLabel(task.status), inline: true },
      { name: 'Handled by', value: handlers.join(', ') || 'not yet assigned', inline: true },
      { name: 'Project', value: task.projectName || 'no project', inline: true },
      { name: 'Raised', value: ts(task.createdAt), inline: true },
      { name: 'Last updated', value: ts(task.updatedAt ?? task.createdAt), inline: true },
      { name: 'History', value: timeline.join('\n') || 'No changes yet.' },
    )
  if (task.discordChannelId) embed.addFields({ name: 'Channel', value: `<#${task.discordChannelId}>` })
  return interaction.editReply({ embeds: [embed] })
}

export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'request') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getConfig(interaction.guild.id)
    const term = String(focused.value || '').toLowerCase()
    const { tasks } = await visibleRequests(dbArg, cfg, interaction.user.id, 100)
    const choices = tasks
      .filter((t) => !term || String(t.title || '').toLowerCase().includes(term))
      .slice(0, 25)
      .map((t) => ({ name: `${String(t.title || t.id).slice(0, 80)} · ${requestStatusLabel(t.status)}`.slice(0, 100), value: String(t.id) }))
    return interaction.respond(choices).catch(() => {})
  } catch (e) {
    console.error('[client-tracking] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
