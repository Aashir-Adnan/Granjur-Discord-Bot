// The pinned "who is on this project" panel in a project's #<slug>-members
// channel, plus the one-line join/leave posts. Modelled on
// `bot/src/config/meetingGuidelines.js` (marker string, build…Embed,
// find…Pin, ensure…), except this one also EDITS an existing pin in place
// rather than only posting once.
//
// This module never queries the database: the caller passes `members`
// (rows of `{ discordId, role }`) and a `nameFor(discordId)` function.

import { EmbedBuilder } from 'discord.js'
import { PROJECT_MEMBER_ROLES } from '../db/index.js'

// The footer is `${PANEL_MARKER} · <project name>`, so it also keys the
// panel to ONE project — two projects' panels never match each other, and
// changing this string orphans every existing pin. Don't.
export const PANEL_MARKER = 'Project members'

// Readable labels for PROJECT_MEMBER_ROLES. `bot/src/commands/project-members.js`
// has its own copy of this map (ROLE_LABEL) — this module must not import
// from a command, so the duplication is deliberate for now. A later task may
// pull both into a shared spot.
const ROLE_LABEL = {
  lead: 'Lead',
  developer: 'Developer',
  backend_developer: 'Backend Developer',
  frontend_developer: 'Frontend Developer',
  qa: 'QA',
  design: 'Design',
  client: 'Client',
}

const FIELD_VALUE_LIMIT = 1024

function footerFor(project) {
  return `${PANEL_MARKER} · ${project.name}`
}

/** Build the members panel embed. Pure. */
export function buildMembersEmbed(project, members, nameFor) {
  const embed = new EmbedBuilder()
    .setTitle(`Members — ${project.name}`)
    .setColor(0x5865f2)
    .setFooter({ text: footerFor(project) })

  if (!members || members.length === 0) {
    embed.setDescription('No members yet. Add one with /project-members add.')
    return embed
  }

  for (const role of PROJECT_MEMBER_ROLES) {
    const names = members.filter((m) => m.role === role).map((m) => nameFor(m.discordId))
    if (names.length === 0) continue
    let value = names.join(', ')
    if (value.length > FIELD_VALUE_LIMIT) value = `${value.slice(0, FIELD_VALUE_LIMIT - 1)}…`
    embed.addFields({ name: ROLE_LABEL[role] || role, value })
  }

  return embed
}

/** Find the bot's own panel pin for this project, by marker footer. */
export function findPanelPin(messages, botUserId, project) {
  const marker = footerFor(project)
  for (const m of messages || []) {
    if (m?.author?.id !== botUserId) continue
    const hit = (m.embeds || []).some((e) => e?.footer?.text === marker)
    if (hit) return m
  }
  return null
}

/**
 * Post the members panel, or edit it in place if it is already pinned here.
 * Never throws: a missing permission must not fail the command that
 * triggered this.
 *
 * @returns {Promise<'edited'|'posted'|false>}
 */
export async function ensureMembersPanel(channel, project, members, { botUserId, nameFor }) {
  try {
    const pinned = await channel.messages.fetchPinned()
    const list = pinned?.values ? [...pinned.values()] : pinned
    const embed = buildMembersEmbed(project, members, nameFor)
    const existing = findPanelPin(list, botUserId, project)
    if (existing) {
      await existing.edit({ embeds: [embed] })
      return 'edited'
    }
    const msg = await channel.send({ embeds: [embed] })
    await msg.pin()
    return 'posted'
  } catch (e) {
    console.warn(`[projectSection] members panel: ${e?.message || e}`)
    return false
  }
}

/**
 * Post a one-line "so-and-so joined/left" notice. Never throws.
 */
export async function postMembershipChange(channel, { name, role, action }) {
  const content =
    action === 'added'
      ? `**${name}** joined the project as ${ROLE_LABEL[role] || role}`
      : `**${name}** left the project`
  try {
    await channel.send({ content, allowedMentions: { parse: [] } })
    return true
  } catch (e) {
    console.warn(`[projectSection] members panel: ${e?.message || e}`)
    return false
  }
}
