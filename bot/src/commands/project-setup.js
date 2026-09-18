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
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { projectChoices } from './update-task.js'
import {
  observeProjectSection,
  planProjectSection,
  applyProjectSection,
  syncProjectRoleMembers,
  claimedSectionIds,
  projectSlug,
  cut,
} from '../services/projectSection.js'
import { ensureMembersPanel } from '../services/projectMembersPanel.js'

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
  .addBooleanOption((o) =>
    o
      .setName('adopt_role')
      .setDescription('Adopt an existing role of the same name even though people already hold it')
      .setRequired(false)
  )

// ---------------------------------------------------------------------------
// Rendering. Both of these are pure: same arguments, same string, no Discord.
// ---------------------------------------------------------------------------

const CHANNEL_WORDS = [
  ['create', 'to create'],
  ['rename', 'to rename'],
  ['move', 'to move'],
  ['grant', 'to open to the project role'],
  ['reuse', 'already right'],
]

const TASK_WORDS = [
  ['both', 'to rename and move'],
  ['move', 'to move'],
  ['rename', 'to rename'],
  ['grant', 'to open to the project role'],
  ['none', 'already right'],
]

/**
 * '9 to create, 1 to move' — counts per action, in the given order, zeros
 * dropped.
 *
 * An entry marked `opens` is renamed or moved AND opened to the project role in
 * the same single edit, so the count says so. Without that, "22 to rename and
 * move" reads as housekeeping while what it means is that 22 channels visible
 * only to their assignees become visible to everyone holding the project role —
 * at backfill, whoever was handed the legacy role by hand. The `grant` word
 * already says it, so a `grant` entry never carries `opens`.
 */
function summarise(entries, words) {
  const list = Array.isArray(entries) ? entries : []
  if (!list.length) return ''
  const byAction = new Map()
  for (const entry of list) {
    const bucket = byAction.get(entry?.action) ?? { n: 0, opens: 0 }
    bucket.n += 1
    if (entry?.opens) bucket.opens += 1
    byAction.set(entry?.action, bucket)
  }
  const parts = []
  for (const [action, word] of words) {
    const bucket = byAction.get(action)
    if (!bucket?.n) continue
    let text = `${bucket.n} ${word}`
    if (bucket.opens === bucket.n) text += ' (and open to the project role)'
    else if (bucket.opens) text += ` (${bucket.opens} of them also open to the project role)`
    parts.push(text)
  }
  return parts.join(', ')
}

/** 'Ada, Bob and 4 more' — never an unbounded list of names in a reply. */
function namesList(names, max = 12) {
  const list = (names ?? []).map((n) => String(n))
  if (!list.length) return 'nobody'
  if (list.length <= max) return list.join(', ')
  return `${list.slice(0, max).join(', ')}, and ${list.length - max} more`
}

/**
 * The role decision in words an operator can act on: which role gates the
 * section, and whether this run chose it, inherited it or refused to guess.
 */
