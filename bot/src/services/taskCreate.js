// Creating a Feature or a Bug task: the row, its repositories, its ticket doc,
// its channel, and — after the channel exists — its GitHub issue. Shared by
// /create-task and the site's create route, so a task looks the same in
// Discord whichever made it.
//
// Never replies to anyone — the caller does that with what comes back.

import { ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits } from 'discord.js'
import db from '../db/index.js'
import { createTaskTicketChannel } from './taskTicketChannel.js'
import { createIssue } from './github.js'
import { resolveTaskRepo, loadProjectLinks, repoReasonText } from './taskRepo.js'
import { getOrCreateCategory } from '../utils/categories.js'
import { CATEGORY_BOLD_NAMES } from '../constants.js'
import { TEXT_ALLOW } from '../utils/textAllow.js'
import { scopeLabel } from '../utils/taskScope.js'
import { applyTaskUpdate } from './taskStatusChange.js'

const unique = (ids) => [...new Set(ids.filter(Boolean).map(String))]
const metric = (tracked) => (tracked === true ? 0 : null)

/** The "Created by" field a site-made task's opening embed carries. Null for a Discord-made one. */
function createdByField(actor) {
  if (!actor?.viaSite) return null
  const value = actor.discordId ? `<@${actor.discordId}>` : (actor.label || 'Someone (via the site)')
  return { name: 'Created by', value: String(value).slice(0, 1024), inline: true }
}

/**
 * The project's repository links and the guild's repositories, read through
 * the `db` seam, plus the rule's verdict for this task. `repository.findMany`
 * is read defensively (older callers' fakes don't stub it) — a missing model
 * or a failing read just means the rule finds nothing, same as no links.
 */
async function resolveRepoForTask(dbArg, cfg, projectId, scope) {
  let repos = []
  try {
    repos = (await dbArg.repository?.findMany?.({ where: { guildConfigId: cfg.id } })) ?? []
  } catch (e) {
    console.warn('[taskCreate] repository read failed:', e?.message ?? e)
    repos = []
  }
  const links = await loadProjectLinks(dbArg, projectId)
  const { repository: ruled, reason } = resolveTaskRepo({ projectId, scope }, { links, repos })
  const byId = new Map(repos.map((r) => [String(r.id), r]))
  return { ruled, reason, byId }
}

/** The body every task's GitHub issue opens with. */
function issueBody(fields, project, guild, channel, task) {
  return [
    fields.description || '',
    '',
    '---',
    `Scope: ${scopeLabel(fields.scope) || '—'} · Project: ${project?.name || '—'}`,
    `Discord: https://discord.com/channels/${guild.id}/${channel.id}`,
    `Task ID: ${task.id}`,
  ].join('\n')
}

/**
 * The line that says what happened to a new task's GitHub issue. A failure or
 * a skip is always said, never silent. Shared by /create-task's reply and the
 * site create route's `note` (CSAAS forwards only `note` to the site), so both
 * say it in the same words. Pure.
 *
 * @param {{url:string}|{error:string}|{skipped:string}|null} issue  createTask's `issue`
 */
export function issueReplyLine(issue) {
  if (issue && issue.url) return `Issue: ${issue.url}`
  if (issue && 'error' in issue) return `Issue: not opened — ${issue.error}`
  if (issue && 'skipped' in issue) return `Issue: not opened — ${issue.skipped}`
  return 'Issue: off'
}

/**
 * Open (or skip, or report the failure of) a task's GitHub issue, once its
 * channel exists. Never throws — a GitHub failure is always reported back,
 * never silent, and never undoes the task or its channel. A failure is also
 * said in the task's channel (best-effort); a skip or an opt-out is not.
 */
async function openTaskIssue({ dbArg, model, wantIssue, usedRepo, reasonText, fields, project, guild, channel, task, openIssue }) {
  if (!wantIssue) return { issue: null, issueUrl: '' }
  if (!usedRepo?.url) return { issue: { skipped: reasonText }, issueUrl: '' }
  let res
  try {
    const body = issueBody(fields, project, guild, channel, task)
    res = await openIssue(usedRepo.url, fields.title, body)
  } catch (e) {
    const reason = e?.message ?? String(e)
    try {
      await channel.send({ content: `GitHub issue not opened — ${reason}` })
    } catch (_) { /* best-effort: the reply still reports it */ }
    return { issue: { error: reason }, issueUrl: '' }
  }
  // The issue exists from here on: a failed row write must not hide it.
  try {
    await dbArg[model].update({ where: { id: task.id }, data: { externalIssueUrl: res.url, externalIssueNumber: res.number } })
  } catch (e) {
    console.warn('[taskCreate] issue url write failed:', e?.message ?? e)
  }
  try {
    await channel.send({ content: `GitHub issue: ${res.url}` })
  } catch (_) { /* best-effort: the issue is open either way */ }
  return { issue: { url: res.url }, issueUrl: res.url }
}

