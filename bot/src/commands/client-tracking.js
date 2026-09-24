import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { holdersOf } from '../utils/taskLabel.js'
import { myRequestsLines, requestStatusLabel, timelineLines } from '../utils/clientRequestView.js'

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
    const tasks = await dbArg.task.findMany({ where: { guildConfigId: cfg.id, requestedBy: interaction.user.id }, orderBy: { createdAt: 'desc' }, take: 25 })
    const lines = myRequestsLines(tasks)
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
  if (!task || String(task.requestedBy ?? '') !== String(interaction.user.id)) return interaction.editReply({ content: NOT_YOURS })

  const rows = await dbArg.taskActivity.findByTask({ where: { taskId: task.id } }).catch(() => [])
  const handlers = holdersOf(task).map((h) => nameFor(h) || `<@${h}>`)
  const timeline = timelineLines(rows, { nameFor })
  const embed = new EmbedBuilder()
    .setTitle(`${task.type === 'bug' ? 'Issue' : 'Request'}: ${task.title}`)
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
    const tasks = await dbArg.task.findMany({ where: { guildConfigId: cfg.id, requestedBy: interaction.user.id }, orderBy: { createdAt: 'desc' }, take: 100 })
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
