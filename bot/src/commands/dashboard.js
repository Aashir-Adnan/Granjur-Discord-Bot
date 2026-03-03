import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'

const TWO_MONTHS_MS = 60 * 24 * 60 * 60 * 1000
function twoMonthsAgo() {
  return new Date(Date.now() - TWO_MONTHS_MS)
}

const MODULES = [
  { value: 'overview', label: 'Overview', description: 'Bugs, features, meetings, FAQs' },
  { value: 'tasks', label: 'Tasks', description: 'All tasks with details, grouped by module' },
  { value: 'bugs', label: 'Bugs', description: 'Ticket counts and recent' },
  { value: 'features', label: 'Features', description: 'Feature task summary' },
  { value: 'meetings', label: 'Meetings', description: 'Scheduled meetings' },
  { value: 'faqs', label: 'FAQs', description: 'Unanswered vs total' },
]

export const data = new SlashCommandBuilder()
  .setName('dashboard')
  .setDescription('(CEO/Server Manager) View analytics — select module')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)

  const member = await guild.members.fetch(interaction.user.id).catch(() => null)
  const dashboardIds = ensureStringArray(cfg.dashboardRoleIds)
  const canDashboard =
    (dashboardIds.length && member?.roles.cache.some((r) => dashboardIds.includes(r.id))) ||
    member?.permissions.has('Administrator')
  if (!canDashboard) {
    return interaction.editReply({ content: 'Only CEO or Server Manager can use the dashboard.' })
  }

  const embed = new EmbedBuilder()
    .setTitle('Dashboard')
    .setDescription('**What do you want to see?** Select details or analytics below.')
    .setColor(0x5865f2)
    .setFooter({ text: 'Modular — add more in config' })

  const select = new StringSelectMenuBuilder()
    .setCustomId('dashboard_select')
    .setPlaceholder('Select what to view (details / analytics)')
    .addOptions(MODULES.map((m) => ({ label: m.label, value: m.value, description: m.description })))

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  })
}