function roleLine(role) {
  if (role.action === 'refuse') {
    return `Role: refused — ${role.reason || `"${role.name}" is a managed role.`}`
  }
  if (role.decision === 'stored') return `Role: reuse (this project's own) **${role.name}**`
  if (role.decision === 'empty') return `Role: reuse (already exists, nobody holds it) **${role.name}**`
  if (role.decision === 'adopt') {
    const held = role.holderIds?.length ?? 0
    return `Role: ADOPTING the existing **${role.name}** — ${held} member(s) hold it today`
  }
  return `Role: ${role.action} **${role.name}**`
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
  if (role) lines.push(roleLine(role))
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
  const opened = result?.opened ?? []
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

  // A rename or a move that also carried the role's allow is already counted
  // above as a rename or a move, so it is said here instead of added there:
  // one channel, two true things about it, not two channels.
  if (opened.length) {
    lines.push(
      `${opened.length} of those channel(s) were also opened to the project role in the same edit — they are now visible to everyone holding it.`
    )
  }

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
      // "3 revoked" cannot be put back by hand. Name them, and the ids are in
      // the log beside the names.
      if (sync?.revoked?.length) {
        lines.push(`Removed from the role: ${namesList(sync.revokedNames ?? sync.revoked)}.`)
      }
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

/**
 * Every warning also goes to the console, once, named by project.
 *
 * `capReply` always keeps blocks from the FRONT of the list, so on `all:true`
 * the last projects' blocks — refusals included — are dropped from every
 * posted version and the operator never sees them. The applier's own `note()`
 * already logs its failures; without this the PLANNER's refusals (a managed
 * name, a role that was not adopted, a slug clash) were the only record that
 * existed nowhere but a message that was never sent. A backfill has to stay
 * diagnosable after the fact.
 */
function logWarnings(project, warnings) {
  const who = project?.name ?? project?.id ?? 'project'
  for (const warning of warnings ?? []) console.warn(`[project-setup] ${who}: ${warning}`)
}

/**
 * The "… and N more not shown" line, so a truncated reply always admits it.
 *
 * The advice names the option but never a project NAME: `project:` takes an id
 * from its autocomplete, so a pasted name is answered with "No project
 * matches". Telling the operator to pick from the suggestions is the only
 * instruction that works.
 */
function droppedTail(dropped) {
  return `… and ${dropped} more not shown. Run **/project-setup** again and pick each remaining project from the **project:** option's suggestions.`
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

/**
 * A warning, never a refusal: the section still gets built, and a bot without
 * Administrator simply cannot see it afterwards.
 *
 * Every section category denies `@everyone` and carries no allow for the bot,
 * so without Administrator the bot loses sight of the ten channels it just
 * created: the pinned members panel fails, posts fail, and the recorder cannot
 * join a project meeting's voice channel. Granting the bot itself an overwrite
 * on the category is NOT the fix — a bot that cannot manage permissions cannot
 * write that overwrite either, so it would fail in exactly the case it targets.
 */
const NO_ADMINISTRATOR =
  '⚠ This bot does not have **Administrator**. Every project section denies **@everyone** and carries no allow for the bot, so the bot will not be able to see the private sections below once they exist: pinned panels and posts inside them fail silently, and meeting recording cannot join their voice channels. Give the bot **Administrator**, then run this again.'

/** True only when the bot's permissions were READ and Administrator is absent. */
function botLacksAdministrator(guild) {
  const has = guild?.members?.me?.permissions?.has
  if (typeof has !== 'function') return false
  return !guild.members.me.permissions.has(PermissionFlagsBits.Administrator)
}

async function pickProjects(interaction, cfg, dbArg, { all, picked }) {
  if (all) {
    const rows = (await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })) ?? []
    if (!rows.length) {
      await interaction.editReply({ content: 'No projects yet. Add one with **/projects** → Add project.' })
      return null
    }
    return rows
  }
  const row = await dbArg.project.findFirst({ where: { id: picked } }).catch(() => null)
  if (!row || row.guildConfigId !== cfg.id) {
    await interaction.editReply({
      content: `No project matches **${picked.slice(0, 80)}**. Start typing a project name and pick one from the list.`,
    })
    return null
  }
  return [row]
}

// ---------------------------------------------------------------------------
// The shared routine. `/project-setup`, `/create-project-categories`,
// `/create-project-role` and `/projects` → Add project all build a section
// through these functions and nothing else, so every guard below reaches every
// caller. A second copy of any of it would lose them silently.
// ---------------------------------------------------------------------------

/**
 * What every project in one run shares: the member-list fetch, the display-name
 * lookup and the bot's own id.
 *
 * `syncProjectRoleMembers` works out who to revoke from by reading the role's
 * member cache, so without a full fetch it sees no holders and revokes from
 * nobody.
 *
 * A PREVIEW fetches too, and that is not an optimisation to undo. The planner
 * decides whether to adopt an existing role of the project's name by counting
 * its holders, and that count also comes from the member cache: unfetched, a
 * role held by twenty people reads as empty, gets adopted, and its allow goes
 * on the new category — every holder of an unrelated role can then see the
 * section, and since no revoke runs on a preview the revoke guard never
 * notices. `members.fetch()` is a read; a preview that states a role decision
 * has to state the real one.
 *
 * Swallowing a failure here is exactly what the "fetch before sync" contract
 * exists to prevent: the sync would read an empty cache, revoke from nobody,
 * and report a clean run while a stale holder keeps the project role. So the
 * failure is kept, said out loud, the revoke pass does not run, and
 * `rolesFetched` goes false so nothing is adopted on a count nobody earned.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{preview?: boolean, botUserId?: string|null, adoptRole?: boolean}} [opts]
 */
