import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'
import { memberPassesRoleGate, roleIdsAreStale, LEADERSHIP_ROLE_NAMES } from '../utils/roleGate.js'
import { holdersOf } from '../utils/taskLabel.js'

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

// One line per task, OUTSIDE a code fence so `<@id>` renders as a name. The old
// monospace table printed the assignee column as "2 assignee(s)" — a count, which
// never answers the only question that column exists for — and collapsed status
// into implementationStatus, hiding the real one. Shared by the Tasks, Bugs and
// Features views so all three say who holds a task and where it stands.
function taskLine(t) {
  const holders = holdersOf(t)
  const who = holders.length ? holders.map((id) => `<@${id}>`).join(' ') : '_unassigned_'
  const status = t.status || 'open'
  const impl =
    t.implementationStatus && t.implementationStatus !== 'not_started'
      ? ` · impl \`${t.implementationStatus}\``
      : ''
  const mark = (v) => (v === 1 ? '✅' : v === 0 ? '❌' : '–')
  const tests = ` · API ${mark(t.passedApiTests)} QA ${mark(t.passedQaTests)} AC ${mark(t.passedAcceptanceCriteria)}`
  const typ = t.type || (t.is_bug ? 'bug' : 'feature')
  const title = String(t.title || t.id)
  const head = title.length > 60 ? `${title.slice(0, 59)}…` : title
  return `• \`${typ}\` **${head}** · \`${status}\`${impl}\n  ${who}${tests}`
}

export const data = new SlashCommandBuilder()
  .setName('dashboard')
  .setDescription('(CEO/Server Manager) View analytics — select module')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)

  const member = await guild.members.fetch(interaction.user.id).catch(() => null)
  const dashboardIds = ensureStringArray(cfg.dashboardRoleIds)
  if (roleIdsAreStale(guild, dashboardIds)) {
    console.warn(`[dashboard] guildconfig.dashboardRoleIds names no live role in ${guild.id} — falling back to role names; re-run /init`)
  }
  if (!memberPassesRoleGate(guild, member, dashboardIds, LEADERSHIP_ROLE_NAMES)) {
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
    const section = (heading, rows) => {
      sectionLines.push(`\n**${heading}**`)
      sectionLines.push(rows.slice(0, 12).map((t) => taskLine(t)).join('\n'))
      if (rows.length > 12) sectionLines.push(`_… and ${rows.length - 12} more_`)
    }
    for (const mod of Object.keys(byModule).sort()) section(`Module: ${mod}`, byModule[mod])
    if (noModule.length > 0) section('Module: (none)', noModule)
    const desc = sectionLines.length
      ? sectionLines.join('\n').slice(0, 3900)
      : 'No tasks yet. Use **/create-task** to add tasks.'
    embed = new EmbedBuilder()
      .setTitle('Dashboard — Tasks')
      .setDescription(desc)
      .addFields({
        name: 'Legend',
        value: 'The second line of each task is who holds it. **API / QA / AC** — ✅ passing, ❌ failing, – not recorded. Change any of it with **/update-task**.',
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
    const lines = recent.length
      ? recent.map((b) => taskLine(b)).join('\n').slice(0, 3900)
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
    const lines = recent.length
      ? recent.map((f) => taskLine(f)).join('\n').slice(0, 3900)
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
        meetings.map((m) => `• <t:${Math.floor(new Date(m.scheduledAt).getTime() / 1000)}:f> — ${m.topic.slice(0, 50)}`).join('\n') || 'None.'
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
