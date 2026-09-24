// A client's issue or feature request: an ordinary task row with `requestedBy`
// set, the existing private task channel with the client in it, the client's
// documents re-uploaded there (Discord CDN links expire), and a notice to the
// team. Every Discord side effect after the row is best-effort — the row is
// the request; the rest is how people hear about it.
import db from '../db/index.js'
import { createTaskTicketChannel, dmTaskAssignees } from './taskTicketChannel.js'
import { storedChannels } from './projectSection.js'

/** Discord's upload cap for a bot without boosts. Bigger files are linked, not copied. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

export function clientProjects(rows) {
  return (rows ?? []).filter((r) => r?.role === 'client')
}

/** The channel's opening line: no developer should be surprised who can read it. */
export function requestDescription(name, details) {
  return `Client request — ${name} can read this channel.\n\n${String(details ?? '').trim()}`
}

/** What to re-upload and what to merely link. Pure. */
export function attachmentPlan(attachments, limit = MAX_UPLOAD_BYTES) {
  const files = []
  const links = []
  for (const a of attachments ?? []) {
    if (!a?.url) continue
    const name = a.name || 'document'
    if (Number(a.size ?? 0) > limit) links.push({ name, url: a.url })
    else files.push({ attachment: a.url, name })
  }
  return { files, links }
}

const displayName = (guild, user) =>
  guild?.members?.cache?.get?.(user.id)?.displayName ?? user.globalName ?? user.username ?? user.id

export async function createClientRequest({
  guild, client, user, cfg, type, title, details, project = null, attachments = [],
  db: dbArg = db, createChannel = createTaskTicketChannel, dm = dmTaskAssignees,
}) {
  const isBug = type === 'bug'
  const name = displayName(guild, user)

  const task = await dbArg.task.create({
    data: {
      guildConfigId: cfg.id,
      type: isBug ? 'bug' : 'feature',
      is_bug: isBug ? 1 : 0,
      is_feature: isBug ? 0 : 1,
      title: String(title).trim().slice(0, 200),
      description: String(details).trim(),
      status: 'open',
      createdBy: user.id,
      requestedBy: user.id,
      assigneeIds: [],
      taggedMemberIds: [],
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      modules: [],
    },
  })
  await dbArg.ticketDoc.create({
    data: { guildConfigId: cfg.id, ticketType: isBug ? 'bug' : 'feature', taskId: task.id, title: task.title?.slice(0, 512) || 'Request', content: null },
  }).catch(() => {})

  const { channel, fellBack } = await createChannel(guild, {
    taskId: task.id,
    title: task.title,
    description: requestDescription(name, details),
    memberIds: [user.id],
    project,
    type: isBug ? 'bug' : 'feature',
    // Client-safe: no scope, modules or estimate. The project is the only field.
    fields: project ? [{ name: 'Project', value: project.name, inline: true }] : [],
    closeHint: null,
    onCreated: (made) => dbArg.task.update({ where: { id: task.id }, data: { discordChannelId: made.id } }).catch(() => {}),
  })

  // Pin the opening message so the "client can read this" line stays visible.
  const first = await channel.messages?.fetch?.({ limit: 1 }).catch(() => null)
  const opening = first?.first?.() ?? (first ? [...first.values()][0] : null)
  await opening?.pin?.().catch(() => {})

  const { files, links } = attachmentPlan(attachments)
  if (files.length || links.length) {
    const content = ['Documents from the request:', ...links.map((l) => `• ${l.name}: ${l.url} (too large to copy here)`)].join('\n')
    await channel.send({ content, ...(files.length ? { files } : {}) }).catch((e) => console.warn('[clientRequest] attachments post failed:', e?.message || e))
  }

  // Tell the team. A project request: its support channel (same customer) and
  // a DM to its leads. No project: #admin. Never the global support channel —
  // every company's clients share it.
  let noticedIn = null
  const notice = `New request from **${name}**: **${task.title}** → <#${channel.id}>`
  const supportId = project ? storedChannels(project).support : null
  const supportChannel = supportId ? guild.channels?.cache?.get?.(supportId) ?? null : null
  if (supportChannel) {
    await supportChannel.send({ content: notice }).catch(() => {})
    noticedIn = supportChannel.id
    const roster = await dbArg.projectMember.findByProject({ where: { projectId: project.id } }).catch(() => [])
    const leads = (roster ?? []).filter((m) => m?.role === 'lead').map((m) => String(m.discordId))
    if (leads.length) await dm(client, leads, { title: task.title, channelId: channel.id, note: `A client request${project ? ` on **${project.name}**` : ''}.` })
  } else if (cfg.adminChannelId) {
    const admin = await guild.channels?.fetch?.(cfg.adminChannelId).catch(() => null)
    if (admin?.send) {
      await admin.send({ content: notice + (project ? '' : ' (no project)') }).catch(() => {})
      noticedIn = admin.id
    }
  }

  return { task, channel, fellBack, noticedIn }
}
