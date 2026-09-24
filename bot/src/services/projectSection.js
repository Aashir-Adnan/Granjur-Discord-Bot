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
 *   role:     { action: 'create' | 'reuse' | 'refuse', name, id?, reason?,
 *               decision?: 'create' | 'stored' | 'empty' | 'adopt',
 *               kind?: 'managed-name' | 'role', gateRoleId, holderIds? }
 *   category: { action: 'create' | 'reuse' | 'rename', id?, name }
 *   buckets:  [{ key, storeKey, action: 'create' | 'reuse' | 'rename', id?, name }]  (table order)
 *   channels: [{ key, action: 'create' | 'reuse' | 'rename' | 'move' | 'grant', id?, name, type, opens? }]
 *   tasks:    [{ taskId, channelId, action: 'rename' | 'move' | 'both' | 'grant' | 'none', name, topic, bucket, opens?, retire? }]
 *   warnings: string[]
 *
 * A ticket lives in its STATUS bucket, not in the section category: `bucket` is
 * the key of the one its status files it into, and an action of `move`/`both`
 * means "not in that bucket yet" — a bucket being created this run has no id,
 * so nothing can already be inside it. `retire: true` marks a ticket arriving
 * in Done without a `channelRetireAt` stamp; a stamped one is never re-stamped.
 *
 * `gateRoleId` is the one answer to "which role will this section be gated on";
 * the channel planner and the applier both read it, so they cannot disagree
 * about the same run. `grant` means one edit carrying nothing but overwrites,
 * and `opens` means a rename or a move whose single edit ALSO carries the
 * role's allow — a permission change that the preview and the reply have to
 * name out loud, because "22 to rename and move" does not sound like one.
 *
 * Every non-`reuse` channel entry carries the FINAL desired `name`, so the
 * applier can send `{ name, parent }` in a single `edit()` whatever the action
 * is — Discord allows only two channel edits per ten minutes, so a rename plus
 * a separate move would burn the whole budget on one channel.
 */
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { slugify } from '../utils/docPath.js'
import { taskChannelName, taskChannelTopic, isTicketChannel, MAX_CHANNEL_NAME } from '../utils/taskChannelName.js'
import { MANAGED_ROLES } from '../utils/roleSync.js'
import { ensureMembersPanel } from './projectMembersPanel.js'
import { CATEGORY_SOFT_CAP } from '../constants.js'
// `clientAccess.js` imports `db/index.js`; this module already does through
// `projectMembersPanel.js`, so this adds no new database import to a leaf.
import { CLIENT_TEXT_ALLOW_OBJ, CLIENT_VOICE_ALLOW_OBJ, ensureManualPinned } from './clientAccess.js'
import { cut, storedChannels } from '../utils/projectStore.js'
import { BUCKETS, bucketFor, bucketByKey, bucketNameFor, bucketIdsOf, isDoneBucket } from '../utils/statusBuckets.js'
import { retireTicketChannel } from './ticketRetire.js'

// The cap lives in `constants.js`, a leaf: `taskTicketChannel.js` needs it too,
// and importing this module into that leaf helper pulled the whole database
// layer (and the production `.env`) into a test that touches no database.
export { CATEGORY_SOFT_CAP }

// `cut` and `storedChannels` moved to utils/projectStore.js (a leaf); re-exported
// here so every existing importer of this module is unchanged.
export { cut, storedChannels }

/** Discord's cap on a category name, the same 100 as a channel name. */
const MAX_CATEGORY_NAME = 100

/** The thirteen section channels, in creation order. */
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
  { key: 'support', suffix: 'support', type: 'text' },
  { key: 'supportVoice', suffix: 'support-voice', type: 'voice' },
  { key: 'casual', suffix: 'casual-chat', type: 'text' },
]

/**
 * The channels a project's clients can see — the support pair and the casual
 * chat. Access is a member overwrite per client row; everything that grants,
 * revokes or repairs client access iterates this list, so a channel is made
 * client-visible by adding its key here and nowhere else.
 */
export const CLIENT_SECTION_KEYS = ['support', 'supportVoice', 'casual']

const fold = (s) => String(s ?? '').trim().toLowerCase()
const MANAGED_FOLDED = new Set(MANAGED_ROLES.map(fold))

/**
 * The project's channel-name slug: its stored docsSlug, else one from its name.
 *
 * Exported because this is the EFFECTIVE slug — a legacy project with a NULL
 * `docsSlug` still occupies `slugify(name)`, and every caller that checks for a
 * slug collision has to compare the same thing the channel names are built
 * from. Comparing raw `docsSlug` columns lets `UBS-Doc` and a NULL-slugged
 * `UBS Doc` both claim `ubs-doc`, and then each run of `/project-setup` drags
 * the same ten channels back into its own category.
 */