/**
 * Move a just-created task to in progress, through the same write every status
 * change uses, but telling nobody: the creation already said everything.
 * `client` is null — the guild is passed, so nothing looks one up.
 */
const moveToInProgress = ({ db: dbArg, task, actor, guild }) =>
  applyTaskUpdate({ db: dbArg, client: null, task, updates: { status: 'in_progress' }, actor, guild, notify: async () => {} })

/**
 * @param {object} opts
 * @param {{type:'feature'|'bug', title:string, description:string|null, scope:string|null, modules:string[], holderIds:string[], repositoryIds:string[], tracks:{apiTests:boolean,qaTests:boolean,acceptanceCriteria:boolean}}} opts.fields
 * @param {object|null} [opts.project]  the project row (required from the site; optional from Discord)
 * @param {object|null} [opts.repo]     a bug's caller-picked repository row ({ id, name, url }); overridden by the rule
 * @param {{discordId?:string|null, label?:string|null, viaSite?:boolean}} [opts.actor]
 * @param {boolean} [opts.createIssue]  per-task opt-out; on by default
 * @param {Function} [opts.setStatus]   moves a new `in_progress` task; a failure is logged, the task stays as created
 * @returns {Promise<{task: object, channel: object|null, fellBack: 'cap'|'missing'|null, issueUrl: string|null, issue: {url:string}|{error:string}|{skipped:string}|null}>}
 */
