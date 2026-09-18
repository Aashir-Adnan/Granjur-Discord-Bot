/**
 * The section planner: given a project and a plain snapshot of what the guild
 * already has, decide what to create, rename or move so the project owns a
 * category of its own.
 *
 * The planner is pure on purpose: nothing above the "the applier" banner near
 * the bottom of this file touches Discord, the database, the clock or
 * randomness, so the whole decision is testable without a guild. Below that
 * banner live the three impure halves — `observeProjectSection` reads the
 * guild into the plain snapshot the planner wants, `applyProjectSection`
 * performs the plan, and `syncProjectRoleMembers` keeps the role in step with
 * `projectmember`.
 *
 * The plan, per spec §7:
 *   role:     { action: 'create' | 'reuse' | 'refuse', name, id?, reason? }
 *   category: { action: 'create' | 'reuse' | 'rename', id?, name }
 *   channels: [{ key, action: 'create' | 'reuse' | 'rename' | 'move', id?, name, type }]
 *   tasks:    [{ taskId, channelId, action: 'rename' | 'move' | 'both' | 'none', name }]
 *   warnings: string[]
 *
 * Every non-`reuse` channel entry carries the FINAL desired `name`, so the
 * applier can send `{ name, parent }` in a single `edit()` whatever the action
 * is — Discord allows only two channel edits per ten minutes, so a rename plus
 * a separate move would burn the whole budget on one channel.
 */
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { slugify } from '../utils/docPath.js'
import { taskChannelName, MAX_CHANNEL_NAME } from '../utils/taskChannelName.js'
import { MANAGED_ROLES } from '../utils/roleSync.js'
import { ensureMembersPanel } from './projectMembersPanel.js'

/** Discord allows 50 channels per category; stop one short so a repair run never wedges. */
export const CATEGORY_SOFT_CAP = 49

/** Discord's cap on a category name, the same 100 as a channel name. */
const MAX_CATEGORY_NAME = 100

/** The ten section channels, in creation order. */
export const SECTIONS = [
  { key: 'members', suffix: 'members', type: 'text' },
  { key: 'documentation', suffix: 'documentation', type: 'text' },
  { key: 'meetings', suffix: 'meetings', type: 'text' },
  { key: 'meetingVoice', suffix: 'meeting-voice', type: 'voice' },
  { key: 'frontendChat', suffix: 'frontend-chat', type: 'text' },
  { key: 'frontendVoice', suffix: 'frontend-voice', type: 'voice' },
  { key: 'backendChat', suffix: 'backend-chat', type: 'text' },
  { key: 'backendVoice', suffix: 'backend-voice', type: 'voice' },
  { key: 'databaseChat', suffix: 'database-chat', type: 'text' },
  { key: 'databaseVoice', suffix: 'database-voice', type: 'voice' },
]

const fold = (s) => String(s ?? '').trim().toLowerCase()
const MANAGED_FOLDED = new Set(MANAGED_ROLES.map(fold))

/**
 * Cut to `max` UTF-16 units without leaving half of a surrogate pair behind.
 * Exported because `/project-setup` truncates replies that carry the same
 * project names, and a second copy would be a second thing to get wrong.
 */
export function cut(text, max) {
  if (text.length <= max) return text
  const sliced = text.slice(0, max)
  const last = sliced.charCodeAt(sliced.length - 1)
  // A lone high surrogate would render as a replacement character.
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced
}

/** The project's channel-name slug: its stored docsSlug, else one from its name. */
function projectSlug(project) {
  return project?.docsSlug || slugify(project?.name)
}

/** '📂 FRAMEWORK'. The project name upper-cased behind the folder emoji. */
export function categoryNameFor(project) {
  return cut(`📂 ${String(project?.name ?? '').trim().toUpperCase()}`, MAX_CATEGORY_NAME)
}

/**
 * '<slug>-<suffix>', e.g. 'framework-frontend-chat'. A slug long enough to push
 * the name past Discord's 100 characters is truncated — the suffix never is,
 * because it is what tells the channels apart.
 */
export function channelNameFor(project, suffix) {
  const slug = projectSlug(project)
  const full = `${slug}-${suffix}`
  if (full.length <= MAX_CHANNEL_NAME) return full
  const room = MAX_CHANNEL_NAME - suffix.length - 1
  if (room <= 0) return cut(suffix, MAX_CHANNEL_NAME)
  return `${slug.slice(0, room).replace(/-+$/, '')}-${suffix}`
}

