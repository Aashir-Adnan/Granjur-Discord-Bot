// Creating a Feature or a Bug task: the row, its repositories, its ticket doc,
// the bug's GitHub issue, and its channel. Shared by /create-task and the site's
// create route, so a task looks the same in Discord whichever made it.
//
// Never replies to anyone — the caller does that with what comes back.

import { ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits } from 'discord.js'
import db from '../db/index.js'
import { createTaskTicketChannel } from './taskTicketChannel.js'
import { createIssue } from './github.js'
import { getOrCreateCategory } from '../utils/categories.js'
import { CATEGORY_BOLD_NAMES } from '../constants.js'
import { TEXT_ALLOW } from '../utils/textAllow.js'
import { scopeLabel } from '../utils/taskScope.js'

const unique = (ids) => [...new Set(ids.filter(Boolean).map(String))]
const metric = (tracked) => (tracked === true ? 0 : null)

/** The "Created by" field a site-made task's opening embed carries. Null for a Discord-made one. */
function createdByField(actor) {
  if (!actor?.viaSite) return null
  const value = actor.discordId ? `<@${actor.discordId}>` : (actor.label || 'Someone (via the site)')
  return { name: 'Created by', value: String(value).slice(0, 1024), inline: true }
}

/**
 * @param {object} opts
 * @param {{type:'feature'|'bug', title:string, description:string|null, scope:string|null, modules:string[], holderIds:string[], repositoryIds:string[], tracks:{apiTests:boolean,qaTests:boolean,acceptanceCriteria:boolean}}} opts.fields
 * @param {object|null} [opts.project]  the project row (required from the site; optional from Discord)
 * @param {object|null} [opts.repo]     a bug's repository row ({ id, name, url })
 * @param {{discordId?:string|null, label?:string|null, viaSite?:boolean}} [opts.actor]
 * @returns {Promise<{task: object, channel: object, fellBack: 'cap'|'missing'|null, issueUrl: string}>}
 */
export async function createTask({
  db: dbArg = db, guild, cfg, fields, project = null, repo = null, actor = {},
  createChannel = createTaskTicketChannel, openIssue = createIssue, getCategory = getOrCreateCategory,
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

  if (fields.type === 'feature') {
    const task = await dbArg.feature.create({
      data: {
        guildConfigId: cfg.id,
        repositoryId: fields.repositoryIds?.[0] ?? null,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        title: fields.title,
        description: fields.description ?? null,
        createdBy: creator,
        assigneeIds: holders,
        status: 'open',
        modules: fields.modules || [],
        scope: fields.scope ?? null,
        implementationStatus: 'not_started',
        ...passed,
      },
    })
    if (fields.repositoryIds?.length) await dbArg.featureRepositories.add(task.id, fields.repositoryIds)
    await dbArg.ticketDoc.create({ data: { guildConfigId: cfg.id, ticketType: 'feature', taskId: task.id, title: fields.title?.slice(0, 512) || 'Feature', content: null } })

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
    return { task, channel, fellBack, issueUrl: '' }
  }

  // Bug.
  const taggedMentions = holders.map((id) => `<@${id}>`).join(' ')
  const task = await dbArg.bugTicket.create({
    data: {
      guildConfigId: cfg.id,
      repositoryId: repo?.id ?? null,
      // Only when there is one: /create-task's project-less bug row stays
      // exactly as it was, without two extra null columns.
      ...(project ? { projectId: project.id, projectName: project.name } : {}),
      title: fields.title,
      description: fields.description || null,
      status: 'pending',
      taggedMemberIds: holders,
      createdBy: creator,
      scope: fields.scope ?? null,
      ...passed,
    },
  })

  let issueUrl = ''
  if (repo?.url) {
    try {
      const body = [fields.description || '', `\n---\n**Tagged:** ${taggedMentions || 'none'}`, `**Ticket ID:** ${task.id}`].join('\n')
      const res = await openIssue(repo.url, fields.title, body)
      if (res?.url) {
        issueUrl = res.url
        await dbArg.bugTicket.update({ where: { id: task.id }, data: { externalIssueUrl: res.url, externalIssueNumber: res.number } })
      }
    } catch (_) {}
  }

  await dbArg.ticketDoc.create({ data: { guildConfigId: cfg.id, ticketType: 'bug', taskId: task.id, title: (fields.title || 'Bug').slice(0, 512), content: null } })

  const bugFields = [
    { name: 'Status', value: 'pending', inline: true },
    { name: 'Scope', value: scopeLabel(fields.scope) || '—', inline: true },
    { name: 'Tagged', value: taggedMentions || 'None', inline: true },
    { name: 'Repository', value: repo?.url || '—', inline: false },
    ...(issueUrl ? [{ name: 'Issue', value: issueUrl, inline: false }] : []),
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
    return { task, channel, fellBack, issueUrl }
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
    topic: `Bug: ${fields.title} | Repo: ${repo?.name || '—'}`,
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
      { name: 'Repository', value: repo?.url || '—', inline: false },
      { name: 'Resolve', value: 'Use **/resolve-bug** in this channel when fixed.', inline: false },
      ...(issueUrl ? [{ name: 'Issue', value: issueUrl, inline: false }] : [])
    )
    .setFooter({ text: `Ticket ID: ${task.id}` })
    .setColor(0xed4245)
  await channel.send({ content: allMentions || null, embeds: [embed] })
  return { task, channel, fellBack: null, issueUrl }
}
