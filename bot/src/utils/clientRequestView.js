// What a client sees of their request. Pure. The one deliberate difference
// from the staff labels: `pending` reads "Waiting on you" — it is the status a
// developer sets when they need something from the client.
import { STATUS_LABEL } from './taskDeps.js'

export function requestStatusLabel(status) {
  if (status === 'pending') return 'Waiting on you'
  return STATUS_LABEL[status] ?? String(status ?? 'open')
}

const ts = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:d>`

/**
 * Status and assignee changes only, oldest first, at most `limit`. Every other
 * field — estimate above all — is skipped, whatever the row carries.
 */
export function timelineLines(rows, { nameFor = () => null, limit = 15 } = {}) {
  const name = (id) => nameFor(id) || `<@${id}>`
  const out = []
  const ordered = [...(rows ?? [])].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  for (const row of ordered) {
    const changes = Array.isArray(row?.changes) ? row.changes : safeParse(row?.changes)
    const who = row?.actorLabel || (row?.actorDiscordId ? nameFor(row.actorDiscordId) : null)
    for (const c of changes) {
      if (c?.field === 'status') {
        out.push(`${ts(row.createdAt)} — status: ${requestStatusLabel(c.from)} → ${requestStatusLabel(c.to)}${who ? ` (${who})` : ''}`)
      } else if (c?.field === 'assignees') {
        const added = (c.added ?? []).map(name)
        const removed = (c.removed ?? []).map(name)
        if (added.length) out.push(`${ts(row.createdAt)} — assigned to ${added.join(', ')}`)
        if (removed.length) out.push(`${ts(row.createdAt)} — no longer with ${removed.join(', ')}`)
      }
    }
  }
  return out.slice(-limit)
}

function safeParse(raw) {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
}

/**
 * One line per request. With `me`, a request someone else raised names them —
 * a client manager's list mixes their own and their team's.
 */
export function myRequestsLines(tasks, { me = null, nameFor = () => null } = {}) {
  return (tasks ?? []).map((t) => {
    const icon = t.type === 'bug' ? '🐞' : '✨'
    const parts = [`${icon} **${t.title}**`]
    if (me && t.requestedBy && String(t.requestedBy) !== String(me)) parts.push(`raised by ${nameFor(t.requestedBy) || `<@${t.requestedBy}>`}`)
    parts.push(t.projectName || 'no project', t.status === 'pending' ? `**${requestStatusLabel(t.status)}**` : requestStatusLabel(t.status))
    if (t.discordChannelId) parts.push(`<#${t.discordChannelId}>`)
    return parts.join(' · ')
  })
}
