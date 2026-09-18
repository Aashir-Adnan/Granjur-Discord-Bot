// One private channel per task, plus a best-effort DM to the people on it.
//
// `/create-task` has always done this for a feature ticket: a channel that only
// the assigner and the assignees can see, opened with an embed that @-mentions
// them. A meeting-generated task is the same kind of row, so it gets the same
// treatment — a single ping in a shared channel is easy to miss (and, for a
// `/record` meeting, lands in the voice channel's own chat), whereas a new
// channel plus a DM reaches the person.
//
// A task that belongs to a project lives in that project's own category with a
// name built from its title (`taskChannelName`) instead of six hex characters —
// the id moves to the channel topic instead. A task with no project, or whose
// project's category is gone or full, keeps today's behaviour exactly: the
// global Features/Bugs category and a name built from the last six characters
// of the task id.
import { ChannelType, PermissionFlagsBits, EmbedBuilder, OverwriteType } from 'discord.js'
import { getOrCreateCategory } from '../utils/categories.js'
// The cap comes from `constants.js`, a leaf, and NOT from `projectSection.js`,
// which re-exports it: importing the planner here dragged
// projectMembersPanel → db/index.js into this leaf helper, so its test loaded
// the whole database layer and the production `.env` to touch no database.
import { CATEGORY_BOLD_NAMES, CATEGORY_SOFT_CAP } from '../constants.js'
import { taskChannelName, taskChannelTopic } from '../utils/taskChannelName.js'

const MEMBER_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
]

/**
 * What the project role may do in a task channel that sits inside its own
 * section — the text half of the set the project's category grants
 * (`ROLE_ALLOW` in `projectSection.js`; `Connect`/`Speak` mean nothing on a
 * text channel). Spelled out here because an explicit `permissionOverwrites`
 * array makes Discord store EXACTLY that set: nothing is copied from the
 * parent, and permission resolution never walks up to the category.
 */
const PROJECT_ROLE_PERMS = MEMBER_PERMS

/** A discord.js Collection or a plain Map, read the same way. */
function valuesOf(cache) {
  return cache?.values ? [...cache.values()] : []
}

function countChannelsInCategory(guild, categoryId) {
  return valuesOf(guild?.channels?.cache).filter((c) => c?.parentId === categoryId).length
}

const globalCategory = (guild, categoryLabel) =>
  getOrCreateCategory(guild, categoryLabel, {
    orNames: [CATEGORY_BOLD_NAMES[categoryLabel]].filter(Boolean),
  })

/**
 * Where a new task channel's category goes: the project's own category when
 * the project has one, it still resolves to a CATEGORY, and it is not at
 * Discord's soft cap — the global Features/Bugs category (created or reused by
 * name, as today) otherwise. A project that cannot be used is a `console.warn`,
 * never a thrown error — the channel still gets created, just not where the
 * caller hoped.
 *
 * The reason comes back with the category, because spec §4 and §11 require the
 * command's reply to say when a task channel was diverted, and a caller that
 * compared `parentId` against `discordCategoryId` afterwards would be four
 * copies of the same guess.
 *
 * @returns {Promise<{category: object, fellBack: 'cap'|'missing'|null}>}
 */
async function resolveParentCategory(guild, project, categoryLabel) {
  if (!project) return { category: await globalCategory(guild, categoryLabel), fellBack: null }

  const stored = project.discordCategoryId
    ? guild.channels?.cache?.get?.(project.discordCategoryId) ?? null
    : null
  // A stored id that now resolves to a text channel is not somewhere a channel
  // can be parented. Without this guard it is passed to Discord as `parent` and
  // the error surfaces after the task row is already written.
  const projectCategory = stored?.type === ChannelType.GuildCategory ? stored : null

  if (!projectCategory) {
    console.warn(
      `[taskTicket] project "${project?.name}" has no usable category; the task channel was created in the global ${categoryLabel} category instead.`
    )
    return { category: await globalCategory(guild, categoryLabel), fellBack: 'missing' }
  }
  if (countChannelsInCategory(guild, projectCategory.id) >= CATEGORY_SOFT_CAP) {
    console.warn(
      `[taskTicket] project "${project?.name}"'s category is at Discord's cap (${CATEGORY_SOFT_CAP} channels); the task channel was created in the global ${categoryLabel} category instead.`
    )
    return { category: await globalCategory(guild, categoryLabel), fellBack: 'cap' }
  }
  return { category: projectCategory, fellBack: null }
}