export function projectSlug(project) {
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
 * The project a channel belongs to: the one whose section category — or any of
 * its three status buckets — is the channel's parent, or is the channel
 * itself. A thread is resolved to the channel it lives in first, since a
 * thread's `parentId` is that channel, not the category. Null-safe, and null
 * when nothing matches.
 *
 * The buckets have to count: since [[status-buckets]] a ticket channel is
 * parented to `bucketOpen`/`bucketInProgress`/`bucketDone`, never to the
 * section category, so matching on `discordCategoryId` alone would stop
 * `/project-members` and `/meeting-channel` inferring the project from inside
 * any ticket channel at all.
 *
 * Null too when MORE than one project claims one of those ids: nothing makes
 * `project.discordCategoryId` unique (migration 019 adds no index), and the
 * bucket ids live in the free-form `discordChannels` map, so a guess could
 * hand a member the wrong project's role. The caller then falls back to asking
 * which project is meant.
 *
 * Shared here because several commands need the same answer.
 *
 * @param {Array<{id?: string, discordCategoryId?: string|null, discordChannels?: object|string|null}>} projects
 * @param {{id?: string|null, parentId?: string|null, isThread?: () => boolean, parent?: object|null}|null} channel
 */
export function projectFromChannel(projects, channel) {
  if (!channel) return null
  const base = typeof channel.isThread === 'function' && channel.isThread() ? channel.parent : channel
  if (!base) return null
  const list = Array.isArray(projects) ? projects : []
  const parentId = base.parentId ?? null
  const ownId = base.id ?? null
  const matches = list.filter((p) => {
    if (!p) return false
    const ids = [p.discordCategoryId, ...Object.values(bucketIdsOf(p))].filter(Boolean)
    return ids.some((id) => id === parentId || id === ownId)
  })
  const distinct = new Set(matches.map((p) => p.id ?? p))
  return distinct.size === 1 ? matches[0] : null
}

/**
 * Decide which role gates this project's section, and refuse rather than guess.
 *
 * Adopting a role that already exists is the one decision in this feature that
 * can change somebody's permissions without anyone asking for it, in BOTH
 * directions: the role's holders gain sight of a section they were never put
 * on, and the very next role sync takes the role off every holder who is not a
 * `projectmember` row. A guild role `Marketing` held by two people, plus a new
 * project called `Marketing`, is enough. So adoption is fail-closed: it happens
 * only when it demonstrably cannot do either of those things, and otherwise the
 * name is REFUSED — the section is still built, but its category keeps the
 * `@everyone` deny with no allow, so only the bot can see it until an operator
 * says what to do.
 *
 * The order matters. Rules 1 and 2 are about THIS project's own role and never
 * touch anyone else's; everything after is about a stranger that happens to
 * share the name.
 *
 * `adoptRole` (from `/project-setup adopt_role:true`) overrides exactly one
 * refusal — "someone holds it" — because that is the one an operator can
 * knowingly accept. A managed role, `@everyone`, a role carrying real power, or
 * a role that opens other channels is refused whatever the operator passes:
 * those are not decisions about this project.
 *
 * @param {{name?: string}} project
 * @param {object} observed the snapshot, including `roleCandidate` and `rolesFetched`
 * @param {string[]} warnings collected in place
 * @param {{adoptRole?: boolean}} [opts]
 */
function planRole(project, observed, warnings, { adoptRole = false } = {}) {
  const name = String(project?.name ?? '').trim()
  // `gateRoleId` is the single answer to "which role will this section be gated
  // on" that the channel planner and the applier BOTH read. Before it existed,
  // `lacksRoleAllow` said "no role" for a refusal while the applier happily put
  // a kept role's allow on the moved channels, so the two disagreed about the
  // same run.
  const kept = observed?.roleId ?? null

  if (MANAGED_FOLDED.has(fold(name))) {
    const reason = `"${name}" is a managed role — one of the job roles the bot assigns — so it cannot also be a project role.`
    warnings.push(
      kept
        ? `Project "${name}" shares its name with a managed role, so no new project role was planned — the section stays gated on the role the project already has. Rename the project to give it a role of its own.`
        : `Project "${name}" shares its name with a managed role, so no project role was planned and its section is HIDDEN: the category denies @everyone and there is no role to let anyone in. A managed name can never be adopted, so rename the project in /projects and run /project-setup again — that creates a proper role and repairs the section.`
    )
    // `managed-name` and `role` are refused for different reasons, but the
    // category now treats them the same way: private either way. A managed
    // name can never have a role of its own, so the section stays hidden
    // until the project is renamed — which is recoverable, while a public
    // category would silently show the project's channels to the whole
    // server. `kind` is kept because the reasons still differ in the reply.
    return { action: 'refuse', kind: 'managed-name', name, reason, gateRoleId: kept }
  }

  // 1. This project's own stored role, always, exactly as before.
  if (kept) return { action: 'reuse', decision: 'stored', id: kept, name, gateRoleId: kept }

  const candidate = observed?.roleCandidate ?? null
  // 2. Nothing of this name exists: make one. Nobody else is affected.
  if (!candidate) return { action: 'create', decision: 'create', name, gateRoleId: null }

  const holderIds = Array.isArray(candidate.holderIds) ? candidate.holderIds : []
  const refuse = (reason, advice, hard = true) => {
    const ignored = hard && adoptRole ? ' **adopt_role** does not override this.' : ''
    warnings.push(`${reason} ${advice}${ignored}`)
    return {
      action: 'refuse',
      kind: 'role',
      name,
      reason,
      gateRoleId: null,
      candidateId: candidate.id,
      holderIds,
    }
  }
  const stillPrivate = `The section was still built, but its category is visible to nobody but the bot until this is resolved.`

  if (candidate.isEveryone) {
    return refuse(
      `Role "${name}" is this server's @everyone role, so it cannot gate a project — gating on it would show the section to the whole server.`,
      `Rename the project. ${stillPrivate}`
    )
  }
  if (candidate.managed) {
    return refuse(
      `Role "${name}" is managed by Discord or an integration (a bot or booster role), so it cannot be handed out as a project role.`,
      `Rename the project, or rename that role. ${stillPrivate}`
    )
  }
  if (candidate.overPermissioned) {
    return refuse(
      `Role "${name}" carries server permissions beyond @everyone's, so it was not adopted — a project gate must never also be a power role, or every project member would inherit that power.`,
      `Rename the project, or rename that role. ${stillPrivate}`
    )
  }
  const elsewhere = Array.isArray(candidate.elsewhere) ? candidate.elsewhere : []
  if (elsewhere.length) {
    const shown = elsewhere.slice(0, 3).join(', ')
    const more = elsewhere.length > 3 ? `, and ${elsewhere.length - 3} more` : ''
    return refuse(
      `Role "${name}" already carries permission overwrites on ${elsewhere.length} channel(s) outside this project (${shown}${more}) — allows and denies alike — so it was not adopted: handing it to every project member would change what those people see on channels that have nothing to do with this project.`,
      `Rename the project, or rename that role. ${stillPrivate}`
    )
  }
  // 3. The holder count comes from the member cache, so an unfetched cache
  //    reads as "nobody holds it" — the exact shape of the leak this whole
  //    function exists to stop. Never adopt on a count we did not earn.
  if (!observed?.rolesFetched) {
    return refuse(
      `Role "${name}" already exists, but this server's member list could not be read, so there is no way to tell who holds it and it was not adopted.`,
      `Run /project-setup again once the bot can read this server's members. ${stillPrivate}`
    )
  }
  // 4. Held by nobody: adopting it can neither strip a role nor show anything
  //    to anyone. This is the legacy `/create-project-role` role nobody ever
  //    got round to assigning.
  if (holderIds.length === 0) {
    return { action: 'reuse', decision: 'empty', id: candidate.id, name, gateRoleId: candidate.id, holderIds }
  }
  // 5. Held, and otherwise harmless: the operator's call, and only theirs.
  if (adoptRole) {
    return { action: 'reuse', decision: 'adopt', id: candidate.id, name, gateRoleId: candidate.id, holderIds }
  }
  return refuse(
    `Role "${name}" already exists and is held by ${holderIds.length} member(s), so it was NOT adopted — adopting it would show this project's section to all of them, and the role sync would then take the role away from every holder who is not a project member.`,
    `Rename the project or the role, or run /project-setup with **adopt_role:true** — add **preview:true** first to see exactly who would gain and lose it. ${stillPrivate}`,
    false
  )
}

function planCategory(project, observed) {
  const name = categoryNameFor(project)
  const id = observed?.categoryId ?? null
  if (!id) return { action: 'create', name }
  // Found by id, never by name, so a category renamed by hand is still ours.
  if (observed.categoryName === name) return { action: 'reuse', id, name }
  return { action: 'rename', id, name }
}

/** One entry per bucket, `planCategory`'s rules applied to each. */
function planBuckets(project, observed) {
  const seen = observed?.buckets ?? {}
  return BUCKETS.map((b) => {
    const name = bucketNameFor(project, b)
    const found = seen[b.key]
    if (!found?.id) return { key: b.key, storeKey: b.storeKey, action: 'create', name }
    if (found.name === name) return { key: b.key, storeKey: b.storeKey, action: 'reuse', id: found.id, name }
    return { key: b.key, storeKey: b.storeKey, action: 'rename', id: found.id, name }
  })
}

/**
 * The ten section channels.
 *
 * A section channel is created with no overwrites of its own, so Discord COPIES
 * the category's set onto it — at creation time, once. Discord does not cascade
 * a later overwrite edit on the category down to children that already exist
 * (that is what the client's "Sync Now" button is for), so a channel created
 * under a deny-only category keeps a deny-only copy forever. The role rules
 * above make that the ordinary path: a project whose same-named role is refused
 * gets a private category and ten channels copied from it, and adopting the
 * role later would fix the category and the task channels and leave these ten
 * invisible to everyone but the bot, with no run that ever repairs them and
 * nothing in this feature allowed to delete a channel.
 *
 * So they get the same treatment task channels already have: a channel that is
 * being renamed or moved anyway carries the role's allow in that SAME single
 * edit (`opens`), and one that is otherwise correct gets a standalone `grant`.
 */
function planChannels(project, observed, role) {
  const parentId = observed?.categoryId ?? null
  const seen = observed?.channels ?? {}
  return SECTIONS.map(({ key, suffix, type }) => {
    const name = channelNameFor(project, suffix)
    const channel = seen[key]
    if (!channel?.id) return { key, action: 'create', name, type }
    const nameOk = channel.name === name
    // With no category yet there is nothing to sit under, so the channel moves.
    const parentOk = Boolean(parentId) && channel.parentId === parentId
    const needsAllow = lacksRoleAllow(channel.overwriteIds, role)
    if (nameOk && parentOk) {
      // Already named and placed; the only thing left that can be wrong is who
      // can see it. `grant` is one edit carrying nothing but the overwrites.
      return { key, action: needsAllow ? 'grant' : 'reuse', id: channel.id, name, type }
    }
    const entry = { key, action: parentOk ? 'rename' : 'move', id: channel.id, name, type }
    // Not a second edit: the applier folds the allow into the rename/move.
    if (needsAllow) entry.opens = true
    return entry
  })
}

/**
 * Per-client access on the two support channels: a member overwrite per
 * client row. `revokeClients:false` is the twin of the role sync's grant-only
 * mode — a roster that could not be read in full must not take access away.
 */
function planClientAccess(observed, { revokeClients = true } = {}) {
  // Not an array: the roster was never read (see `observeProjectSection`'s
  // `clientIds` doc). Plan nothing rather than guess.
  if (!Array.isArray(observed?.clientIds)) return { wanted: [], grant: [], revoke: [] }
  const wanted = observed.clientIds
  const grant = []
  const revoke = []
  for (const key of CLIENT_SECTION_KEYS) {
    const channelId = observed?.channels?.[key]?.id
    const access = observed?.clientAccess?.[key]
    if (!channelId || !access) continue
    for (const memberId of access.missing ?? []) grant.push({ key, channelId, memberId })
    if (revokeClients) for (const memberId of access.stale ?? []) revoke.push({ key, channelId, memberId })
  }
  return { wanted, grant, revoke }
}

/**
 * True when a channel inside the section is known to lack the project role's
 * overwrite. A role about to be created is on no channel yet; an unreadable
 * overwrite list is never guessed at; and a section with no gate role — a
 * refused name that kept nothing — has no allow to be missing.
 *
 * Reads `role.gateRoleId`, the one answer the applier also uses, so a refused
 * name that KEPT the project's old role repairs channels against that role
 * instead of quietly doing half of it.
 *
 * @param {string[]|null|undefined} overwriteIds the channel's overwrite ids, or null when unreadable
 * @param {{action?: string, gateRoleId?: string|null}|null} role the role plan
 */
function lacksRoleAllow(overwriteIds, role) {
  if (!Array.isArray(overwriteIds)) return false
  if (!role) return false
  if (role.action === 'create') return true
  const gate = role.gateRoleId ?? null
  return Boolean(gate) && !overwriteIds.includes(gate)
}

function planTasks(project, observed, channels, role, warnings) {
  const sectionId = observed?.categoryId ?? null
  const seen = observed?.buckets ?? {}
  const bucketIdOf = (key) => seen[key]?.id ?? null
  const projectCategoryIds = new Set([sectionId, ...BUCKETS.map((b) => bucketIdOf(b.key))].filter(Boolean))
  // Room per bucket. A bucket being created this run starts empty. Section
  // channels never sit in a bucket, so they no longer compete with tickets.
  const room = {}
  for (const b of BUCKETS) room[b.key] = Math.max(0, CATEGORY_SOFT_CAP - Number(seen[b.key]?.channelCount ?? 0))
  const leftBehind = {}

  const tasks = Array.isArray(observed?.tasks) ? observed.tasks : []
  const taken = new Set(observed?.takenNames ?? [])
  // The thirteen section names are spoken for, so a project slugged `feature`
  // with a task titled "Members" cannot land on `feature-members` in the same run.
  for (const channel of channels) taken.add(channel.name)
  // Names this run has handed out. Separate from `taken` because a task may
  // free the name it already carries, but never one promised to another task.
  const assigned = new Set()
  const planned = []

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

    const bucket = bucketFor(task.status)
    const wantedParent = bucketIdOf(bucket)
    const nameOk = task.channelName === name
    // A bucket being created has no id yet, so nothing can already be in it.
    const parentOk = Boolean(wantedParent) && task.parentId === wantedParent
    let action = nameOk ? (parentOk ? 'none' : 'move') : parentOk ? 'rename' : 'both'

    // Already named and placed, but the project role cannot see it: a channel
    // opened while the project's role id was stale or missing, or before a
    // replaced role existed. A move or rename carries the allow in its own
    // edit; this one needs an edit of its own, or its project's members never
    // see it. Only on what the snapshot can read, and never for a refused role.
    const needsAllow = lacksRoleAllow(task.overwriteIds, role)
    if (action === 'none' && needsAllow) action = 'grant'

    if (action === 'move' || action === 'both') {
      if (room[bucket] > 0) room[bucket] -= 1
      else {
        // No room: leave it where it is, but still give it a readable name.
        action = action === 'both' ? 'rename' : 'none'
        leftBehind[bucket] = (leftBehind[bucket] ?? 0) + 1
      }
    }
    // The topic rides along with the rename. A channel renamed from
    // `feature-0145e3` to `feature-add-booking-rules` keeping its old topic
    // would match neither the old name nor the new `Task <id>` marker, and
    // /update-task would open a duplicate beside it on every update.
    // A rename/move edit ALSO carries the role's allow when the channel ends up
    // inside the project's space — the applier folds it into the same single
    // edit. The preview has to say so: "22 to rename and move" reads as a
    // tidy-up, while what it means is that 22 channels visible only to their
    // assignees become visible to everyone holding the project role.
    //
    // Inside the project's space after this plan: moved into a bucket, or
    // staying in a bucket or the section category it is already in. A ticket
    // its bucket had no room for is dropped to `none`, and the applier skips a
    // `none` outright — claiming it was opened would be a preview line that
    // never happened — while the `grant` word already says it on its own.
    const edited = action !== 'none' && action !== 'grant'
    const landsInside = action === 'move' || action === 'both' || projectCategoryIds.has(task.parentId)
    const entry = {
      taskId: task.id,
      channelId: task.channelId,
      action,
      name,
      topic: taskChannelTopic({ type: task.type, title: task.title, taskId: task.id }),
      bucket,
    }
    if (needsAllow && landsInside && edited) entry.opens = true
    // Filed into Done for the first time: read-only now, gone in fourteen days.
    // Never re-stamped — the fortnight would restart on every run.
    if (isDoneBucket(bucket) && !task.retireAt) entry.retire = true
    planned.push(entry)
  }

  const shared = Number(observed?.sharedTaskChannels ?? 0)
  if (shared > 0) {
    warnings.push(
      `${shared} channel${shared === 1 ? '' : 's'} that tasks in "${project?.name}" point at ${shared === 1 ? 'is' : 'are'} not ${shared === 1 ? 'a task channel' : 'task channels'} — shared with other tasks, or not named like a ticket (a meeting review channel, most likely) — so ${shared === 1 ? 'it was' : 'they were'} left alone rather than renamed into this section.`
    )
  }

  for (const [key, n] of Object.entries(leftBehind)) {
    const label = bucketByKey(key)?.label ?? key
    warnings.push(
      `Project "${project?.name}"'s ${label} bucket is at Discord's category cap (${CATEGORY_SOFT_CAP} channels), so ${n} task channel${n === 1 ? '' : 's'} stayed where ${n === 1 ? 'it is' : 'they are'}.`
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
 *   roleCandidate?: {id: string, name: string, managed: boolean, isEveryone: boolean, overPermissioned: boolean, holderIds: string[], elsewhere: string[]}|null,
 *   rolesFetched?: boolean,
 *   categoryId?: string|null,
 *   categoryName?: string|null,
 *   categoryChannelCount?: number,
 *   buckets?: {open: {id: string, name: string, channelCount: number}|null, inProgress: object|null, done: object|null},
 *   channels?: Object<string, {id: string, name: string, parentId: string|null, overwriteIds?: string[]|null}>,
 *   tasks?: Array<{id: string, title: string, type: string, status?: string|null, retireAt?: Date|null, channelId: string, channelName: string, parentId: string|null, overwriteIds?: string[]|null}>,
 *   sharedTaskChannels?: number,
 *   takenNames?: Set<string>,
 * }} observed a plain snapshot the caller gathers — no Discord objects
 * @param {{adoptRole?: boolean}} [opts] `adopt_role:true`, and only ever from
 *   `/project-setup`: `/projects` → Add project and the two wrapper commands
 *   must never be able to revoke a role or open a section by creating a project.
 */
export function planProjectSection(project, observed = {}, opts = {}) {
  const warnings = []
  const role = planRole(project, observed, warnings, opts)
  const category = planCategory(project, observed)
  const buckets = planBuckets(project, observed)
  // After the role: every channel decision depends on which role gates the
  // section, and on a refusal there may be none.
  const channels = planChannels(project, observed, role)
  const tasks = planTasks(project, observed, channels, role, warnings)
  // Passed through as observed: what the applier will edit is exactly what a
  // preview lists.
  const voice = observed.voiceActivity ?? { category: [], channels: [] }
  const clients = planClientAccess(observed, opts)
  return { role, category, buckets, channels, tasks, voice, clients, warnings }
}

// ---------------------------------------------------------------------------
// The applier. Everything below here talks to Discord.
// ---------------------------------------------------------------------------

/**
 * What the project role may do inside its own category. The section channels
 * are created with no overwrites of their own, so they inherit these.
 */
// UseVAD is "Use Voice Activity" and Stream is "Video" (screen share and camera).
// Connect and Speak give neither: without UseVAD a member of the project role is
// push-to-talk only, and without Stream cannot share a screen, whenever the
// server's @everyone role does not grant them.
const ROLE_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.UseVAD,
  PermissionFlagsBits.Stream,
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
 * Every id a project other than this one has recorded as part of ITS section:
 * its category and its ten section channels. The observer refuses to adopt any
 * of them by NAME.
 *
 * Under a case-sensitive collation `Framework` and `framework` both want
 * `📂 FRAMEWORK`, and two projects whose effective slugs collide want the same
 * ten channel names, so without this the second project adopts the first's
 * category and channels and merges its own role's allow into them — an
 * unrequested permission change — and the two then drag the same channels back
 * and forth, two edits each, every run.
 *
 * The caller must read these rows FRESH, at observation time. During
 * `all:true`, project A stores its brand-new category id partway through the
 * walk, and the list `pickProjects` loaded before the walk started would not
 * have it, so project B would still adopt it by name.
 *
 * @param {Array<object>} projects every project row in the guild, read just now
 * @param {string|null|undefined} exceptId the project being set up
 * @returns {Set<string>}
 */
export function claimedSectionIds(projects, exceptId) {
  const claimed = new Set()
  for (const p of projects ?? []) {
    if (!p || (exceptId && p.id === exceptId)) continue
    if (p.discordCategoryId) claimed.add(p.discordCategoryId)
    for (const id of Object.values(storedChannels(p))) if (id) claimed.add(id)
  }
  return claimed
}

/**
 * A permission bitfield as a BigInt, from whatever shape it arrives in: a
 * discord.js `PermissionsBitField`, a BigInt, a number, a decimal string.
 * Null when it cannot be read — never 0n, because "no permissions" and "could
 * not tell" must not be the same answer to a question about adopting a role.
 */
function bitsOf(permissions) {
  if (permissions === null || permissions === undefined) return null
  try {
    if (typeof permissions === 'bigint') return permissions
    if (typeof permissions === 'number') return BigInt(permissions)
    if (typeof permissions === 'string') return BigInt(permissions)
    const raw = permissions.bitfield ?? permissions.valueOf?.()
    if (raw === null || raw === undefined || typeof raw === 'object') return null
    return BigInt(raw)
  } catch {
    return null
  }
}

/** The two voice permissions Connect and Speak do not include, by discord.js name. */
const VOICE_EXTRAS = ['UseVAD', 'Stream']
const VOICE_EXTRA_WORDS = { UseVAD: 'voice activity', Stream: 'screen sharing' }

/**
 * Which of "Use Voice Activity" and "Video" (screen share) the project role's
 * overwrite here neither allows nor denies — the gaps a repair may fill. An
 * explicit DENY of a permission is a human's decision (a push-to-talk room, no
 * screen sharing) and is left alone; a missing overwrite or an unreadable one
 * is not ours to create or judge. Empty when there is nothing to fill.
 */
function voiceGaps(overwrite) {
  if (!overwrite) return []
  const allow = bitsOf(overwrite.allow)
  const deny = bitsOf(overwrite.deny)
  if (allow === null) return []
  return VOICE_EXTRAS.filter((name) => {
    const bit = PermissionFlagsBits[name]
    if ((allow & bit) !== 0n) return false
    return !(deny !== null && (deny & bit) !== 0n)
  })
}

/** True when the overwrite hands out ViewChannel. Unreadable reads as "no". */
function grantsView(overwrite) {
  const bits = bitsOf(overwrite?.allow)
  if (bits === null) return false
  return (bits & PermissionFlagsBits.ViewChannel) !== 0n
}

/**
 * True when the role carries any guild permission `@everyone` does not.
 *
 * Discord creates a new role with exactly the `@everyone` set, so the legacy
 * `/create-project-role` roles this branch has to adopt still pass, while
 * anything carrying extra power is refused. A subset test rather than a
 * deny-list on purpose: the deny-list this replaces was missing MoveMembers,
 * MuteMembers, DeafenMembers, ManageWebhooks, ManageNicknames, ManageThreads,
 * ManageEvents and ViewAuditLog, and the next one would miss whatever Discord
 * adds next.
 *
 * Either bitfield unreadable means "cannot prove it is harmless", which is a
 * refusal, not a pass.
 */
function overPermissioned(role, everyone) {
  const roleBits = bitsOf(role?.permissions)
  const everyoneBits = bitsOf(everyone?.permissions)
  if (roleBits === null || everyoneBits === null) return true
  return (roleBits & ~everyoneBits) !== 0n
}

/**
 * The plain snapshot of a same-named role the planner needs to decide whether
 * adopting it can hurt anyone. No Discord objects cross this line.
 *
 * `elsewhere` is the names of channels OUTSIDE the project's own category that
 * carry an overwrite for this role — ANY overwrite, allow or deny. A role with
 * no holders can still open doors: a dormant `Design` role left on
 * `#design-private`. Adopt it, grant it to every project member, and they all
 * get `#design-private` too.
 *
 * A deny-only overwrite cannot open anything, so this over-refuses on purpose:
 * handing the role to every project member would still change what those
 * people see on channels that have nothing to do with the project, in the
 * other direction. The refusal is right; only the wording has to be honest
 * about it, so the reason says the role carries overwrites on channels outside
 * the project rather than claiming those channels would be handed out.
 */
function describeRoleCandidate(guild, role, categoryId, channels) {
  const elsewhere = []
  for (const channel of channels) {
    if (!channel) continue
    if (categoryId && (channel.id === categoryId || channel.parentId === categoryId)) continue
    // A channel whose overwrites we cannot read cannot be asserted about. Real
    // guild channels always carry the cache; this only guards odd fakes.
    if (channel.permissionOverwrites?.cache?.has?.(role.id)) elsewhere.push(channel.name)
  }
  return {
    id: role.id,
    name: role.name,
    managed: Boolean(role.managed),
    isEveryone: role.id === guild?.id,
    overPermissioned: overPermissioned(role, guild?.roles?.everyone),
    // From the member cache, which is only populated by a `guild.members.fetch()`
    // — hence `rolesFetched` beside it in the snapshot. An unfetched cache makes
    // every role look empty, and an empty role is one the planner adopts.
    holderIds: [...(role.members?.keys?.() ?? [])],
    elsewhere,
  }
}

/**
 * The category's overwrites.
 *
 * With a role: the two from spec §5 — @everyone denied, the role allowed.
 * With NO role, for any reason at all: the deny alone. The section is private
 * or it is nothing.
 *
 * The managed-NAME refusal used to be the one exception — it returned no
 * overwrites, so a project called `Database` got a fully PUBLIC category on
 * the reasoning that a role of that name will never exist for it and a deny
 * with nothing to allow hides the section from everyone with no way back.
 * That trade is gone. A hidden section IS recoverable: rename the project and
 * re-run `/project-setup`, and a proper role is created and the section
 * repaired. A public one silently shows a project's ten channels, and every
 * task channel moved into them, to the whole server — which is the one thing
 * this feature must never do. A refused same-named ROLE has always failed
 * closed; both refusals now behave the same way, and the planner's warning
 * says the section is hidden until the project is renamed.
 */
function categoryOverwrites(guild, roleId) {
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

/** The ids of a channel's overwrites, or null when the cache is unreadable. */
function overwriteIdsOf(channel) {
  const cache = channel?.permissionOverwrites?.cache
  if (!cache?.keys || !cache?.has) return null
  return [...cache.keys()]
}

/**
 * The overwrite set to send so a task channel inside the section lets the
 * project role in: the channel's own overwrites, untouched, plus the role's
 * allow — `mergedOverwrites`, the same merge the category repair uses. Null
 * when there is nothing to add or nothing safe to send: no role that resolves,
 * an overwrite list that cannot be read (sending the allow alone would REPLACE
 * the set and drop every assignee), or a channel that already carries an
 * overwrite for the role (someone set it; it is not ours to overrule).
 */
function roleAllowMerged(channel, roleId) {
  if (!roleId) return null
  const cache = channel?.permissionOverwrites?.cache
  if (!cache?.has || !cache?.values) return null
  const required = [{ id: roleId, type: OverwriteType.Role, allow: ROLE_ALLOW }]
  if (!missingOverwrites(channel, required)) return null
  return mergedOverwrites(channel, required)
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
 * @param {{rolesFetched?: boolean, claimedIds?: Set<string>|null, clientIds?: string[]|null}} [opts]
 *   `rolesFetched` says `guild.members.fetch()` demonstrably succeeded, so the
 *   holder counts on `roleCandidate` are real. It defaults to FALSE: a caller
 *   that forgets it gets the fail-closed answer, never a silent adoption based
 *   on an empty cache. `claimedIds` comes from `claimedSectionIds`. `clientIds`
 *   is the same shape of promise: it defaults to `null`, meaning "the client
 *   roster was not read", and a caller that forgets it gets `clientAccess: {}`
 *   — nothing planned — never every member overwrite on the support pair read
 *   as belonging to nobody and revoked. An actual empty roster is `[]`, a real
 *   answer that plans no grants and every stale overwrite revoked.
 */
export function observeProjectSection(guild, project, tasks = [], opts = {}) {
  const { rolesFetched = false, claimedIds = null, clientIds = null } = opts
  const claimed = claimedIds instanceof Set ? claimedIds : new Set()
  const all = valuesOf(guild?.channels?.cache)
  const byId = new Map(all.map((c) => [c.id, c]))

  let roleId = null
  let sameNamed = null
  const wantedRole = String(project?.name ?? '').trim()
  for (const role of valuesOf(guild?.roles?.cache)) {
    if (project?.discordRoleId && role.id === project.discordRoleId) roleId = role.id
    // First match wins, as the old name map did.
    if (!sameNamed && role.name === wantedRole) sameNamed = role
  }

  let category = project?.discordCategoryId ? byId.get(project.discordCategoryId) ?? null : null
  if (!category) {
    const wanted = categoryNameFor(project)
    category =
      all.find((c) => c.type === ChannelType.GuildCategory && c.name === wanted && !claimed.has(c.id)) ?? null
  }
  const categoryId = category?.id ?? null

  // The three status buckets: by stored id (a category renamed by hand is
  // still ours), else by exact name among categories no other project claims
  // — the same two rules the section category follows.
  const bucketIds = bucketIdsOf(project)
  const buckets = {}
  for (const b of BUCKETS) {
    let cat = bucketIds[b.key] ? byId.get(bucketIds[b.key]) ?? null : null
    if (cat && cat.type !== ChannelType.GuildCategory) cat = null
    if (!cat) {
      const wanted = bucketNameFor(project, b)
      cat = all.find((c) => c.type === ChannelType.GuildCategory && c.name === wanted && !claimed.has(c.id)) ?? null
    }
    buckets[b.key] = cat ? { id: cat.id, name: cat.name, channelCount: all.filter((c) => c.parentId === cat.id).length } : null
  }

  // After the category, because a candidate's "does it open channels elsewhere"
  // test has to know where this project's own category is.
  const roleCandidate = sameNamed ? describeRoleCandidate(guild, sameNamed, categoryId, all) : null

  const stored = storedChannels(project)
  const channels = {}
  for (const { key, suffix } of SECTIONS) {
    const wanted = channelNameFor(project, suffix)
    let channel = stored[key] ? byId.get(stored[key]) ?? null : null
    if (!channel) {
      channel =
        all.find(
          (c) =>
            c.name === wanted &&
            c.type !== ChannelType.GuildCategory &&
            !claimed.has(c.id) &&
            // A channel with ANY topic is not one of ours. The bot sets no
            // topic on a section channel, so a topic means a human wrote it
            // or the bot signed the channel as a ticket.
            //
            // It used to read `!(c.topic && isTicketChannel(c))`, which let
            // through every channel whose topic was not a ticket signature —
            // and adopting by name now merges the project role's allow into
            // the channel, so a hand-made PRIVATE channel that happened to be
            // called `framework-meetings` became visible to every holder of
            // the project role. An unrequested permission change is the one
            // thing this feature must never do, and a stored id always beats
            // this fallback, so refusing anything with a topic costs nothing.
            !c.topic
        ) ?? null
    }
    if (channel) {
      channels[key] = {
        id: channel.id,
        name: channel.name,
        parentId: channel.parentId ?? null,
        // Discord copies the category's overwrites onto a section channel when
        // it is CREATED and never again, so a channel that predates the role
        // carries a copy without it. Null when unreadable: the planner only
        // plans a permissions edit on what it can see.
        overwriteIds: overwriteIdsOf(channel),
      }
    }
  }

  // Per support channel: which clients lack their member overwrite, and which
  // member overwrites belong to nobody who is still a client row. Null-safe:
  // an unreadable overwrite cache plans nothing, as everywhere else here.
  // `clientIds` not an array means the roster was never read — fail closed
  // with no `clientAccess` entries at all, the same shape of promise as
  // `rolesFetched` above: a caller that forgets the option gets nothing
  // planned, never every member overwrite on the support pair mistaken for
  // an ex-client and revoked.
  const wantedClients = Array.isArray(clientIds) ? [...new Set(clientIds.map(String).filter(Boolean))] : null
  const clientAccess = {}
  if (wantedClients) {
    for (const key of CLIENT_SECTION_KEYS) {
      const seen = channels[key]
      if (!seen?.id || !Array.isArray(seen.overwriteIds)) continue
      const raw = byId.get(seen.id)
      const memberIds = valuesOf(raw?.permissionOverwrites?.cache)
        .filter((o) => o?.type === OverwriteType.Member)
        .map((o) => String(o.id))
      // A member overwrite the bot did not create is revoked too, by design,
      // exactly as the role sync strips a role holder with no `projectmember`
      // row — see `syncProjectRoleMembers`. This only ever runs once the
      // caller actually read the roster (guarded above), never on a default.
      clientAccess[key] = {
        missing: wantedClients.filter((id) => !seen.overwriteIds.includes(id)),
        stale: memberIds.filter((id) => !wantedClients.includes(id)),
      }
    }
  }

  // A channel more than one task row points at is NOT a task channel, and
  // neither is one that is not shaped like a ticket. Every
  // unassigned meeting task carries the meeting's SHARED review channel in
  // `discordChannelId` — renaming that to `feature-<title>` and moving it into
  // one project's category would take the whole meeting's review away from
  // everything else that uses it. `mirroredStage` only ever treats a channel it
  // created for one task as that task's own; this is the same rule, read off
  // the rows instead of the pipeline job.
  const referenceCounts = new Map()
  for (const task of tasks || []) {
    const channelId = task?.discordChannelId ?? task?.channelId ?? null
    if (!channelId) continue
    referenceCounts.set(channelId, (referenceCounts.get(channelId) ?? 0) + 1)
  }

  const sharedChannelIds = new Set()
  const observedTasks = []
  for (const task of tasks || []) {
    const channelId = task?.discordChannelId ?? task?.channelId ?? null
    if (!channelId) continue
    const channel = byId.get(channelId)
    if (!channel) continue
    // Two ways a row can name a channel that is not its own ticket: several
    // rows name it (the review channel of a meeting with many unassigned
    // tasks), or it is not shaped like a ticket at all (the review channel of a
    // meeting that produced exactly ONE unassigned task — a count of one, so
    // the first test alone would rename and move it). `isTicketChannel` is the
    // same test `ownsChannel` uses before trusting a row's channel id.
    if ((referenceCounts.get(channelId) ?? 0) > 1 || !isTicketChannel(channel)) {
      sharedChannelIds.add(channelId)
      continue
    }
    observedTasks.push({
      id: task.id,
      title: task.title,
      type: task.type ?? (task.is_bug ? 'bug' : 'feature'),
      channelId: channel.id,
      channelName: channel.name,
      parentId: channel.parentId ?? null,
      // Which bucket the ticket belongs in, and whether its fortnight has
      // already been stamped — the planner never re-stamps one.
      status: task.status ?? null,
      retireAt: task.channelRetireAt ?? null,
      // The ids of the overwrites the channel carries, or null when they cannot
      // be read — the planner only plans a permissions edit on what it can see.
      overwriteIds: overwriteIdsOf(channel),
    })
  }

  // Voice channels inside the project's category that were created without
  // "Use Voice Activity" / "Video" for the project role (Discord copies a category's
  // overwrites once, at creation, so fixing the category never reaches them).
  const voiceActivity = { category: [], channels: [] }
  if (roleId && categoryId) {
    const roleOverwrite = (channel) => channel?.permissionOverwrites?.cache?.get?.(roleId)
    voiceActivity.category = voiceGaps(roleOverwrite(category))
    for (const channel of all) {
      if (channel.parentId !== categoryId || channel.type !== ChannelType.GuildVoice) continue
      const gaps = voiceGaps(roleOverwrite(channel))
      if (gaps.length) voiceActivity.channels.push({ id: channel.id, name: channel.name, gaps })
    }
  }

  return {
    roleId,
    roleCandidate,
    rolesFetched: Boolean(rolesFetched),
    categoryId,
    categoryName: category?.name ?? null,
    categoryChannelCount: categoryId ? all.filter((c) => c.parentId === categoryId).length : 0,
    buckets,
    channels,
    tasks: observedTasks,
    voiceActivity,
    // Counted, not silently dropped: the operator's reply says how many
    // channels the rows point at were left alone and why.
    sharedTaskChannels: sharedChannelIds.size,
    takenNames: new Set(all.map((c) => c.name)),
    clientAccess,
    clientIds: wantedClients,
  }
}

const clientAllowFor = (key) => (key === 'supportVoice' ? CLIENT_VOICE_ALLOW_OBJ : CLIENT_TEXT_ALLOW_OBJ)

/** One typed edit per client; a failure is one warning, not a stopped run. */
async function grantClients(channel, key, memberIds, result) {
  for (const memberId of memberIds) {
    try {
      await channel.permissionOverwrites.edit(memberId, clientAllowFor(key), { type: OverwriteType.Member, reason: REASON })
      result.clientGranted.push(channel.name)
    } catch (e) {
      note(result.warnings, `client access on ${channel.name} for ${memberId}`, e)
    }
  }
}

/**
 * Perform a plan: role, then category, then the buckets, then the section
 * channels, then the task channels, then the retirements, then one write of
 * the ids, then the members panel. Every step has its own try/catch, so a
 * project missing one permission still gets everything else, and a repeat run
 * finishes what was left.
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
 * `granted` is the channels that got a standalone permissions edit; `opened` is
 * the ones whose rename or move carried the role's allow in the same edit. Both
 * are permission changes and both are reported, but they are not the same
 * count, and adding them together would describe one channel as two objects.
 *
 * `retire` and `now` are seams for the same reason every other database touch
 * here is one: `retireTicketChannel`'s own default `db` is the production
 * client, so step 4c runs only when the caller handed the applier a database.
 *
 * @param {{db: object, members?: Array<{discordId: string, role: string}>, nameFor?: (id: string) => string, botUserId?: string|null, retire?: typeof retireTicketChannel, now?: () => Date}} deps
 * @returns {Promise<{role: object|null, category: object|null, created: string[], renamed: string[], moved: string[], granted: string[], opened: string[], buckets: {created: string[], renamed: string[]}, retired: number, membersChannel: object|null, tasks: number, warnings: string[]}>}
 */
export async function applyProjectSection(
  guild,
  project,
  plan,
  { db, members, nameFor = (id) => id, botUserId = null, retire = retireTicketChannel, now = () => new Date() } = {}
) {
  const result = {
    role: null,
    category: null,
    created: [],
    renamed: [],
    moved: [],
    granted: [],
    opened: [],
    buckets: { created: [], renamed: [] },
    retired: 0,
    voiceFixed: [],
    clientGranted: [],
    clientRevoked: [],
    membersChannel: null,
    tasks: 0,
    warnings: [],
  }
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
  // The role the section is actually gated on, for every channel below. The
  // planner used `role.gateRoleId` to decide the same thing; resolving it here
  // guards the window between the read and the write, where the role can be
  // deleted. A newly created role is in the cache by now.
  const projectRoleId = roleId && guild.roles?.cache?.has?.(roleId) ? roleId : null

  // 2. The category.
  const categoryPlan = plan?.category ?? null
  try {
    if (categoryPlan?.action === 'create') {
      result.category = await guild.channels.create({
        name: categoryPlan.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: categoryOverwrites(guild, roleId),
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
      const required = categoryOverwrites(guild, roleId)
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
    // 2b. The three status buckets: sibling categories directly below the
    //     section category, same overwrites as it. Created, renamed or reused
    //     exactly as the category is; each on its own try/catch.
    const bucketIdByKey = {}
    for (const entry of plan?.buckets ?? []) {
      try {
        let cat = null
        if (entry.action === 'create') {
          cat = await guild.channels.create({
            name: entry.name,
            type: ChannelType.GuildCategory,
            permissionOverwrites: categoryOverwrites(guild, roleId),
            reason: REASON,
          })
          result.created.push(entry.name)
          result.buckets.created.push(entry.name)
        } else {
          cat = guild.channels.cache.get(entry.id) ?? null
          if (!cat) throw new Error(`bucket ${entry.id} no longer exists`)
          // Bind the bucket the moment it resolves, BEFORE the repair edit —
          // exactly as the section category sets `result.category = existing`
          // before its own repair. A refused rename or overwrite repair is
          // then one warning; the bucket still exists, so every ticket bound
          // for it still files into it instead of taking the `unplaced` path
          // and being reported as "could not be created".
          channelIds[entry.storeKey] = cat.id
          bucketIdByKey[entry.key] = cat.id
          const required = categoryOverwrites(guild, roleId)
          const needsName = entry.action === 'rename'
          const needsPerms = missingOverwrites(cat, required)
          if (needsName || needsPerms) {
            const payload = { name: entry.name }
            if (needsPerms) payload.permissionOverwrites = mergedOverwrites(cat, required)
            await cat.edit(payload)
            if (needsName) {
              result.renamed.push(entry.name)
              result.buckets.renamed.push(entry.name)
            }
          }
        }
        channelIds[entry.storeKey] = cat.id
        bucketIdByKey[entry.key] = cat.id
      } catch (e) {
        note(result.warnings, `bucket "${entry.name}"`, e)
      }
    }
    // Sidebar order: section, then open, in progress, done. Both sides speak
    // the same unit — discord.js's `position` getter, the SORTED INDEX among
    // the guild's categories, which is exactly what `edit({ position })`
    // takes (it goes through `setPosition` and re-numbers the rest). Reading
    // `rawPosition` (the raw, non-contiguous gateway value) and writing a
    // sorted index would compare and set two different things. Best-effort —
    // a refused position edit is one warning, not a stopped run.
    const base = Number(result.category?.position ?? 0)
    for (const [i, b] of BUCKETS.entries()) {
      const cat = bucketIdByKey[b.key] ? guild.channels.cache.get(bucketIdByKey[b.key]) : null
      if (!cat) continue
      const wanted = base + i + 1
      if (Number(cat.position ?? -1) === wanted) continue
      try {
        await cat.edit({ position: wanted })
      } catch (e) {
        note(result.warnings, `position of "${cat.name}"`, e)
      }
    }
    // "Inside the project's space" is the section category OR any of its
    // buckets — the planner uses the same set, and the applier's role-allow
    // decision has to agree with it or a `rename` of a ticket already sitting
    // in a bucket would quietly drop the allow the plan promised.
    const projectCategoryIds = new Set([categoryId, ...Object.values(bucketIdByKey)])

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
          if (CLIENT_SECTION_KEYS.includes(entry.key) && plan?.clients?.wanted?.length) {
            await grantClients(channel, entry.key, plan.clients.wanted, result)
          }
          continue
        }
        const channel = guild.channels.cache.get(entry.id)
        if (!channel) throw new Error(`channel ${entry.id} no longer exists`)
        channelIds[entry.key] = channel.id
        resolved.set(entry.key, channel)

        if (entry.action === 'grant') {
          // Named and placed already; the only thing wrong is that the role
          // cannot see it. Discord copies a category's overwrites onto a
          // section channel once, at creation, and never cascades a later
          // change, so this is the ONLY thing that ever repairs the ten
          // channels of a project whose role arrived after they did. Merged,
          // never `lockPermissions()`: a hand-added grant on one of these
          // channels is not ours to drop.
          const overwrites = roleAllowMerged(channel, projectRoleId)
          // Nothing to add after all (no role that resolves, an unreadable
          // overwrite list, or the allow landed since the snapshot): no edit,
          // and the channel is otherwise correct, so nothing else to do.
          if (!overwrites) continue
          await channel.edit({ permissionOverwrites: overwrites })
          result.granted.push(channel.name ?? entry.name)
          continue
        }

        // A rename or a move is one edit, and the allow rides in it.
        const payload = { name: entry.name, parent: categoryId }
        const overwrites = entry.opens ? roleAllowMerged(channel, projectRoleId) : null
        if (overwrites) payload.permissionOverwrites = overwrites
        await channel.edit(payload)
        // Counted only AFTER the edit returns. A `Missing Permissions` throw
        // lands in the catch below, and a channel counted before the await
        // would be reported as opened to the project role beside "nothing to
        // change" — the one claim this feature must never make falsely.
        if (overwrites) result.opened.push(entry.name)
        ;(entry.action === 'move' ? result.moved : result.renamed).push(entry.name)
      } catch (e) {
        note(result.warnings, `channel "${entry.name}"`, e)
      }
    }

    // 3a. The client manual, pinned in the project's support channel — the same
    //     embed #support carries, so a client on this project reads the rules
    //     where they will actually be talking. Presence-only by title and author,
    //     so a run after the pin exists posts nothing and a deleted pin comes
    //     back on the next run. A failure is one warning, never a stopped run.
    const supportChannel = resolved.get('support') ?? null
    if (supportChannel) {
      try {
        await ensureManualPinned(supportChannel, botUserId)
      } catch (e) {
        note(result.warnings, `client manual in ${supportChannel.name ?? 'the support channel'}`, e)
      }
    }

    // 3b. Per-client access on the support pair. Presence-only, one member at
    //     a time — never a whole-array replace that would drop hand-set entries.
    for (const g of plan?.clients?.grant ?? []) {
      const channel = resolved.get(g.key) ?? guild.channels.cache.get(g.channelId) ?? null
      if (!channel) continue
      await grantClients(channel, g.key, [g.memberId], result)
    }
    for (const r of plan?.clients?.revoke ?? []) {
      const channel = resolved.get(r.key) ?? guild.channels.cache.get(r.channelId) ?? null
      if (!channel) continue
      try {
        await channel.permissionOverwrites.delete(r.memberId, REASON)
        result.clientRevoked.push(channel.name)
        console.warn(`[projectSection] client access on "${channel.name}" removed from ${r.memberId}`)
      } catch (e) {
        note(result.warnings, `client access on ${channel.name} for ${r.memberId}`, e)
      }
    }

    // 4. The task channels. ONE edit each — Discord allows two channel edits
    //    per ten minutes, and this branch moves 31 channels — carrying
    //    everything that channel needs at once:
    //      * name, parent and topic. A channel renamed to its title while
    //        keeping `Feature: <title>` as its topic would name a task nothing
    //        can match it to, and /update-task would build a duplicate;
    //      * the project role's allow, when the channel ends up inside the
    //        project's space — its bucket, or the section category it already
    //        sits in. A task channel's overwrites are its own — Discord copies
    //        nothing from the category — so without it the project's members
    //        cannot see their project's task channels. MERGED into what the
    //        channel already carries, never replacing it and never via
    //        `lockPermissions()`, either of which would drop the per-member
    //        overwrites and take a task away from an assignee who is not on
    //        the project.
    //    No resolvable role, or no readable overwrite list: the allow is
    //    skipped, never the rest of the edit.
    let unplaced = 0
    for (const task of plan?.tasks ?? []) {
      if (task.action === 'none') continue
      try {
        const channel = guild.channels.cache.get(task.channelId)
        if (!channel) throw new Error(`channel ${task.channelId} no longer exists`)
        const wantedParent = bucketIdByKey[task.bucket] ?? null
        let action = task.action
        // The bucket could not be made: keep the readable name, stay put.
        if (!wantedParent && (action === 'move' || action === 'both')) {
          unplaced += 1
          action = action === 'both' ? 'rename' : 'none'
          if (action === 'none') continue
        }
        // A `rename` at the category cap means "readable name, stay put", and a
        // `grant` is already where it belongs: both keep the parent they have.
        const stays = action === 'rename' || action === 'grant'
        const parent = stays ? channel.parentId ?? null : wantedParent
        const overwrites = projectCategoryIds.has(parent) ? roleAllowMerged(channel, projectRoleId) : null

        if (action === 'grant') {
          // Nothing to add after all (the role is gone, or the channel gained
          // the allow since it was read): no edit.
          if (!overwrites) continue
          await channel.edit({ permissionOverwrites: overwrites })
          result.tasks += 1
          result.granted.push(channel.name ?? task.name)
          continue
        }

        const payload = { name: task.name, parent }
        if (task.topic) payload.topic = task.topic
        if (overwrites) payload.permissionOverwrites = overwrites
        await channel.edit(payload)
        // A rename or a move that ALSO opens the channel to the project role
        // is a permission change wearing a tidy-up's name. Counted, so the
        // reply can say so — and counted only once the edit has returned, so
        // a throw cannot report a permission change that never happened.
        if (overwrites) result.opened.push(task.name)
        result.tasks += 1
        ;(action === 'rename' ? result.renamed : result.moved).push(task.name)
      } catch (e) {
        note(result.warnings, `task channel "${task.name}"`, e)
      }
    }

    if (unplaced > 0) {
      result.warnings.push(
        `${unplaced} task channel${unplaced === 1 ? '' : 's'} for "${project?.name}" could not be filed because ${unplaced === 1 ? 'its' : 'their'} status bucket could not be created. Run /project-setup again once the bot can create categories.`
      )
    }

    // 4c. Finished tickets filed into Done for the first time: read-only now,
    //     gone in fourteen days — counted from THIS run, so a backfill never
    //     deletes anything the day it runs. Only through a database the caller
    //     passed: the default would be production.
    const retirable = (plan?.tasks ?? []).filter((t) => t.retire)
    if (retirable.length && !db?.task?.update) {
      result.warnings.push(`${retirable.length} finished ticket(s) were not stamped for removal — no database was passed to the applier.`)
    } else {
      for (const task of retirable) {
        try {
          await retire({ channel: guild.channels.cache.get(task.channelId) ?? null, task: { id: task.taskId }, db, now })
          result.retired += 1
        } catch (e) {
          note(result.warnings, `retiring "${task.name}"`, e)
        }
      }
    }
  }

  // 4b. Push-to-talk repair. The project role gets "Use Voice Activity" on the
  //     category and on the voice channels inside it that lack it (and screen
  //     sharing, which travels with it) — one
  //     overwrite edit each, MERGED into what the role already has there
  //     (`permissionOverwrites.edit`, never a replace), and only for the ids the
  //     plan listed, so a preview and a run agree. A channel that has since left
  //     the category is skipped.
  const voice = plan?.voice
  if (categoryId && projectRoleId && (voice?.category?.length || voice?.channels?.length)) {
    const targets = []
    if (voice.category?.length && result.category) targets.push({ channel: result.category, gaps: voice.category })
    for (const entry of voice.channels ?? []) {
      const channel = guild.channels.cache.get(entry.id)
      if (channel && channel.parentId === categoryId && entry.gaps?.length) targets.push({ channel, gaps: entry.gaps })
    }
    for (const { channel: target, gaps } of targets) {
      try {
        // Only the permissions the plan listed, each set to allow: nothing the
        // role already has here is read back or replaced.
        const changes = Object.fromEntries(gaps.map((name) => [name, true]))
        await target.permissionOverwrites.edit(projectRoleId, changes, { reason: REASON })
        result.voiceFixed.push(target.name ?? String(target.id))
      } catch (e) {
        note(result.warnings, `voice activity on "${target.name ?? target.id}"`, e)
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
  // Returned whether or not a roster was brought, so a caller that re-reads the
  // roster after this long apply can refresh the panel without hunting for the
  // channel again.
  result.membersChannel = membersChannel ?? null
  if (membersChannel && members !== undefined) {
    try {
      await ensureMembersPanel(membersChannel, project, members, { botUserId, nameFor })
    } catch (e) {
      note(result.warnings, 'members panel', e)
    }
  }

  // 7. Say who else can see the category.
  //
  //    `mergedOverwrites` keeps every overwrite it did not put there, by
  //    design — dropping a hand-added grant would itself be an unrequested
  //    permission change. But that also means a project whose role was
  //    REPLACED leaves the old role's allow sitting on the category, and its
  //    holders keep seeing the section forever. Removing it silently is not an
  //    option and neither is leaving it unsaid, so it is reported.
  for (const id of foreignRoleAllows(result.category, guild?.id, roleId)) {
    const name = guild?.roles?.cache?.get?.(id)?.name ?? id
    result.warnings.push(
      `The category for "${project?.name}" also lets the role "${name}" see it, and that is not this project's role. Anyone holding it can read this section. /project-setup never removes an overwrite — take it off the category by hand if that is not intended.`
    )
  }

  return result
}

/**
 * The ids of roles OTHER than @everyone and the project's own that are allowed
 * ViewChannel on the category. A leftover from a replaced role, or a moderator
 * role someone added. Empty when the overwrites cannot be read.
 */
function foreignRoleAllows(category, guildId, roleId) {
  const cache = category?.permissionOverwrites?.cache
  if (!cache?.values) return []
  const out = []
  for (const overwrite of cache.values()) {
    if (!overwrite) continue
    if (overwrite.type !== OverwriteType.Role) continue
    if (overwrite.id === guildId || (roleId && overwrite.id === roleId)) continue
    if (!grantsView(overwrite)) continue
    out.push(overwrite.id)
  }
  return out
}

/**
 * Bring the project role in line with `projectmember` in both directions: grant
 * it to members who lack it, take it from holders who are no longer on the
 * project. A member the bot cannot touch is collected, never thrown — one
 * member whose roles sit above the bot's must not stop the rest.
 *
 * `revoke: false` runs the grant half only. A caller whose roster is known to
 * be incomplete — the member list would not load, or the read came back at its
 * hard row limit — must say so explicitly, because the revoke half reads "not
 * in the roster" as "no longer on the project" and would strip the role from
 * real members. Stating it as a flag rather than by padding the roster with
 * every current holder means the suppression cannot quietly stop working if
 * how `holders` is computed ever changes.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{name?: string}} project only for the log line
 * @param {Array<{discordId: string}>} members the project's member rows
 * @param {{roleId: string|null, revoke?: boolean}} opts
 * @returns {Promise<{granted: string[], revoked: string[], failed: string[]}>}
 */
export async function syncProjectRoleMembers(guild, project, members = [], { roleId, revoke = true } = {}) {
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

  if (!revoke) return out

  for (const [id, member] of holders) {
    if (wanted.has(id)) continue
    try {
      await member.roles.remove(target)
      out.revoked.push(id)
      // Logged one at a time, as it happens. "3 revoked" in a reply cannot be
      // undone by hand: an operator restoring a role taken off the wrong
      // person needs the ids, and needs them even if the run dies on the next
      // member.
      console.warn(`[projectSection] role sync for "${project?.name}" — removed role ${roleId} from ${id}`)
    } catch (e) {
      fail(id, e)
    }
  }

  return out
}