export async function createTask({
  db: dbArg = db, guild, cfg, fields, project = null, repo = null, actor = {},
  createChannel = createTaskTicketChannel, openIssue = createIssue, getCategory = getOrCreateCategory,
  createIssue: wantIssue = true, setStatus = moveToInProgress,
}) {
  const creator = actor.discordId ?? null
  const holders = unique(fields.holderIds || [])
  // /create-task always put the invoker first (`[interaction.user.id, ...ids]`,
  // for both the feature and bug branches) — preserved exactly so a Discord-made
  // task's mention list and overwrite order don't change. The site actor is not
  // the point of the task, so they're tacked onto the end of the holders instead.
  const members = unique(actor.viaSite ? [...holders, creator] : [creator, ...holders])
  const passed = {
    passedApiTests: metric(fields.tracks?.apiTests),
    passedQaTests: metric(fields.tracks?.qaTests),
    passedAcceptanceCriteria: metric(fields.tracks?.acceptanceCriteria),
  }
  const createdBy = createdByField(actor)
  // `fields.status`: absent or 'open' is today's path. 'done' records finished
  // work — the row and its ticket doc, but no channel and no issue. 'in_progress'
  // is today's path and then a status change.
  const done = fields.status === 'done'
  const finish = async (made) => {
    if (fields.status !== 'in_progress') return made
    try {
      await setStatus({ db: dbArg, task: made.task, actor, guild })
      return { ...made, task: { ...made.task, status: 'in_progress' } }
    } catch (e) {
      console.error('[taskCreate] in-progress move failed:', e?.message ?? e)
      return made
    }
  }
  const doneResult = (task) => ({ task, channel: null, fellBack: null, issueUrl: null, issue: null })

  if (fields.type === 'feature') {
    const { ruled, reason, byId } = await resolveRepoForTask(dbArg, cfg, project?.id, fields.scope)
    const pickedRepo = fields.repositoryIds?.[0] ? byId.get(String(fields.repositoryIds[0])) : null
    const usedRepo = ruled ?? pickedRepo ?? null

    const task = await dbArg.feature.create({
      data: {
        guildConfigId: cfg.id,
        repositoryId: ruled?.id ?? fields.repositoryIds?.[0] ?? null,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        title: fields.title,
        description: fields.description ?? null,
        createdBy: creator,
        assigneeIds: holders,
        status: done ? 'done' : 'open',
        modules: fields.modules || [],
        scope: fields.scope ?? null,
        implementationStatus: 'not_started',
        ...passed,
      },
    })
    if (fields.repositoryIds?.length) await dbArg.featureRepositories.add(task.id, fields.repositoryIds)
    await dbArg.ticketDoc.create({ data: { guildConfigId: cfg.id, ticketType: 'feature', taskId: task.id, title: fields.title?.slice(0, 512) || 'Feature', content: null } })
    if (done) return doneResult(task)

    const scopeMod = [scopeLabel(fields.scope), (fields.modules?.length ? fields.modules.join(', ') : null)].filter(Boolean).join(' · ')
    const { channel, fellBack } = await createChannel(guild, {
      taskId: task.id,
      title: fields.title,
      description: fields.description,
      memberIds: members,
      project,
      type: 'feature',
      status: 'open',
      fields: [
        { name: 'Status', value: 'open', inline: true },
        { name: 'Assignees', value: (holders.map((id) => `<@${id}>`).join(' ') || 'None'), inline: true },
        { name: 'Scope / Modules', value: scopeMod || '—', inline: false },
        ...(createdBy ? [createdBy] : []),
      ],
      closeHint: 'Use **/close-feature** in this channel when done.',
      // Straight after the create, before the opening embed is sent: a `send`
      // that throws must not leave a channel with no row pointing at it.
      onCreated: (made) => dbArg.feature.update({ where: { id: task.id }, data: { discordChannelId: made.id } }),
    })
    const { issue, issueUrl } = await openTaskIssue({
      dbArg, model: 'feature', wantIssue, usedRepo, reasonText: repoReasonText(reason),
      fields, project, guild, channel, task, openIssue,
    })
    return finish({ task, channel, fellBack, issueUrl, issue })
  }

  // Bug.
  const { ruled, reason } = await resolveRepoForTask(dbArg, cfg, project?.id, fields.scope)
  const usedRepo = ruled ?? repo ?? null
  const taggedMentions = holders.map((id) => `<@${id}>`).join(' ')
  const task = await dbArg.bugTicket.create({
    data: {
      guildConfigId: cfg.id,
      repositoryId: ruled?.id ?? repo?.id ?? null,
      // Only when there is one: /create-task's project-less bug row stays
      // exactly as it was, without two extra null columns.
      ...(project ? { projectId: project.id, projectName: project.name } : {}),
      title: fields.title,
      description: fields.description || null,
      status: done ? 'done' : 'pending',
      taggedMemberIds: holders,
      createdBy: creator,
      scope: fields.scope ?? null,
      ...passed,
    },
  })

  await dbArg.ticketDoc.create({ data: { guildConfigId: cfg.id, ticketType: 'bug', taskId: task.id, title: (fields.title || 'Bug').slice(0, 512), content: null } })
  if (done) return doneResult(task)

  const bugFields = [
    { name: 'Status', value: 'pending', inline: true },
    { name: 'Scope', value: scopeLabel(fields.scope) || '—', inline: true },
    { name: 'Tagged', value: taggedMentions || 'None', inline: true },
    { name: 'Repository', value: usedRepo?.url || '—', inline: false },
    ...(createdBy ? [createdBy] : []),
  ]

  if (project) {
    // A bug filed under a project lives in that project's section, exactly as a
    // client-reported bug does (services/clientRequest.js).
    const { channel, fellBack } = await createChannel(guild, {
      taskId: task.id,
      title: fields.title,
      description: fields.description,
      memberIds: members,
      project,
      type: 'bug',
      status: 'pending',
      fields: bugFields,
      closeHint: 'Use **/resolve-bug** in this channel when fixed.',
      onCreated: (made) => dbArg.bugTicket.update({ where: { id: task.id }, data: { discordChannelId: made.id } }),
    })
    const { issue, issueUrl } = await openTaskIssue({
      dbArg, model: 'bugTicket', wantIssue, usedRepo, reasonText: repoReasonText(reason),
      fields, project, guild, channel, task, openIssue,
    })
    return finish({ task, channel, fellBack, issueUrl, issue })
  }

  // No project (only /create-task makes these): the global Bugs category,
  // unchanged from before this service existed.
  const category = await getCategory(guild, 'Bugs', { orNames: [CATEGORY_BOLD_NAMES['Bugs']].filter(Boolean) })
  const overwrites = [
    { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    ...members.map((id) => ({ id, type: OverwriteType.Member, allow: TEXT_ALLOW })),
  ]
  const channel = await guild.channels.create({
    name: `bug-${task.id.slice(-6)}`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Bug: ${fields.title} | Repo: ${usedRepo?.name || '—'}`,
    permissionOverwrites: overwrites,
  })
  await dbArg.bugTicket.update({ where: { id: task.id }, data: { discordChannelId: channel.id } })

  const allMentions = members.map((id) => `<@${id}>`).join(' ')
  const embed = new EmbedBuilder()
    .setTitle(`Bug: ${fields.title}`)
    .setDescription((fields.description || 'No description.').slice(0, 1000))
    .addFields(
      { name: 'Status', value: 'pending', inline: true },
      { name: 'Scope', value: scopeLabel(fields.scope) || '—', inline: true },
      { name: 'Tagged', value: taggedMentions || 'None', inline: true },
      { name: 'Repository', value: usedRepo?.url || '—', inline: false },
      { name: 'Resolve', value: 'Use **/resolve-bug** in this channel when fixed.', inline: false },
    )
    .setFooter({ text: `Ticket ID: ${task.id}` })
    .setColor(0xed4245)
  await channel.send({ content: allMentions || null, embeds: [embed] })
  // A project-less bug: the rule has nothing to say, so the only reason is that none was picked.
  const { issue, issueUrl } = await openTaskIssue({
    dbArg, model: 'bugTicket', wantIssue, usedRepo, reasonText: 'no repository was picked',
    fields, project, guild, channel, task, openIssue,
  })
  return finish({ task, channel, fellBack: null, issueUrl, issue })
}