/**
 * Create the private channel for one task and post its opening embed.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} opts
 * @param {string} opts.taskId          - bot task row id
 * @param {string} opts.title
 * @param {string} [opts.description]
 * @param {string[]} opts.memberIds     - everyone who may see the channel; deduped
 * @param {{name: string, value: string, inline?: boolean}[]} [opts.fields]
 * @param {{id: string, name?: string, discordCategoryId?: string|null}|null} [opts.project]
 *   the task's project, when it has one. With a project whose category still
 *   resolves and has room, the channel is named after the title
 *   (`taskChannelName`) and parented there. Without one — or when the
 *   category is gone or at Discord's soft cap — the channel keeps today's
 *   behaviour: the global Features/Bugs category and `<prefix>-<last six of
 *   the task id>`.
 * @param {string} [opts.type]          - 'bug' or anything else (feature); default feature
 * @param {string} [opts.closeHint]     - appended as a "Close" field when given
 * @param {(channel: object) => Promise<void>} [opts.onCreated]
 *   run with the new channel BETWEEN the create and the opening embed, so a
 *   caller can point its row at the channel before anything can fail: a `send`
 *   that throws must not leave a channel with no row pointing at it.
 * @returns {Promise<{channel: import('discord.js').TextChannel, fellBack: 'cap'|'missing'|null}>}
 *   `fellBack` says why the channel is not in the project's section: `'cap'`
 *   the section is full, `'missing'` the project has no category the bot can
 *   use, `null` it is where it should be (or there was no project).
 */
export async function createTaskTicketChannel(guild, opts) {
  const {
    taskId,
    title,
    description,
    memberIds = [],
    fields = [],
    project = null,
    type,
    closeHint = null,
    onCreated = null,
  } = opts

  const isBug = type === 'bug'
  const categoryLabel = isBug ? 'Bugs' : 'Features'
  const namePrefix = isBug ? 'bug' : 'feature'
  const members = [...new Set(memberIds.filter(Boolean))]

  const { category, fellBack } = await resolveParentCategory(guild, project, categoryLabel)

  const name = project
    ? taskChannelName({
        type,
        title,
        taskId,
        taken: new Set(valuesOf(guild?.channels?.cache).map((c) => c?.name).filter(Boolean)),
      })
    : `${namePrefix}-${String(taskId).slice(-6)}`

  // The guild id is a ROLE (@everyone); a member id is a USER. Passing type 0
  // for a user makes Discord discard the overwrite without an error, and the
  // ticket channel ends up visible to nobody — which is what happened to
  // feature-f56be0 on 2026-09-04.
  const permissionOverwrites = [
    { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
  ]
  // An explicit overwrite array is stored EXACTLY as passed: Discord copies
  // nothing from the parent and resolution does not walk up to the category, so
  // a channel inside a project's section has to carry the project role's allow
  // itself or the project members it belongs to cannot see their own task.
  // Only when it really is inside that section — in the global Features/Bugs
  // category the audience is the assignees, exactly as before, and adding the
  // role there would be a grant nobody asked for.
  if (!fellBack && project?.discordRoleId) {
    permissionOverwrites.push({
      id: project.discordRoleId,
      type: OverwriteType.Role,
      allow: PROJECT_ROLE_PERMS,
    })
  }
  // The per-member entries are in ADDITION to that (spec §5), so an assignee
  // who is not on the project still sees their task.
  permissionOverwrites.push(
    ...members.map((id) => ({ id, type: OverwriteType.Member, allow: MEMBER_PERMS }))
  )

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    // The id lived in the name; now that the name is the title, the id moves
    // here so it stays one click away for support and for /update-task.
    topic: taskChannelTopic({ type, title, taskId }),
    permissionOverwrites,
  })

  if (onCreated) await onCreated(channel)

  const embed = new EmbedBuilder()
    .setTitle(`${isBug ? 'Bug' : 'Feature'}: ${String(title || 'Task').slice(0, 200)}`)
    .setDescription((description || 'No description.').slice(0, 1000))
    .addFields(...fields.slice(0, 20), { name: 'Task ID', value: String(taskId), inline: false })
    .setColor(isBug ? 0xed4245 : 0x5865f2)
  if (closeHint) embed.addFields({ name: 'Close', value: closeHint, inline: false })

  const mentions = members.map((id) => `<@${id}>`).join(' ')
  await channel.send({ content: mentions || null, embeds: [embed] })
  return { channel, fellBack }
}

/**
 * DM each user a one-line pointer at their new task. Best effort: a user with
 * DMs closed is skipped silently, because the channel above already reached them.
 * @returns {Promise<number>} how many DMs were delivered
 */
export async function dmTaskAssignees(client, userIds, { title, channelId, note = '' } = {}) {
  const ids = [...new Set((userIds || []).filter(Boolean))]
  let delivered = 0
  for (const id of ids) {
    try {
      const user = await client.users.fetch(id)
      const where = channelId ? ` — discuss it in <#${channelId}>` : ''
      await user.send(
        `You've been assigned **${title}**${where}.${note ? `\n${note}` : ''}`,
      )
      delivered += 1
    } catch (e) {
      // Closed DMs are the common case and are not an error worth a stack trace.
      console.warn(`[taskTicket] DM to ${id} failed:`, e?.message || e)
    }
  }
  return delivered
}