export async function prepareSectionRun(guild, { preview = false, botUserId = null, adoptRole = false } = {}) {
  let fetchFailure = null
  try {
    await guild.members.fetch()
  } catch (e) {
    fetchFailure = e?.message || String(e)
    console.error('[project-setup] members.fetch:', e)
  }
  const nameFor = (id) => guild.members.cache.get(id)?.displayName ?? id
  // Set ONLY when the fetch demonstrably succeeded. The planner defaults it to
  // false, so a caller that forgets it refuses rather than guesses.
  return { preview, fetchFailure, rolesFetched: !fetchFailure, nameFor, botUserId, adoptRole }
}

/**
 * One project's setup: read its tasks, observe, plan, and (unless the run is a
 * preview) apply the plan, sync the role against the roster, and render the
 * block. Throws when a read fails or a step outside the applier's own
 * try/catches throws; the walk catches per project, a single-project caller
 * catches for itself.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} project the project row
 * @param {{db: object, cfg: {id: string}, run: Awaited<ReturnType<typeof prepareSectionRun>>}} deps
 * @returns {Promise<{block: string, plan: object, result?: object, roleSync?: object}>}
 */
export async function setupProjectSection(guild, project, { db: dbArg, cfg, run }) {
  const { preview, fetchFailure, rolesFetched = false, nameFor, botUserId, adoptRole = false } = run

  // Read fresh, per project, and never from the list the walk started with.
  // Two things depend on it, and both break on a stale read: during `all:true`
  // project A stores its brand-new category id partway through the walk, so a
  // list loaded before the walk would let project B adopt that category by
  // name, and the slug check below would miss a project added mid-run.
  const siblings = (await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })) ?? []
  const slug = projectSlug(project)
  const clashes = siblings.filter((p) => p && p.id !== project.id && projectSlug(p) === slug)
  if (clashes.length) {
    // Spec §13. Both projects would want the same ten channel names, so
    // whichever runs without stored ids adopts the other's channels and plans
    // a move — and they trade the same channels back and forth, two edits
    // each, on every run. Nothing is touched until a human picks a slug.
    const others = clashes.map((p) => `**${p.name}**`).join(', ')
    logWarnings(project, [
      `refused: channel slug "${slug}" is also used by ${clashes.map((p) => p?.name).join(', ')}, so nothing was changed.`,
    ])
    return {
      plan: null,
      // A REFUSAL, not a failure. Without this flag the single-project callers
      // (`/create-project-role`, `/projects` → Add project) print "the
      // category could not be built — run /project-setup once the bot has
      // Manage Channels and Manage Roles" above a block that says the slug
      // collides: permissions are not the problem and re-running changes
      // nothing until a human picks a different slug.
      refused: true,
      block: cut(
        `**${project?.name}** — refused: its channel slug \`${slug}\` is also ${clashes.length === 1 ? 'used by' : 'used by'} ${others}, so both would want the same ten section channel names and each run would drag them between the two categories. Nothing was changed. Give one of them a different docs folder in **/projects**, then run **/project-setup** again.`,
        REPLY_LIMIT
      ),
    }
  }
  const claimedIds = claimedSectionIds(siblings, project.id)

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

  const observed = observeProjectSection(guild, project, tasks, { rolesFetched, claimedIds })
  const plan = planProjectSection(project, observed, { adoptRole })

  if (preview) {
    if (adoptRole && fetchFailure) {
      extra.push(
        `This server's member list could not be read (${fetchFailure}), so who would gain and lose the role could not be worked out. Nothing would be adopted on this run either.`
      )
    }
    if (plan.role?.decision === 'adopt') {
      extra.push(await adoptionPreview(dbArg, project, plan.role, nameFor))
    }
    const previewWarnings = mergeWarnings(extra, plan.warnings)
    logWarnings(project, previewWarnings)
    return { plan, block: renderPlan(project, { ...plan, warnings: previewWarnings }) }
  }

  // The roster is passed on purpose: `members` is a tri-state, and omitting
  // it would leave every pinned members panel showing yesterday's list.
  const members = (await dbArg.projectMember.findByProject({ where: { projectId: project.id } })) ?? []
  if (fetchFailure) {
    extra.push(
      `This server's member list could not be read (${fetchFailure}), so nobody was removed from the project role. Run /project-setup again once the bot can read this server's members.`
    )
  }

  const result = await applyProjectSection(guild, project, plan, { db: dbArg, members, nameFor, botUserId })

  // The apply can run for minutes — up to twelve creates and twenty-odd
  // rate-limited edits — and the revoke half decides who is no longer a member
  // by comparing a live `role.members` read against THIS roster. Read against
  // the roster from before the apply, a `/project-members add` that landed
  // mid-run looks like "a holder who is not a member" and the role is taken
  // straight back off them; a `/project-members remove` is undone the same way,
  // in reverse. Both silently. So the roster is read again, here, and the sync
  // uses only this one.
  let roster = members
  let rosterFailure = null
  try {
    roster = (await dbArg.projectMember.findByProject({ where: { projectId: project.id } })) ?? []
  } catch (e) {
    // The first read worked, so the roster is stale rather than unknown — but
    // stale is exactly what must not drive a revoke.
    roster = members
    rosterFailure = e?.message || String(e)
    console.error(`[project-setup] re-reading the roster for ${project?.name}:`, e)
  }
  if (!sameRoster(members, roster)) {
    extra.push(
      `The members of "${project?.name}" changed while its section was being built, so the newer list was used for the role and the pinned panel.`
    )
    // `ensureMembersPanel` edits its own pin and swallows its own failures, so
    // running it twice costs one message edit and cannot make things worse.
    if (result.membersChannel) {
      await ensureMembersPanel(result.membersChannel, project, roster, { botUserId, nameFor }).catch(() => {})
    }
  }

  const truncatedRoster = roster.length >= ROSTER_LIMIT
  if (truncatedRoster) {
    extra.push(
      `Only the first ${ROSTER_LIMIT} members of "${project?.name}" could be read, so nobody was removed from the project role — members past that limit would have looked as though they had left the project.`
    )
  }
  if (rosterFailure) {
    extra.push(
      `The members of "${project?.name}" could not be read again after the section was built (${rosterFailure}), so nobody was removed from the project role — the list in hand was from before the build.`
    )
  }

  const roleId = result.role?.id ?? null
  // Say it as a flag, not by padding the roster with every current holder:
  // "do not revoke" is what this means, and a roster the service happens to
  // find nothing to revoke from would stop meaning that the moment the
  // service changed how it reads its holders.
  const grantOnly = Boolean(fetchFailure) || truncatedRoster || Boolean(rosterFailure)
  const roleSync = await syncProjectRoleMembers(guild, project, roster, {
    roleId,
    revoke: !grantOnly,
  })
  if (grantOnly) roleSync.revokeSkipped = true
  // Ids are in the log; the reply needs names, and only the command has them.
  roleSync.revokedNames = roleSync.revoked.map((id) => nameFor(id))

  const warnings = mergeWarnings(extra, plan.warnings, result.warnings)
  logWarnings(project, warnings)
  const block = renderResult(project, { ...result, warnings, roleSync })
  return { block, plan, result, roleSync }
}

