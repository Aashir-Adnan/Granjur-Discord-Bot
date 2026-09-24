// A client's issue or feature request: an ordinary task row with `requestedBy`
// set, the existing private task channel with the client in it, the client's
// documents re-uploaded there (Discord CDN links expire), and a notice to the
// team. Every Discord side effect after the row is best-effort — the row is
// the request; the rest is how people hear about it.
import db from '../db/index.js'
import { createTaskTicketChannel, dmTaskAssignees } from './taskTicketChannel.js'
import { storedChannels } from './projectSection.js'
import { isClientRole, managerIdsOf } from '../utils/clientRoles.js'

/** Discord's upload cap for a bot without boosts. Bigger files are linked, not copied. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

export function clientProjects(rows) {
  return (rows ?? []).filter((r) => isClientRole(r?.role))
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

const PLATFORMS = ['Web', 'Android', 'iOS', 'Windows', 'macOS', 'Linux', 'Other']

/**
 * The structured fields a client can fill beside the free text — the things a
 * developer otherwise has to go back and ask for. All optional: a client is
 * never blocked from filing, and an empty field is simply absent. `group`
 * fields share one line joined with ' · '; the rest each get a line of their
 * own. The builder, the option reader and the composer all read this table.
 */
export const ISSUE_FIELDS = [
  { name: 'platform', label: 'Platform', kind: 'choice', choices: PLATFORMS, group: 1, description: 'Where it happened' },
  { name: 'semester', label: 'Semester', kind: 'text', max: 100, group: 1, description: 'The semester this concerns, e.g. Fall 2026' },
  { name: 'os', label: 'OS', kind: 'text', max: 100, group: 1, description: 'Operating system and version, e.g. Windows 11, iOS 17.4' },
  { name: 'app_version', label: 'App/Browser', kind: 'text', max: 100, group: 1, description: 'Browser or app version, e.g. Chrome 129, App 2.4.1' },
  { name: 'severity', label: 'Severity', kind: 'choice', choices: ['Blocking', 'Major', 'Minor', 'Cosmetic'], group: 2, description: 'How badly it hurts' },
  { name: 'frequency', label: 'Frequency', kind: 'choice', choices: ['Every time', 'Sometimes', 'Once'], group: 2, description: 'How often it happens' },
  { name: 'when', label: 'When', kind: 'text', max: 100, group: 2, description: 'When it happened, e.g. today ~3pm, since Monday' },
  { name: 'account', label: 'Account', kind: 'text', max: 100, group: 2, description: 'Which user or account it happened to' },
  { name: 'steps', label: 'Steps', kind: 'text', max: 1000, description: 'How to make it happen, step by step' },
  { name: 'expected', label: 'Expected', kind: 'text', max: 500, description: 'What should have happened instead' },
]

export const FEATURE_FIELDS = [
  { name: 'platform', label: 'Platform', kind: 'choice', choices: PLATFORMS, group: 1, description: 'Where it should exist' },
  { name: 'semester', label: 'Semester', kind: 'text', max: 100, group: 1, description: 'The semester this is for, e.g. Spring 2027' },
  { name: 'priority', label: 'Priority', kind: 'choice', choices: ['Must have', 'Should have', 'Nice to have'], group: 1, description: 'How much it matters to you' },
  { name: 'needed_by', label: 'Needed by', kind: 'text', max: 100, group: 1, description: 'A date, or an event it is needed for' },
  { name: 'problem', label: 'Problem', kind: 'text', max: 1000, description: 'What this solves, and why it is needed' },
  { name: 'who', label: 'Who needs it', kind: 'text', max: 200, description: 'Which users or roles' },
  { name: 'example', label: 'Example', kind: 'text', max: 300, description: 'A link, or a product that already does it' },
]

/** A support task: the team handling data at a level an admin cannot reach. */
export const TASK_FIELDS = [
  { name: 'platform', label: 'Platform', kind: 'choice', choices: PLATFORMS, group: 1, description: 'Where the data lives' },
  { name: 'semester', label: 'Semester', kind: 'text', max: 100, group: 1, description: 'The semester the data belongs to, e.g. Fall 2026' },
  { name: 'needed_by', label: 'Needed by', kind: 'text', max: 100, group: 1, description: 'A date, or an event it is needed for' },
  { name: 'scope', label: 'Scope', kind: 'text', max: 1000, description: 'Which students, records or data, exactly' },
  { name: 'reason', label: 'Why the team', kind: 'text', max: 500, description: 'What stops an admin from doing this in the app' },
]

/**
 * The three kinds a client can raise, as the task row records them. A support
 * task is neither a bug nor a feature — its own `type`, both flags off — so
 * nothing downstream mistakes it for either.
 */