/**
 * The project a channel belongs to: the one whose category is the channel's
 * parent, or the category itself. Null-safe, and null when nothing matches.
 * Shared here because several commands need the same answer.
 *
 * @param {Array<{discordCategoryId?: string|null}>} projects
 * @param {{id?: string|null, parentId?: string|null}|null} channel
 */
export function projectFromChannel(projects, channel) {
  if (!channel) return null
  const list = Array.isArray(projects) ? projects : []
  const parentId = channel.parentId ?? null
  const ownId = channel.id ?? null
  return (
    list.find(
      (p) =>
        p &&
        p.discordCategoryId &&
        (p.discordCategoryId === parentId || p.discordCategoryId === ownId)
    ) ?? null
  )
}

function planRole(project, observed, warnings) {
  const name = String(project?.name ?? '').trim()
  if (MANAGED_FOLDED.has(fold(name))) {
    const reason = `"${name}" is a managed role — one of the job roles the bot assigns — so it cannot also be a project role.`
    warnings.push(
      `Project "${name}" shares its name with a managed role, so no project role was planned. Rename the project to give it its own access.`
    )
    return { action: 'refuse', name, reason }
  }
  if (observed?.roleId) return { action: 'reuse', id: observed.roleId, name }
  const existing = observed?.roleNames?.get?.(name)
  if (existing) return { action: 'reuse', id: existing, name }
  return { action: 'create', name }
}

function planCategory(project, observed) {
  const name = categoryNameFor(project)
  const id = observed?.categoryId ?? null
  if (!id) return { action: 'create', name }
  // Found by id, never by name, so a category renamed by hand is still ours.
  if (observed.categoryName === name) return { action: 'reuse', id, name }
  return { action: 'rename', id, name }
}

function planChannels(project, observed) {
  const parentId = observed?.categoryId ?? null
  const seen = observed?.channels ?? {}
  return SECTIONS.map(({ key, suffix, type }) => {
    const name = channelNameFor(project, suffix)
    const channel = seen[key]
    if (!channel?.id) return { key, action: 'create', name, type }
    const nameOk = channel.name === name
    // With no category yet there is nothing to sit under, so the channel moves.
    const parentOk = Boolean(parentId) && channel.parentId === parentId
    if (nameOk && parentOk) return { key, action: 'reuse', id: channel.id, name, type }
    if (parentOk) return { key, action: 'rename', id: channel.id, name, type }
    return { key, action: 'move', id: channel.id, name, type }
  })
}

function planTasks(project, observed, channels, warnings) {
  const parentId = observed?.categoryId ?? null
  const tasks = Array.isArray(observed?.tasks) ? observed.tasks : []
  // Every section channel this plan puts INTO the category takes a slot: the
  // ones created there, and the ones moved in from somewhere else. A renamed or
  // reused one is already inside, so `categoryChannelCount` has it already.
  const arriving = channels.filter((c) => c.action === 'create' || c.action === 'move').length
  // What is left of the category once this plan's own channels are in it.
  let room = Math.max(
    0,
    CATEGORY_SOFT_CAP - Number(observed?.categoryChannelCount ?? 0) - arriving
  )

  const taken = new Set(observed?.takenNames ?? [])
  // The ten section names are spoken for, so a project slugged `feature` with a
  // task titled "Members" cannot land on `feature-members` in the same run.
  for (const channel of channels) taken.add(channel.name)
  // Names this run has handed out. Separate from `taken` because a task may
  // free the name it already carries, but never one promised to another task.
  const assigned = new Set()
  const planned = []
  let leftBehind = 0

  for (const task of tasks) {
    if (!task?.channelId) continue
    // A channel does not collide with the name it already carries — unless an
    // earlier task in this same run has already been given that name.
    const pool = new Set(taken)
    if (task.channelName && !assigned.has(task.channelName)) pool.delete(task.channelName)
    const name = taskChannelName({
      type: task.type,
      title: task.title,
      taskId: task.id,
      taken: pool,
    })
    assigned.add(name)
    taken.add(name)

    const nameOk = task.channelName === name
    const parentOk = Boolean(parentId) && task.parentId === parentId
    let action = nameOk ? (parentOk ? 'none' : 'move') : parentOk ? 'rename' : 'both'

    if (action === 'move' || action === 'both') {
      if (room > 0) room -= 1
      else {
        // No room: leave it where it is, but still give it a readable name.
        action = action === 'both' ? 'rename' : 'none'
        leftBehind += 1
      }
    }
    planned.push({ taskId: task.id, channelId: task.channelId, action, name })
  }

  if (leftBehind > 0) {
    warnings.push(
      `Project "${project?.name}" is at Discord's category cap (${CATEGORY_SOFT_CAP} channels), so ${leftBehind} task channel${leftBehind === 1 ? '' : 's'} stayed where ${leftBehind === 1 ? 'it is' : 'they are'} — the category is full.`
    )
  }
  return planned
}