/** Two roster reads holding the same people in the same project roles. */
function sameRoster(a, b) {
  const key = (rows) =>
    (rows ?? [])
      .map((m) => `${m?.discordId ?? ''}:${m?.role ?? ''}`)
      .sort()
      .join('|')
  return key(a) === key(b)
}

/**
 * What `preview:true adopt_role:true` prints before anything happens: the
 * people who would LOSE the role, by display name, and the people who would
 * gain it. An operator cannot consent to "2 revoked"; they can consent to a
 * list of names. Read-only — the roster read is the same one the real run does.
 */
async function adoptionPreview(dbArg, project, role, nameFor) {
  let roster = []
  try {
    roster = (await dbArg.projectMember.findByProject({ where: { projectId: project.id } })) ?? []
  } catch (e) {
    return `Adopting **${role.name}** would change who holds it, but this project's members could not be read (${e?.message ?? String(e)}), so who gains and loses it cannot be shown. Do not run this without preview until that read works.`
  }
  const wanted = new Set(roster.map((m) => m?.discordId).filter(Boolean))
  const holders = Array.isArray(role.holderIds) ? role.holderIds : []
  const held = new Set(holders)
  const losing = holders.filter((id) => !wanted.has(id))
  const gaining = [...wanted].filter((id) => !held.has(id))
  return `Adopting the existing role **${role.name}**: ${losing.length} member(s) would LOSE it — ${namesList(losing.map(nameFor))} — and ${gaining.length} would gain it — ${namesList(gaining.map(nameFor))}. Everyone who keeps or gains it can see this project's section.`
}

