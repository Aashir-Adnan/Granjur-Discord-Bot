/**
 * `/project-setup` — the operator's way into the section machinery in
 * `bot/src/services/projectSection.js`: observe the guild, plan the section,
 * and (unless `preview:true`) perform it, then bring the project role in line
 * with `projectmember`.
 *
 * The command owns none of the decisions. Everything it prints comes from the
 * planner's plan and the applier's result, so the two pure renderers below are
 * the whole of its opinion.
 *
 * The one thing it does decide is when NOT to revoke. This command is an
 * operator's only window into what the bot did to their server, so a reply that
 * reads as success when a pass was skipped is worse than one that reads as
 * failure: whenever the inputs to the revoke half are known to be incomplete —
 * the member list would not load, or the roster came back at its hard limit —
 * the revoke pass is skipped outright and said so, because "revoked 0" and
 * "read nothing" are indistinguishable in the reply.
 */
import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { projectChoices } from './update-task.js'
import {
  observeProjectSection,
  planProjectSection,
  applyProjectSection,
  syncProjectRoleMembers,
  cut,
} from '../services/projectSection.js'

/** Discord's hard limit on a message. */
const REPLY_LIMIT = 2000

/** Room kept back for the "… and N more" line when blocks are dropped. */
const TAIL_ROOM = 140

/** Warning lines printed per project before the rest are summarised. */
const MAX_WARNINGS = 5

/** How many task rows are considered per project. */
const TASK_LIMIT = 500

/**
 * How many roster rows `projectMember.findByProject` can ever return — its SQL
 * carries a hard `LIMIT 200`. Other commands only ever GRANT from that list, so
 * the limit is theirs to live with; this command is the first that REVOKES on
 * it, and revoking on a truncated roster would strip the role from real members.
 */
const ROSTER_LIMIT = 200

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
  ['grant', 'to open to the project role'],
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

/**
 * At most `MAX_WARNINGS` lines, then one line saying how many are not shown.
 * Every unbounded list inside a block goes through this: one project with a
 * hundred lines would otherwise eat the whole message budget and take the other
 * projects' blocks down with it.
 */
function cappedLines(items, render, more) {
  const list = (items ?? []).map((item) => String(item))
  const shown = list.slice(0, MAX_WARNINGS).map(render)
  if (list.length > MAX_WARNINGS) shown.push(more(list.length - MAX_WARNINGS))
  return shown
}

const warningLines = (warnings) =>
  cappedLines(
    warnings,
    (w) => `⚠ ${w}`,
    (n) => `⚠ …and ${n} more warning(s).`
  )

