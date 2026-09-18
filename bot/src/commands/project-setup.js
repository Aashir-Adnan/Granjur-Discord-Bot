/**
 * `/project-setup` — the operator's way into the section machinery in
 * `bot/src/services/projectSection.js`: observe the guild, plan the section,
 * and (unless `preview:true`) perform it, then bring the project role in line
 * with `projectmember`.
 *
 * The command owns none of the decisions. Everything it prints comes from the
 * planner's plan and the applier's result, so the two pure renderers below are
 * the whole of its opinion.
 */
import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { projectChoices } from './update-task.js'
import {
  observeProjectSection,
  planProjectSection,
  applyProjectSection,
  syncProjectRoleMembers,
} from '../services/projectSection.js'

/** Discord's hard limit on a message. */
const REPLY_LIMIT = 2000

/** Room kept back for the "… and N more" line when blocks are dropped. */
const TAIL_ROOM = 140

/** Warning lines printed per project before the rest are summarised. */
const MAX_WARNINGS = 5

/** How many task rows are considered per project. */
const TASK_LIMIT = 500

export const data = new SlashCommandBuilder()
  .setName('project-setup')
  .setDescription("Create or repair a project's Discord section — its role, category and channels")
  .addStringOption((o) =>
    o.setName('project').setDescription('Start typing a project name').setRequired(false).setAutocomplete(true)
  )
  .addBooleanOption((o) =>
    o.setName('all').setDescription('Every project in this server, one after another').setRequired(false)
  )
  .addBooleanOption((o) =>
    o.setName('preview').setDescription('Show what would change and do nothing else').setRequired(false)
  )

// ---------------------------------------------------------------------------
// Rendering. Both of these are pure: same arguments, same string, no Discord.
// ---------------------------------------------------------------------------

const CHANNEL_WORDS = [
  ['create', 'to create'],
  ['rename', 'to rename'],
  ['move', 'to move'],
  ['reuse', 'already right'],
]

const TASK_WORDS = [
  ['both', 'to rename and move'],
  ['move', 'to move'],
  ['rename', 'to rename'],
  ['none', 'already right'],
]

/** '9 to create, 1 to move' — counts per action, in the given order, zeros dropped. */
function summarise(entries, words) {
  const list = Array.isArray(entries) ? entries : []
  if (!list.length) return ''
  const counts = new Map()
  for (const entry of list) counts.set(entry?.action, (counts.get(entry?.action) ?? 0) + 1)
  return words
    .filter(([action]) => counts.get(action))
    .map(([action, word]) => `${counts.get(action)} ${word}`)
    .join(', ')
}

function warningLines(warnings) {
  const list = (warnings ?? []).map((w) => String(w))
  const shown = list.slice(0, MAX_WARNINGS).map((w) => `⚠ ${w}`)
  if (list.length > MAX_WARNINGS) shown.push(`⚠ …and ${list.length - MAX_WARNINGS} more warning(s).`)
  return shown
}

/**
 * What `preview:true` prints for one project. Pure.
 *
 * @param {{name?: string}} project
 * @param {ReturnType<typeof planProjectSection>} plan
 */
export function renderPlan(project, plan = {}) {
  const name = project?.name ?? 'Project'
  const lines = []

  const role = plan?.role
  if (role) {
    lines.push(
      role.action === 'refuse'
        ? `Role: refused — ${role.reason || `"${role.name}" is a managed role.`}`
        : `Role: ${role.action} **${role.name}**`
    )
  }
  if (plan?.category) lines.push(`Category: ${plan.category.action} **${plan.category.name}**`)

  const channels = summarise(plan?.channels, CHANNEL_WORDS)
  if (channels) lines.push(`Channels: ${channels}`)
  const tasks = summarise(plan?.tasks, TASK_WORDS)
  if (tasks) lines.push(`Task channels: ${tasks}`)

  lines.push(...warningLines(plan?.warnings))

  if (!lines.length) return `**${name}** — nothing to do.`
  return [`**${name}** — Preview, nothing was changed.`, ...lines].join('\n')
}

/**
 * What a real run prints for one project. Pure.
 *
 * `result` is the applier's result plus two things the command adds: a
 * `warnings` list merged from the planner's and the applier's (they keep
 * separate ones, and the category-cap warning is the planner's), and the
 * `roleSync` counts.
 *
 * @param {{name?: string}} project
 * @param {{role?: object|null, created?: string[], renamed?: string[], moved?: string[], tasks?: number, warnings?: string[], roleSync?: {granted: string[], revoked: string[], failed: string[]}}} result
 */
export function renderResult(project, result = {}) {
  const name = project?.name ?? 'Project'
  const created = result?.created ?? []
  const renamed = result?.renamed ?? []
  const moved = result?.moved ?? []
  const taskCount = Number(result?.tasks ?? 0)

  const done = []
  if (created.length) done.push(`${created.length} created`)
  if (renamed.length) done.push(`${renamed.length} renamed`)
  if (moved.length) done.push(`${moved.length} moved`)
  if (taskCount) done.push(`${taskCount} task channel${taskCount === 1 ? '' : 's'}`)

  const lines = [`**${name}** — ${done.length ? done.join(', ') : 'nothing to change'}.`]

  const sync = result?.roleSync
  const roleName = result?.role?.name
  if (roleName || sync) {
    const counts = []
    if (sync?.granted?.length) counts.push(`${sync.granted.length} granted`)
    if (sync?.revoked?.length) counts.push(`${sync.revoked.length} revoked`)
    if (sync?.failed?.length) counts.push(`${sync.failed.length} could not be changed`)
    const head = roleName ? `Role **${roleName}**` : 'Role'
    lines.push(counts.length ? `${head} — ${counts.join(', ')}.` : `${head} — nobody to add or remove.`)
    for (const failure of sync?.failed ?? []) lines.push(`⚠ role sync: ${failure}`)
  }

  lines.push(...warningLines(result?.warnings))
  if (lines.length === 1 && !done.length) return `**${name}** — nothing to change.`
  return lines.join('\n')
}