/**
 * One project, start to finish, for a caller that has a single project row in
 * hand (a new project from `/projects`, a named one from
 * `/create-project-role`): the member fetch, then the same per-project routine
 * the walk runs. Throws as `setupProjectSection` does.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} project
 * It never passes `adoptRole`, and must not be given the option: `/projects` →
 * Add project and `/create-project-role` run through here, and creating a
 * project must never be able to take a role off somebody or show a new section
 * to holders of an unrelated role that happens to share its name.
 *
 * @param {{db: object, cfg: {id: string}, botUserId?: string|null}} deps
 */
export async function setupOneProject(guild, project, { db: dbArg, cfg, botUserId = null }) {
  const run = await prepareSectionRun(guild, { preview: false, botUserId, adoptRole: false })
  return setupProjectSection(guild, project, { db: dbArg, cfg, run })
}

/**
 * The whole of `/project-setup` once its options are read: pick the projects,
 * fetch the member list, walk them one at a time, and reply.
 * `/project-setup` and `/create-project-categories` (as `{ all: true }`) both
 * run exactly this.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction already deferred
 * `adoptRole` reaches here only from `/project-setup`'s own `adopt_role`
 * option. `/create-project-categories` calls this with `{ all: true }` and
 * nothing else, so the walk it runs can never adopt a held role either.
 *
 * @param {{all?: boolean, picked?: string, preview?: boolean, adoptRole?: boolean}} opts
 * @param {{db?: object, getConfig?: (guildId: string) => Promise<{id: string}>}} deps
 */
export async function runProjectSetup(
  interaction,
  { all = false, picked = '', preview = false, adoptRole = false } = {},
  { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}
) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getConfig(guild.id)
  const projects = await pickProjects(interaction, cfg, dbArg, { all, picked })
  if (!projects) return

  const run = await prepareSectionRun(guild, {
    preview,
    adoptRole,
    botUserId: interaction.client?.user?.id ?? null,
  })

  const blocks = []
  if (botLacksAdministrator(guild)) blocks.push(NO_ADMINISTRATOR)
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
      const { block } = await setupProjectSection(guild, project, { db: dbArg, cfg, run })
      blocks.push(block)
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

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const all = interaction.options.getBoolean('all') ?? false
  const preview = interaction.options.getBoolean('preview') ?? false
  const adoptRole = interaction.options.getBoolean('adopt_role') ?? false
  const picked = String(interaction.options.getString('project') || '').trim()
  if (!picked && !all) {
    return interaction.editReply({
      content:
        'Pick a **project**, or pass **all:true** to set up every project in this server. Add **preview:true** to see the plan without changing anything.',
    })
  }

  return runProjectSetup(interaction, { all, picked, preview, adoptRole }, { db: dbArg, getConfig })
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