const KIND = {
  bug: { type: 'bug', is_bug: 1, is_feature: 0 },
  feature: { type: 'feature', is_bug: 0, is_feature: 1 },
  task: { type: 'task', is_bug: 0, is_feature: 0 },
}

/**
 * The task description: a header of the filled fields, then the free text.
 * Nothing filled → exactly the free text, so a client who only types title
 * and details produces what they always did. Pure.
 */
export function composeDetails(fields, values, details) {
  const clean = (v) => String(v ?? '').trim()
  const groups = new Map()
  const lines = []
  for (const f of fields ?? []) {
    const v = clean(values?.[f.name])
    if (!v) continue
    const part = `**${f.label}:** ${v}`
    if (f.group) {
      if (!groups.has(f.group)) groups.set(f.group, [])
      groups.get(f.group).push(part)
    } else {
      lines.push(part)
    }
  }
  const header = [...[...groups.keys()].sort((a, b) => a - b).map((k) => groups.get(k).join(' · ')), ...lines]
  const text = clean(details)
  return header.length ? `${header.join('\n')}\n\n${text}` : text
}

/** Discord messages cap at 2000 characters; the full description may not. Pure. */
export function chunkText(text, size = 1900) {
  const s = String(text ?? '')
  const out = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

/** What createTaskTicketChannel shows of a description before cutting it. */
const EMBED_DESCRIPTION_CAP = 1000

const displayName = (guild, user) =>
  guild?.members?.cache?.get?.(user.id)?.displayName ?? user.globalName ?? user.username ?? user.id

export async function createClientRequest({
  guild, client, user, cfg, type, title, details, project = null, attachments = [],
  db: dbArg = db, createChannel = createTaskTicketChannel, dm = dmTaskAssignees,
}) {
  const kind = KIND[type] ?? KIND.feature
  const name = displayName(guild, user)

  const task = await dbArg.task.create({
    data: {
      guildConfigId: cfg.id,
      type: kind.type,
      is_bug: kind.is_bug,
      is_feature: kind.is_feature,
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
    data: { guildConfigId: cfg.id, ticketType: kind.type, taskId: task.id, title: task.title?.slice(0, 512) || 'Request', content: null },
  }).catch(() => {})

  // The project's client managers read every request channel from the moment
  // it exists; the requester is already in the room, so they are not doubled.
  const roster = project
    ? (await dbArg.projectMember.findByProject({ where: { projectId: project.id } }).catch(() => [])) ?? []
    : []
  const managers = managerIdsOf(roster, user.id)

  const { channel, fellBack } = await createChannel(guild, {
    taskId: task.id,
    title: task.title,
    description: requestDescription(name, details),
    memberIds: [user.id, ...managers],
    project,
    type: kind.type,
    status: task.status,
    // Client-safe: no scope, modules or estimate. The project is the only field.
    fields: project ? [{ name: 'Project', value: project.name, inline: true }] : [],
    closeHint: null,
    onCreated: (made) => dbArg.task.update({ where: { id: task.id }, data: { discordChannelId: made.id } }).catch(() => {}),
  })

  // Pin the opening message so the "client can read this" line stays visible.
  const first = await channel.messages?.fetch?.({ limit: 1 }).catch(() => null)
  const opening = first?.first?.() ?? (first ? [...first.values()][0] : null)
  await opening?.pin?.().catch(() => {})

  // The pinned embed shows at most the first 1000 characters, and the
  // structured fields can push a real report past that. The team must not
  // have to open the task to read the rest, so it follows as plain messages.
  const fullText = String(details ?? '').trim()
  if (fullText.length > EMBED_DESCRIPTION_CAP) {
    const chunks = chunkText(fullText)
    for (let i = 0; i < chunks.length; i++) {
      await channel.send({ content: `${i === 0 ? '**Full details**\n' : ''}${chunks[i]}` })
        .catch((e) => console.warn('[clientRequest] full details post failed:', e?.message || e))
    }
  }

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
    const leads = roster.filter((m) => m?.role === 'lead').map((m) => String(m.discordId))
    // Leads and the client managers: the people who answer for the team and
    // for the client side. Never the requester about their own request.
    const told = [...new Set([...leads, ...managers])].filter((id) => id !== String(user.id))
    if (told.length) await dm(client, told, { title: task.title, channelId: channel.id, headline: `A client raised **${task.title}**`, note: `A client request${project ? ` on **${project.name}**` : ''}.` })
  } else if (cfg.adminChannelId) {
    const admin = await guild.channels?.fetch?.(cfg.adminChannelId).catch(() => null)
    if (admin?.send) {
      await admin.send({ content: notice + (project ? '' : ' (no project)') }).catch(() => {})
      noticedIn = admin.id
    }
  }

  return { task, channel, fellBack, noticedIn }
}