/**
 * The planner and the applier keep separate warning lists and the operator
 * needs both: the category-cap warning — "a task channel stayed outside the
 * section" — only ever comes from the planner. Exact duplicates are dropped.
 */
function mergeWarnings(...lists) {
  const seen = new Set()
  const out = []
  for (const list of lists) {
    for (const warning of list ?? []) {
      const text = String(warning)
      if (seen.has(text)) continue
      seen.add(text)
      out.push(text)
    }
  }
  return out
}

/** Join the per-project blocks, dropping whole blocks off the end to fit one message. */
function capReply(blocks) {
  if (!blocks.length) return 'Nothing to do.'
  const joined = blocks.join('\n\n')
  if (joined.length <= REPLY_LIMIT) return joined

  const kept = []
  let length = 0
  for (const block of blocks) {
    const cost = (kept.length ? 2 : 0) + block.length
    if (length + cost > REPLY_LIMIT - TAIL_ROOM) break
    kept.push(block)
    length += cost
  }
  // A single block longer than the whole message: print as much of it as fits
  // rather than replying with nothing but the tail.
  if (!kept.length) return `${blocks[0].slice(0, REPLY_LIMIT - 1)}…`
  const dropped = blocks.length - kept.length
  const tail = `… and ${dropped} more not shown. Run \`/project-setup project:<name>\` one at a time for the rest.`
  return `${kept.join('\n\n')}\n\n${tail}`.slice(0, REPLY_LIMIT)
}

// ---------------------------------------------------------------------------
// The command.
// ---------------------------------------------------------------------------

async function pickProjects(interaction, cfg, dbArg) {
  if (interaction.options.getBoolean('all')) {
    const rows = (await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })) ?? []
    if (!rows.length) {
      await interaction.editReply({ content: 'No projects yet. Add one with **/projects** → Add project.' })
      return null
    }
    return rows
  }
  const raw = String(interaction.options.getString('project') || '').trim()
  const row = await dbArg.project.findFirst({ where: { id: raw } }).catch(() => null)
  if (!row || row.guildConfigId !== cfg.id) {
    await interaction.editReply({
      content: `No project matches **${raw.slice(0, 80)}**. Start typing a project name and pick one from the list.`,
    })
    return null
  }
  return [row]
}

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const all = interaction.options.getBoolean('all') ?? false
  const preview = interaction.options.getBoolean('preview') ?? false
  const picked = String(interaction.options.getString('project') || '').trim()
  if (!picked && !all) {
    return interaction.editReply({
      content:
        'Pick a **project**, or pass **all:true** to set up every project in this server. Add **preview:true** to see the plan without changing anything.',
    })
  }

  const cfg = await getConfig(guild.id)
  const projects = await pickProjects(interaction, cfg, dbArg)
  if (!projects) return

  // `syncProjectRoleMembers` works out who to revoke from by reading the role's
  // member cache, so without a full fetch it sees no holders and revokes from
  // nobody. A preview syncs nothing, so it does not pay for the fetch.
  if (!preview) await guild.members.fetch().catch(() => null)
  const nameFor = (id) => guild.members.cache.get(id)?.displayName ?? id
  const botUserId = interaction.client?.user?.id ?? null

  const blocks = []
  for (const project of projects) {
    try {
      const tasks =
        (await dbArg.task.findMany({
          where: { guildConfigId: cfg.id, projectId: project.id },
          take: TASK_LIMIT,
        })) ?? []
      const observed = observeProjectSection(guild, project, tasks)
      const plan = planProjectSection(project, observed)

      if (preview) {
        blocks.push(renderPlan(project, plan))
        continue
      }

      // The roster is passed on purpose: `members` is a tri-state, and omitting
      // it would leave every pinned members panel showing yesterday's list.
      const members = (await dbArg.projectMember.findByProject({ where: { projectId: project.id } })) ?? []
      const result = await applyProjectSection(guild, project, plan, { db: dbArg, members, nameFor, botUserId })
      const roleSync = await syncProjectRoleMembers(guild, project, members, {
        roleId: result.role?.id ?? null,
      })

      blocks.push(
        renderResult(project, {
          ...result,
          warnings: mergeWarnings(plan.warnings, result.warnings),
          roleSync,
        })
      )
    } catch (e) {
      // With `all`, one project the bot cannot touch must never abort the rest.
      console.error(`[project-setup] ${project?.name ?? project?.id}:`, e)
      blocks.push(`**${project?.name ?? project?.id}** — failed: ${e?.message ?? String(e)}`)
    }
  }

  return interaction.editReply({ content: capReply(blocks) })
}

export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'project') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getConfig(interaction.guild.id)
    const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
    return interaction.respond(projectChoices(projects, focused.value, { withDetach: false })).catch(() => {})
  } catch (e) {
    console.error('[project-setup] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
