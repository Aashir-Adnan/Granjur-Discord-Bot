// The global categories /init builds and /cleanup leaves alone (roadmap
// sub-project 3, 2026-09-29; spec docs/superpowers/specs/2026-09-29-global-
// channel-layout-design.md). One list for both, so they cannot drift apart
// again. Support is not here: ensureSupportChannels owns it, and /cleanup
// protects it by id and name.

import { ChannelType } from 'discord.js'
import {
  CATEGORY_ONBOARDING, CHANNEL_ONBOARDING,
  CATEGORY_ANNOUNCEMENTS, CHANNEL_ANNOUNCEMENTS_ALL, CHANNEL_ANNOUNCEMENTS_VERIFIED,
  CHANNEL_ANNOUNCEMENTS_LEADERSHIP, CHANNEL_ADMIN,
  CATEGORY_CASUAL, CHANNEL_CASUAL_CHAT, CHANNEL_OFF_TOPIC, CHANNEL_VOICE_LOUNGE,
  CATEGORY_DOCUMENTATION, CHANNEL_DOCUMENTATION,
  CATEGORY_FEEDBACK, CHANNEL_FEEDBACK,
  CATEGORY_MEETINGS, CHANNEL_MEETINGS_TEXT, CHANNEL_MEETINGS_VOICE, CHANNEL_UPCOMING_MEETINGS,
  CATEGORY_SUPPORT, CATEGORY_BOLD_NAMES, CHANNEL_BARE_TEXT, CHANNEL_BARE_VOICE,
} from '../constants.js'

export const FEEDBACK_TOPIC = 'What should we improve? Type here, or use /feedback from any channel.'

const text = (name, topic) => (topic ? { name, type: ChannelType.GuildText, topic } : { name, type: ChannelType.GuildText })
const voice = (name) => ({ name, type: ChannelType.GuildVoice })

export const GLOBAL_LAYOUT = Object.freeze([
  { category: CATEGORY_ONBOARDING, channels: [text(CHANNEL_ONBOARDING, 'Run /verify to get a code by email (OTP). Then wait for CEO/Server Manager to approve.')] },
  {
    category: CATEGORY_ANNOUNCEMENTS,
    channels: [
      text(CHANNEL_ANNOUNCEMENTS_ALL, 'Announcements for everyone'),
      text(CHANNEL_ANNOUNCEMENTS_VERIFIED, 'Announcements for verified members'),
      text(CHANNEL_ANNOUNCEMENTS_LEADERSHIP, 'Announcements for leadership'),
      text(CHANNEL_ADMIN, 'Backlog notifications — server owner & CEOs tagged when someone enters holding'),
    ],
  },
  { category: CATEGORY_CASUAL, channels: [text(CHANNEL_CASUAL_CHAT), text(CHANNEL_OFF_TOPIC), voice(CHANNEL_VOICE_LOUNGE)] },
  { category: CATEGORY_DOCUMENTATION, channels: [text(CHANNEL_DOCUMENTATION, 'Browse project documentation — select a project below')] },
  { category: CATEGORY_FEEDBACK, channels: [text(CHANNEL_FEEDBACK, FEEDBACK_TOPIC)] },
  {
    category: CATEGORY_MEETINGS,
    channels: [
      text(CHANNEL_MEETINGS_TEXT, 'General meetings and sync'),
      voice(CHANNEL_MEETINGS_VOICE),
      text(CHANNEL_UPCOMING_MEETINGS, 'Reminders 10 min before meetings — tagged here'),
    ],
  },
])

// The no-project ticket categories (feature/bug tickets live here). Not part of
// the layout — tickets create them on demand — but never ours to trim.
export const GLOBAL_TICKET_CATEGORIES = Object.freeze(['Features', 'Bugs'])

/** Category names /cleanup must leave alone, lowercased: layout, /migrate bold names, ticket categories, Support. */
export function protectedCategoryNames() {
  const names = [...GLOBAL_LAYOUT.map((e) => e.category), ...GLOBAL_TICKET_CATEGORIES, CATEGORY_SUPPORT]
  const withBold = names.flatMap((n) => [n, CATEGORY_BOLD_NAMES[n]].filter(Boolean))
  return new Set(withBold.map((n) => n.toLowerCase()))
}

/** Channel names /cleanup must leave alone inside a protected category, lowercased. */
export function protectedChannelNames() {
  const names = [...GLOBAL_LAYOUT.flatMap((e) => e.channels.map((c) => c.name)), CHANNEL_BARE_TEXT, CHANNEL_BARE_VOICE]
  return new Set(names.map((n) => n.toLowerCase()))
}