export async function handleModuleSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const value = interaction.values?.[0]
  if (!value) return

  const cfg = await getOrCreateGuildConfig(guild.id)
  const since = twoMonthsAgo()
  const [bugCount, featureCount, meetingCount, faqOpen, faqTotal] = await Promise.all([
    db.task.count({ where: { guildConfigId: cfg.id, is_bug: 1, createdAtSince: since } }),
    db.task.count({ where: { guildConfigId: cfg.id, is_feature: 1, createdAtSince: since } }),
    db.scheduledMeeting.count({ where: { guildConfigId: cfg.id } }),
    db.faq.count({ where: { guildConfigId: cfg.id, status: 'open' } }),
    db.faq.count({ where: { guildConfigId: cfg.id } }),
  ])

  let embed
  if (value === 'tasks') {
    const tasks = await db.task.findMany({ where: { guildConfigId: cfg.id, createdAtSince: since }, take: 200 })
    const byModule = {}
    const noModule = []
    for (const t of tasks) {
      const mods = ensureStringArray(t.modules)
      if (mods.length === 0) noModule.push(t)
      else for (const m of mods) { (byModule[m] = byModule[m] || []).push(t) }
    }
    const sectionLines = []
    const pad = (s, n) => (s ?? '—').slice(0, n).padEnd(n)
    const header = '```\n' +
      pad('Type', 8) + ' | ' + pad('Title', 28) + ' | ' + pad('Handlers', 18) + ' | ' + pad('Status', 12) + ' | ' +
      'API Test  | QA Test  | AC   | ' + pad('Scope', 20) + '\n' +
      '—'.repeat(8) + '—'.repeat(32) + '—'.repeat(22) + '—'.repeat(14) + '—'.repeat(28) + '\n'
    const fmt = (t) => {
      const assignees = ensureStringArray(t.is_feature ? t.assigneeIds : t.taggedMemberIds)
      const handlerStr = assignees.length ? `${assignees.length} assignee(s)` : '—'
      const status = (t.implementationStatus ?? t.status ?? '—').slice(0, 10)
      const api = t.passedApiTests === 1 ? 'Pass' : t.passedApiTests === 0 ? 'Fail' : 'N/A'
      const qa = t.passedQaTests === 1 ? 'Pass' : t.passedQaTests === 0 ? 'Fail' : 'N/A'
      const ac = t.passedAcceptanceCriteria === 1 ? 'Pass' : t.passedAcceptanceCriteria === 0 ? 'Fail' : 'N/A'
      const scope = (t.scope || '—').slice(0, 18)
      const title = (t.title || t.id).slice(0, 26)
      const typ = (t.type || (t.is_bug ? 'bug' : 'feature')).slice(0, 7)
      return pad(typ, 8) + ' | ' + pad(title, 28) + ' | ' + pad(handlerStr, 18) + ' | ' + pad(status, 12) + ' | ' +
        pad(api, 7) + ' | ' + pad(qa, 7) + ' | ' + pad(ac, 4) + ' | ' + pad(scope, 20)
    }
    const moduleNames = Object.keys(byModule).sort()
    for (const mod of moduleNames) {
      sectionLines.push(`\n**Module: ${mod}**`)
      sectionLines.push(header + byModule[mod].slice(0, 12).map(fmt).join('\n') + '\n```')
      if (byModule[mod].length > 12) sectionLines.push(`_… and ${byModule[mod].length - 12} more_`)
    }
    if (noModule.length > 0) {
      sectionLines.push('\n**Module: (none)**')
      sectionLines.push(header + noModule.slice(0, 12).map(fmt).join('\n') + '\n```')
      if (noModule.length > 12) sectionLines.push(`_… and ${noModule.length - 12} more_`)
    }
    const desc = sectionLines.length
      ? sectionLines.join('\n').slice(0, 3900)
      : 'No tasks yet. Use **/create-task** to add tasks.'
    embed = new EmbedBuilder()
      .setTitle('Dashboard — Tasks')
      .setDescription(desc)
      .addFields({
        name: 'Legend',
        value: '**Handlers** = assignees (who the task is assigned to). **API Test** = API tests pass/fail. **QA Test** = QA tests pass/fail. **AC** = Acceptance criteria met.',
        inline: false,
      })
      .setColor(0x5865f2)
      .setFooter({ text: `Total: ${tasks.length} (≤2mo) | Grouped by module` })
  } else if (value === 'overview') {
    embed = new EmbedBuilder()
      .setTitle('Dashboard — Overview')
      .setDescription(
        `**Bugs (≤2mo):** ${bugCount}\n**Features (≤2mo):** ${featureCount}\n**Scheduled meetings:** ${meetingCount}\n**FAQs:** ${faqOpen} unanswered / ${faqTotal} total`
      )
      .setColor(0x5865f2)
      .setFooter({ text: 'Granjur · Bugs/features: last 2 months' })
  } else if (value === 'bugs') {
    const recent = await db.task.findMany({
      where: { guildConfigId: cfg.id, is_bug: 1, createdAtSince: since },
      take: 15,
    })
    const pad = (s, n) => (String(s ?? '—').slice(0, n)).padEnd(n)
    const lines = recent.length
      ? '```\n' + pad('Status', 10) + ' | ' + pad('Title', 48) + ' | ' + pad('Created', 10) + '\n' + '—'.repeat(70) + '\n' +
        recent.map((b) => pad(b.status ?? '—', 10) + ' | ' + pad((b.title || b.id).slice(0, 46), 48) + ' | ' + pad(b.createdAt ? new Date(b.createdAt).toISOString().slice(0, 10) : '—', 10)).join('\n') + '\n```'
      : 'No bug tasks (≤2mo).'
    embed = new EmbedBuilder()
      .setTitle('Dashboard — Bugs')
      .setDescription(lines)
      .addFields({ name: 'Total (≤2mo)', value: String(bugCount), inline: true })
      .setColor(0xed4245)
      .setFooter({ text: 'Last 2 months' })
  } else if (value === 'features') {
    const recent = await db.task.findMany({
      where: { guildConfigId: cfg.id, is_feature: 1, createdAtSince: since },
      take: 15,
    })
    const pad = (s, n) => (String(s ?? '—').slice(0, n)).padEnd(n)
    const lines = recent.length
      ? '```\n' + pad('Status', 10) + ' | ' + pad('Title', 48) + ' | ' + pad('Created', 10) + '\n' + '—'.repeat(70) + '\n' +
        recent.map((f) => pad(f.status ?? '—', 10) + ' | ' + pad((f.title || f.id).slice(0, 46), 48) + ' | ' + pad(f.createdAt ? new Date(f.createdAt).toISOString().slice(0, 10) : '—', 10)).join('\n') + '\n```'
      : 'No feature tasks (≤2mo).'
    embed = new EmbedBuilder()
      .setTitle('Dashboard — Features')
      .setDescription(lines)
      .addFields({ name: 'Total (≤2mo)', value: String(featureCount), inline: true })
      .setColor(0x5865f2)
      .setFooter({ text: 'Last 2 months' })
  } else if (value === 'meetings') {
    const meetings = await db.scheduledMeeting.findMany({
      where: { guildConfigId: cfg.id },
      orderBy: { scheduledAt: 'asc' },
      take: 10,
    })
    embed = new EmbedBuilder()
      .setTitle('Dashboard — Meetings')
      .setDescription(
        meetings.map((m) => `• ${m.scheduledAt.toISOString().slice(0, 16)} — ${m.topic.slice(0, 50)}`).join('\n') || 'None.'
      )
      .addFields({ name: 'Total', value: String(meetingCount), inline: true })
      .setColor(0x57f287)
  } else {
    embed = new EmbedBuilder()
      .setTitle('Dashboard — FAQs')
      .setDescription(`**Unanswered:** ${faqOpen}\n**Total:** ${faqTotal}`)
      .setColor(0xfee75c)
  }

  await interaction.editReply({ embeds: [embed], components: [] })
}

export async function handleModule(interaction) {
  // Button-based module (if we add buttons later)
  await handleModuleSelect(interaction)
}