/**
 * Decide the whole section for one project.
 *
 * @param {{id: string, name: string, docsSlug?: string|null}} project
 * @param {{
 *   roleId?: string|null,
 *   roleNames?: Map<string,string>,
 *   categoryId?: string|null,
 *   categoryName?: string|null,
 *   categoryChannelCount?: number,
 *   channels?: Object<string, {id: string, name: string, parentId: string|null}>,
 *   tasks?: Array<{id: string, title: string, type: string, channelId: string, channelName: string, parentId: string|null}>,
 *   takenNames?: Set<string>,
 * }} observed a plain snapshot the caller gathers — no Discord objects
 */
export function planProjectSection(project, observed = {}) {
  const warnings = []
  const role = planRole(project, observed, warnings)
  const category = planCategory(project, observed)
  const channels = planChannels(project, observed)
  const tasks = planTasks(project, observed, channels, warnings)
  return { role, category, channels, tasks, warnings }
}

// ---------------------------------------------------------------------------
// The applier. Everything below here talks to Discord.
// ---------------------------------------------------------------------------

/**
 * What the project role may do inside its own category. The section channels
 * are created with no overwrites of their own, so they inherit these.
 */
const ROLE_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
]

const REASON = 'Project section'

/** Collect a failure: one line in the log, one line for whoever ran the command. */
function note(warnings, what, e) {
  const message = e?.message || String(e)
  console.warn(`[projectSection] ${what}: ${message}`)
  warnings.push(`${what}: ${message}`)
}

/** A discord.js Collection or a plain Map, read the same way. */
const valuesOf = (cache) => (cache?.values ? [...cache.values()] : [])

/**
 * `project.discordChannels` is a JSON column: some drivers hand back an object,
 * some the raw string. Anything unparseable is treated as "nothing stored yet".
 */
function storedChannels(project) {
  const raw = project?.discordChannels
  if (!raw) return {}
  if (typeof raw === 'object') return { ...raw }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? { ...parsed } : {}
  } catch {
    return {}
  }
}

/**
 * The category's overwrites.
 *
 * With a role: the two from spec §5 — @everyone denied, the role allowed.
 * Refused a role, and holding none: nothing at all. The project's name is a
 * managed job role, so a role by that name will never exist, and a deny with
 * nothing to allow would be a category nobody could see.
 * No role because creating it failed: the deny alone. That is a transient
 * failure, the section is meant to be private, and the next run adds the allow.
 */