const failureLines = (failures) =>
  cappedLines(
    failures,
    (f) => `⚠ role sync: ${f}`,
    (n) => `⚠ role sync: …and ${n} more member(s) could not be changed.`
  )

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
 * `result` is the applier's result plus three things the command adds: a
 * `warnings` list merged from the planner's and the applier's (they keep
 * separate ones, and the category-cap warning is the planner's), the `roleSync`
 * counts, and `roleSync.revokeSkipped` when the revoke half was deliberately
 * not run.
 *
 * @param {{name?: string}} project
 * @param {{role?: object|null, created?: string[], renamed?: string[], moved?: string[], granted?: string[], tasks?: number, warnings?: string[], roleSync?: {granted: string[], revoked: string[], failed: string[], revokeSkipped?: boolean}}} result
 */
export function renderResult(project, result = {}) {
  const name = project?.name ?? 'Project'
  const created = result?.created ?? []
  const renamed = result?.renamed ?? []
  const moved = result?.moved ?? []
  const granted = result?.granted ?? []
  const taskCount = Number(result?.tasks ?? 0)

  const done = []
  if (created.length) done.push(`${created.length} created`)
  if (renamed.length) done.push(`${renamed.length} renamed`)
  if (moved.length) done.push(`${moved.length} moved`)
  if (granted.length) done.push(`${granted.length} opened to the project role`)
  // A touched task channel is already counted in `renamed`, `moved` or
  // `granted` — the applier pushes it into one of them — so naming it again as a further count
  // would describe twelve objects as thirteen. It is a breakdown of the counts
  // above, not an addition to them, and it says so.
  const summary = done.length ? done.join(', ') : 'nothing to change'
  const breakdown =
    done.length && taskCount ? ` (incl. ${taskCount} task channel${taskCount === 1 ? '' : 's'})` : ''

  const lines = [`**${name}** — ${summary}${breakdown}.`]

  const sync = result?.roleSync
  const role = result?.role ?? null
  if (role || sync) {
    if (!role) {
      // The applier warns and leaves `role` null when the create throws. There
      // was then no id to sync against, and the empty lists below would
      // otherwise print beside that warning as a clean sync.
      lines.push('Role — not created, nothing was synced.')
    } else {
      const counts = []
      if (sync?.granted?.length) counts.push(`${sync.granted.length} granted`)
      if (sync?.revoked?.length) counts.push(`${sync.revoked.length} revoked`)
      if (sync?.failed?.length) counts.push(`${sync.failed.length} could not be changed`)
      if (sync?.revokeSkipped) counts.push('nobody removed — see the warning below')
      const head = role.name ? `Role **${role.name}**` : 'Role'
      lines.push(counts.length ? `${head} — ${counts.join(', ')}.` : `${head} — nobody to add or remove.`)
    }
    lines.push(...failureLines(sync?.failed))
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

/** The "… and N more not shown" line, so a truncated reply always admits it. */
function droppedTail(dropped) {
  return `… and ${dropped} more not shown. Run \`/project-setup project:<name>\` one at a time for the rest.`
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
  // rather than replying with nothing but the tail — but the other projects
  // still RAN, and created categories and channels in the guild, so the count
  // of what is not shown goes out either way.
  if (!kept.length) {
    const rest = blocks.length - 1
    const tail = rest ? `\n${droppedTail(rest)}` : ''
    // `cut` rather than `slice`: project names carry '📂' and arbitrary user
    // text, and half a surrogate pair renders as a replacement character.
    return `${cut(blocks[0], REPLY_LIMIT - 1 - tail.length)}…${tail}`
  }
  return `${kept.join('\n\n')}\n\n${droppedTail(blocks.length - kept.length)}`.slice(0, REPLY_LIMIT)
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
  //
  // Swallowing a failure here is exactly what the "fetch before sync" contract
  // exists to prevent: the sync would read an empty cache, revoke from nobody,
  // and report a clean run while a stale holder keeps the project role. So the
  // failure is kept, said out loud, and the revoke pass does not run.
  let fetchFailure = null
  if (!preview) {
    try {
      await guild.members.fetch()
    } catch (e) {
      fetchFailure = e?.message || String(e)
      console.error('[project-setup] members.fetch:', e)
    }
  }
  const nameFor = (id) => guild.members.cache.get(id)?.displayName ?? id
  const botUserId = interaction.client?.user?.id ?? null

  const blocks = []
  // `pickProjects` checks `all` first, so `project:` was read and thrown away.
  if (all && picked) {
    blocks.push(
      '**all:true** was set, so the **project:** you picked was ignored — every project in this server is included below.'
    )
  }

  // With `all`, the reply grows as the walk proceeds. Roughly nine categories
  // and ninety channels through Discord's channel-create bucket can outlast the
  // 15-minute interaction token, and one terminal `editReply` would then throw
  // 50027 and leave the operator with a spinner and no record of what was
  // built. A webhook edit is not on the two-channel-edits-per-ten-minutes
  // bucket that rations the rest of this feature, so posting per project costs
  // nothing the feature is short of and bounds the loss to the project in
  // flight.
  let posted = null
  const post = async () => {
    const content = capReply(blocks)
    if (content === posted) return
    posted = content
    try {
      await interaction.editReply({ content })
    } catch (e) {
      // A dead token loses the reply, not the walk: the projects still ahead
      // are the whole reason this posts as it goes.
      console.error('[project-setup] editReply:', e?.message ?? e)
    }
  }

  for (const project of projects) {
    try {
      const tasks =
        (await dbArg.task.findMany({
          where: { guildConfigId: cfg.id, projectId: project.id },
          take: TASK_LIMIT,
        })) ?? []
      // `taskFindMany` orders by `createdAt DESC`, so a project past the limit
      // silently loses its OLDEST task channels: every run reads the same
      // newest 500, every run reports success, and it never self-heals.
      const extra = []
      if (tasks.length >= TASK_LIMIT) {
        extra.push(
          `Only the newest ${TASK_LIMIT} task channels for "${project?.name}" were read, so any older ones were left where they are.`
        )
      }

      const observed = observeProjectSection(guild, project, tasks)
      const plan = planProjectSection(project, observed)

      if (preview) {
        blocks.push(renderPlan(project, { ...plan, warnings: mergeWarnings(extra, plan.warnings) }))
        continue
      }

      // The roster is passed on purpose: `members` is a tri-state, and omitting
      // it would leave every pinned members panel showing yesterday's list.
      const members = (await dbArg.projectMember.findByProject({ where: { projectId: project.id } })) ?? []
      const truncatedRoster = members.length >= ROSTER_LIMIT
      if (fetchFailure) {
        extra.push(
          `This server's member list could not be read (${fetchFailure}), so nobody was removed from the project role. Run /project-setup again once the bot can read this server's members.`
        )
      }
      if (truncatedRoster) {
        extra.push(
          `Only the first ${ROSTER_LIMIT} members of "${project?.name}" could be read, so nobody was removed from the project role — members past that limit would have looked as though they had left the project.`
        )
      }

      const result = await applyProjectSection(guild, project, plan, { db: dbArg, members, nameFor, botUserId })
      const roleId = result.role?.id ?? null
      // Say it as a flag, not by padding the roster with every current holder:
      // "do not revoke" is what this means, and a roster the service happens to
      // find nothing to revoke from would stop meaning that the moment the
      // service changed how it reads its holders.
      const grantOnly = Boolean(fetchFailure) || truncatedRoster
      const roleSync = await syncProjectRoleMembers(guild, project, members, {
        roleId,
        revoke: !grantOnly,
      })
      if (grantOnly) roleSync.revokeSkipped = true

      blocks.push(
        renderResult(project, {
          ...result,
          warnings: mergeWarnings(extra, plan.warnings, result.warnings),
          roleSync,
        })
      )
    } catch (e) {
      // With `all`, one project the bot cannot touch must never abort the rest.
      console.error(`[project-setup] ${project?.name ?? project?.id}:`, e)
      blocks.push(`**${project?.name ?? project?.id}** — failed: ${e?.message ?? String(e)}`)
    }
    if (all) await post()
  }

  const content = capReply(blocks)
  if (content === posted) return
  return interaction.editReply({ content })
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