function categoryOverwrites(guild, roleId, refused = false) {
  if (!roleId && refused) return []
  const overwrites = [
    // The guild id is @everyone, a ROLE. Passing the wrong overwrite type makes
    // Discord drop the overwrite without an error — that is what hid
    // feature-f56be0 on 2026-09-04.
    { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
  ]
  if (roleId) overwrites.push({ id: roleId, type: OverwriteType.Role, allow: ROLE_ALLOW })
  return overwrites
}

/**
 * True only when we can see the category's overwrites AND one the section
 * requires is missing from them.
 *
 * Nothing required means nothing to assert — the refused-role case holds no
 * overwrites at all, so there is no edit to make. An unreadable cache is left
 * alone too: churning an edit on a category we cannot inspect would spend the
 * budget every run.
 */
function missingOverwrites(category, required) {
  if (!required.length) return false
  const cache = category?.permissionOverwrites?.cache
  if (!cache?.has) return false
  return required.some((o) => !cache.has(o.id))
}

/**
 * What to send when repairing an adopted category's overwrites.
 *
 * discord.js sends `permission_overwrites` as a whole array and Discord
 * REPLACES the set rather than merging it, so sending `required` alone would
 * silently drop anything a human added to the category by hand — a
 * single-member grant, a moderator role. Carry those through untouched;
 * discord.js accepts a `PermissionsBitField` as a `PermissionResolvable`, so
 * there is nothing to convert. The required entries win for the ids they cover.
 */
function mergedOverwrites(category, required) {
  const cache = category?.permissionOverwrites?.cache
  if (!cache?.values) return required
  const ours = new Set(required.map((o) => o.id))
  const kept = []
  for (const existing of cache.values()) {
    if (!existing || ours.has(existing.id)) continue
    kept.push({ id: existing.id, type: existing.type, allow: existing.allow, deny: existing.deny })
  }
  return [...required, ...kept]
}

/**
 * Read the guild into the plain snapshot `planProjectSection` expects.
 *
 * Stored ids win: the bot repairs what it created by id, so a channel someone
 * renamed by hand is still recognised. Only an id that no longer resolves falls
 * back to matching the name the bot would have given it.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{id: string, name: string, docsSlug?: string|null, discordCategoryId?: string|null, discordRoleId?: string|null, discordChannels?: object|string|null}} project
 * @param {Array<{id: string, title: string, type?: string, discordChannelId?: string|null}>} tasks
 *   the project's task rows; one without a channel, or with a channel that no
 *   longer exists, is left out of the snapshot because there is nothing to move.
 */
export function observeProjectSection(guild, project, tasks = []) {
  const all = valuesOf(guild?.channels?.cache)
  const byId = new Map(all.map((c) => [c.id, c]))

  const roleNames = new Map()
  let roleId = null
  for (const role of valuesOf(guild?.roles?.cache)) {
    if (!roleNames.has(role.name)) roleNames.set(role.name, role.id)
    if (project?.discordRoleId && role.id === project.discordRoleId) roleId = role.id
  }

  let category = project?.discordCategoryId ? byId.get(project.discordCategoryId) ?? null : null
  if (!category) {
    const wanted = categoryNameFor(project)
    category = all.find((c) => c.type === ChannelType.GuildCategory && c.name === wanted) ?? null
  }
  const categoryId = category?.id ?? null

  const stored = storedChannels(project)
  const channels = {}
  for (const { key, suffix } of SECTIONS) {
    const wanted = channelNameFor(project, suffix)
    let channel = stored[key] ? byId.get(stored[key]) ?? null : null
    if (!channel) {
      channel = all.find((c) => c.name === wanted && c.type !== ChannelType.GuildCategory) ?? null
    }
    if (channel) channels[key] = { id: channel.id, name: channel.name, parentId: channel.parentId ?? null }
  }

  const observedTasks = []
  for (const task of tasks || []) {
    const channelId = task?.discordChannelId ?? task?.channelId ?? null
    if (!channelId) continue
    const channel = byId.get(channelId)
    if (!channel) continue
    observedTasks.push({
      id: task.id,
      title: task.title,
      type: task.type ?? (task.is_bug ? 'bug' : 'feature'),
      channelId: channel.id,
      channelName: channel.name,
      parentId: channel.parentId ?? null,
    })
  }

  return {
    roleId,
    roleNames,
    categoryId,
    categoryName: category?.name ?? null,
    categoryChannelCount: categoryId ? all.filter((c) => c.parentId === categoryId).length : 0,
    channels,
    tasks: observedTasks,
    takenNames: new Set(all.map((c) => c.name)),
  }
}

/**
 * Perform a plan: role, then category, then the ten section channels, then the
 * task channels, then one write of the ids, then the members panel. Every step
 * has its own try/catch, so a project missing one permission still gets
 * everything else, and a repeat run finishes what was left.
 *
 * Nothing here deletes a channel or a role.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} project the project row, for its id and its stored ids
 * @param {ReturnType<typeof planProjectSection>} plan
 * `members` has NO default on purpose: omitting it means "this caller has no
 * roster, leave the pinned panel alone", while `[]` means "genuinely empty, say
 * so". A default of `[]` would let a repair run that only wanted the channels
 * fixed rewrite every panel it touched to "No members yet."
 *
 * @param {{db: object, members?: Array<{discordId: string, role: string}>, nameFor?: (id: string) => string, botUserId?: string|null}} deps
 * @returns {Promise<{role: object|null, category: object|null, created: string[], renamed: string[], moved: string[], tasks: number, warnings: string[]}>}
 */
export async function applyProjectSection(
  guild,
  project,
  plan,
  { db, members, nameFor = (id) => id, botUserId = null } = {}
) {
  const result = { role: null, category: null, created: [], renamed: [], moved: [], tasks: 0, warnings: [] }
  const channelIds = storedChannels(project)
  const resolved = new Map()

  // 1. The role.
  const rolePlan = plan?.role ?? { action: 'refuse', name: project?.name }
  try {
    if (rolePlan.action === 'refuse') {
      // `refuse` is about the NAME — "do not create or reuse a role called
      // this" — not about the project. A project that already had a role and
      // was then renamed onto a managed job role still has that role, and
      // taking it off the category would hide the whole section.
      const kept = project?.discordRoleId ? guild.roles.cache.get(project.discordRoleId) ?? null : null
      result.role = kept
      // Only the "kept" case says something the planner's refusal warning does
      // not. Restating the refusal in different words burns one of the five
      // warning slots a caller shows, which can push a real
      // `channel "x": Missing Permissions` into the "and N more" tail.
      if (kept) {
        result.warnings.push(
          `${rolePlan.reason || `"${rolePlan.name}" is a managed role.`} The project kept the role it already had.`
        )
      }
    } else if (rolePlan.action === 'reuse') {
      // The id came from what we just observed, so it resolves; the stub is for
      // the case where it went away between the read and the write.
      result.role = guild.roles.cache.get(rolePlan.id) ?? { id: rolePlan.id, name: rolePlan.name }
    } else {
      result.role = await guild.roles.create({ name: rolePlan.name, mentionable: true, reason: REASON })
    }
  } catch (e) {
    note(result.warnings, `role "${rolePlan.name}"`, e)
  }
  const roleId = result.role?.id ?? null
  const refused = rolePlan.action === 'refuse'

  // 2. The category.
  const categoryPlan = plan?.category ?? null
  try {
    if (categoryPlan?.action === 'create') {
      result.category = await guild.channels.create({
        name: categoryPlan.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: categoryOverwrites(guild, roleId, refused),
        reason: REASON,
      })
      result.created.push(categoryPlan.name)
    } else if (categoryPlan?.id) {
      const existing = guild.channels.cache.get(categoryPlan.id) ?? null
      if (!existing) throw new Error(`category ${categoryPlan.id} no longer exists`)
      result.category = existing
      const needsName = categoryPlan.action === 'rename'
      // A role created on a later run has to reach a category that predates
      // it, and a category that lost its @everyone deny has to get it back.
      const required = categoryOverwrites(guild, roleId, refused)
      const needsPerms = missingOverwrites(existing, required)
      if (needsName || needsPerms) {
        const payload = { name: categoryPlan.name }
        if (needsPerms) payload.permissionOverwrites = mergedOverwrites(existing, required)
        await existing.edit(payload)
        if (needsName) result.renamed.push(categoryPlan.name)
      }
    }
  } catch (e) {
    note(result.warnings, `category "${categoryPlan?.name ?? ''}"`, e)
  }
  const categoryId = result.category?.id ?? null

  if (!categoryId) {
    // Without a category there is nowhere to put anything, and `parent: null`
    // would tip every existing channel out of the category it is in now.
    result.warnings.push(
      `No category for "${project?.name}", so its channels were left where they are. Run /project-setup again once the bot can create channels.`
    )
  } else {
    // 3. The ten section channels. One `edit` each, carrying name AND parent
    //    together: Discord allows two channel edits per ten minutes, so a
    //    rename followed by a move would burn the whole budget on one channel
    //    and leave a doubly-wrong channel misnamed until the next run.
    for (const entry of plan?.channels ?? []) {
      try {
        if (entry.action === 'reuse') {
          channelIds[entry.key] = entry.id
          resolved.set(entry.key, guild.channels.cache.get(entry.id) ?? null)
          continue
        }
        if (entry.action === 'create') {
          const channel = await guild.channels.create({
            name: entry.name,
            type: entry.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
            parent: categoryId,
            reason: REASON,
          })
          channelIds[entry.key] = channel.id
          resolved.set(entry.key, channel)
          result.created.push(entry.name)
          continue
        }
        const channel = guild.channels.cache.get(entry.id)
        if (!channel) throw new Error(`channel ${entry.id} no longer exists`)
        await channel.edit({ name: entry.name, parent: categoryId })
        channelIds[entry.key] = channel.id
        resolved.set(entry.key, channel)
        ;(entry.action === 'move' ? result.moved : result.renamed).push(entry.name)
      } catch (e) {
        note(result.warnings, `channel "${entry.name}"`, e)
      }
    }

    // 4. The task channels. Same single edit, and they keep the per-member
    //    overwrites they already carry — only name and parent are ever set.
    for (const task of plan?.tasks ?? []) {
      if (task.action === 'none') continue
      try {
        const channel = guild.channels.cache.get(task.channelId)
        if (!channel) throw new Error(`channel ${task.channelId} no longer exists`)
        // A `rename` at the category cap means "readable name, stay put", so
        // the parent it goes back with is the one it already has.
        const parent = task.action === 'rename' ? channel.parentId ?? null : categoryId
        await channel.edit({ name: task.name, parent })
        result.tasks += 1
        ;(task.action === 'rename' ? result.renamed : result.moved).push(task.name)
      } catch (e) {
        note(result.warnings, `task channel "${task.name}"`, e)
      }
    }
  }

  // 5. One write, at the end, of everything we know — including ids that were
  //    already stored, so a run that got halfway still records what it made.
  if (db?.project?.update) {
    try {
      await db.project.update({
        where: { id: project.id },
        data: {
          discordCategoryId: categoryId ?? project?.discordCategoryId ?? null,
          discordRoleId: roleId ?? project?.discordRoleId ?? null,
          discordChannels: channelIds,
        },
      })
    } catch (e) {
      note(result.warnings, 'saving the section ids', e)
    }
  } else {
    // Silently skipping this would hand the caller a section rebuilt from
    // scratch on every run with no hint why.
    result.warnings.push(
      `The section ids for "${project?.name}" were not saved — no database was passed to the applier, so the next run will rebuild the section instead of repairing it.`
    )
  }

  // 6. The members panel, only when the caller actually brought a roster.
  //    `ensureMembersPanel` swallows its own failures; the catch is for a
  //    members channel that is somehow not a text channel.
  const membersChannel =
    resolved.get('members') ?? (channelIds.members ? guild.channels.cache.get(channelIds.members) ?? null : null)
  if (membersChannel && members !== undefined) {
    try {
      await ensureMembersPanel(membersChannel, project, members, { botUserId, nameFor })
    } catch (e) {
      note(result.warnings, 'members panel', e)
    }
  }

  return result
}

/**
 * Bring the project role in line with `projectmember` in both directions: grant
 * it to members who lack it, take it from holders who are no longer on the
 * project. A member the bot cannot touch is collected, never thrown — one
 * member whose roles sit above the bot's must not stop the rest.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{name?: string}} project only for the log line
 * @param {Array<{discordId: string}>} members the project's member rows
 * @param {{roleId: string|null}} opts
 * @returns {Promise<{granted: string[], revoked: string[], failed: string[]}>}
 */
export async function syncProjectRoleMembers(guild, project, members = [], { roleId } = {}) {
  const out = { granted: [], revoked: [], failed: [] }
  if (!roleId) return out

  const role = guild?.roles?.cache?.get?.(roleId) ?? null
  // discord.js takes an id as happily as a role; the object is needed only to
  // see who already holds it, so an unresolvable id can still grant.
  const target = role ?? roleId
  // `role.members` is drawn from the member cache, so the caller must have done
  // a `guild.members.fetch()` first or this sees no holders and revokes nobody.
  const holders = new Map(role?.members?.entries?.() ?? [])
  const wanted = new Set((members || []).map((m) => m?.discordId).filter(Boolean))

  const fail = (id, e) => {
    const message = e?.message || String(e)
    console.warn(`[projectSection] role sync for "${project?.name}" — ${id}: ${message}`)
    out.failed.push(`${id} (${message})`)
  }

  for (const id of wanted) {
    if (holders.has(id)) continue
    try {
      const member = await guild.members.fetch(id)
      if (!member) throw new Error('not in this server')
      await member.roles.add(target)
      out.granted.push(id)
    } catch (e) {
      fail(id, e)
    }
  }

  for (const [id, member] of holders) {
    if (wanted.has(id)) continue
    try {
      await member.roles.remove(target)
      out.revoked.push(id)
    } catch (e) {
      fail(id, e)
    }
  }

  return out
}
