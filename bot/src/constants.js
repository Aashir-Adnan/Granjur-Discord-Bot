import { MessageFlags } from 'discord.js'

/** Use for reply/deferReply: flags: EPHEMERAL or { flags: MessageFlags.Ephemeral } */
export const EPHEMERAL = MessageFlags.Ephemeral

// Role names created by /init (hierarchy + discipline + repo)
export const HIERARCHY_ROLES = [
  'Intern',
  'Temp',
  'Junior Dev',
  'Senior Dev',
  'Associate Engineer',
  'Quality Assurance',
  'Project Manager',
  'Server Manager',
  'CEO',
]

export const DISCIPLINE_ROLES = [
  'Frontend',
  'UI/UX',
  'Designer',
  'Server',
  'Full-Stack',
  'Database',
]

export const DEFAULT_REPO_ROLE_PREFIX = 'Repo'

export const CATEGORY_ONBOARDING = '📥 Onboarding'
export const CHANNEL_ONBOARDING = 'welcome-and-verify'
export const ROLE_HOLDING = 'Holding'
export const ROLE_VERIFIED = 'Verified'

/** Colors for roles created by /init (Discord hex 0xRRGGBB) */
export const ROLE_COLORS = {
  [ROLE_HOLDING]: 0x808080,   // gray
  [ROLE_VERIFIED]: 0x57f287,  // green
  // Hierarchy
  'Intern': 0x9ae6b0,
  'Temp': 0xfbd38d,
  'Junior Dev': 0x63b3ed,
  'Senior Dev': 0xed8936,
  'Associate Engineer': 0x38b2ac,
  'Quality Assurance': 0xb794f4,
  'Project Manager': 0xed64a6,
  'Server Manager': 0xfc8181,
  'CEO': 0xecc94b,
  // Discipline
  'Frontend': 0x4299e1,
  'UI/UX': 0xd53f8c,
  'Designer': 0x805ad5,
  'Server': 0xe53e3e,
  'Full-Stack': 0x319795,
  'Database': 0xdd6b20,
}

/** Bare-bones channel names after /scrap (one text, one voice) */
export const CHANNEL_BARE_TEXT = 'general'
export const CHANNEL_BARE_VOICE = 'voice'

/** Categories and channels created by /init (with emojis) */
export const CATEGORY_RULES = '📜 Rules'
export const CHANNEL_RULES = 'rules'
export const CATEGORY_DOCUMENTATION = '📚 Documentation'
export const CHANNEL_DOCUMENTATION = 'documentation'

export const CATEGORY_MEETINGS = '📋 Meetings'
export const CHANNEL_MEETINGS_TEXT = 'general-meetings'
export const CHANNEL_MEETINGS_VOICE = 'meeting-voice'
export const CHANNEL_UPCOMING_MEETINGS = 'upcoming-meetings'

export const CATEGORY_CASUAL = '💬 Casual'
export const CHANNEL_CASUAL_CHAT = 'casual-chat'
export const CHANNEL_OFF_TOPIC = 'off-topic'
export const CHANNEL_VOICE_LOUNGE = 'voice-lounge'

export const CATEGORY_PET_PICS = '🐾 Pet Pictures'
export const CHANNEL_PET_PICS = 'pet-pics'

export const CATEGORY_FOODIE = '🍴 Foodie'
export const CHANNEL_FOODIE_BLOG = 'foodie-blog'

export const CATEGORY_ARCHIVE = '📁 Archive'
export const CHANNEL_ARCHIVE_METADATA = 'meeting-metadata'
export const CHANNEL_ARCHIVE_SQL = 'sql-dumps'

/** Announcements category — channels for different tiers + admin (backlog pings) */
export const CATEGORY_ANNOUNCEMENTS = '📢 Announcements'
export const CHANNEL_ANNOUNCEMENTS_ALL = 'announcements-all'
export const CHANNEL_ANNOUNCEMENTS_VERIFIED = 'announcements-verified'
export const CHANNEL_ANNOUNCEMENTS_LEADERSHIP = 'announcements-leadership'
export const CHANNEL_ADMIN = 'admin'

/** Role-exclusive categories (DISCIPLINE_ROLES) */
export const CATEGORY_FRONTEND = '⚛️ Frontend'
export const CHANNEL_FRONTEND_CHAT = 'frontend-chat'
export const CHANNEL_FRONTEND_VOICE = 'frontend-voice'

export const CATEGORY_BACKEND = '🔧 Backend'
export const CHANNEL_BACKEND_CHAT = 'backend-chat'
export const CHANNEL_BACKEND_VOICE = 'backend-voice'

export const CATEGORY_DATABASE = '🗄️ Database'
export const CHANNEL_DATABASE_CHAT = 'database-chat'
export const CHANNEL_DATABASE_VOICE = 'database-voice'

/** One category for all command-dedicated channels (from command-config.json) */
export const CATEGORY_COMMAND_CHANNELS = '📌 Command channels'

/** Project categories (from ubs_doc / seed) */
export const INIT_PROJECT_NAMES = ['Fittour', 'Edarete', 'Framework']

export const BUG_STATUSES = ['pending', 'resolved', 'abandoned']
export const FEATURE_STATUSES = ['open', 'in_progress', 'done']

/** Granjur invite: only @granjur.com */
export const INVITE_ALLOWED_DOMAIN = 'granjur.com'

/** Role assigned when user clocks in; "members online" (right sidebar) shows only these when used */
export const ROLE_CLOCKED_IN = 'Clocked In'

/** Separator roles (non-mentionable, display only) to separate role groups in member list */
export const ROLE_SEPARATOR_NAME = '-------------'

/** Bold category names applied by /migrate (map original name or partial match → new bold name) */
export const CATEGORY_BOLD_NAMES = {
  'Meetings': '<==== 📋 MEETINGS 📋 ====>',
  '📋 Meetings': '<==== 📋 MEETINGS 📋 ====>',
  'Features': '<==== ✨ FEATURES ✨ ====>',
  'Bugs': '<==== 🐛 BUGS 🐛 ====>',
  '📥 Onboarding': '<==== 📥 ONBOARDING 📥 ====>',
  '📜 Rules': '<==== 📜 RULES 📜 ====>',
  '📚 Documentation': '<==== 📚 DOCUMENTATION 📚 ====>',
  '💬 Casual': '<==== 💬 CASUAL 💬 ====>',
  '🐾 Pet Pictures': '<==== 🐾 PET PICTURES 🐾 ====>',
  '🍴 Foodie': '<==== 🍴 FOODIE 🍴 ====>',
  '📁 Archive': '<==== 📁 ARCHIVE 📁 ====>',
  '📢 Announcements': '<==== 📢 ANNOUNCEMENTS 📢 ====>',
  '⚛️ Frontend': '<==== ⚛️ FRONTEND ⚛️ ====>',
  '🔧 Backend': '<==== 🔧 BACKEND 🔧 ====>',
  '🗄️ Database': '<==== 🗄️ DATABASE 🗄️ ====>',
  '📌 Command channels': '<==== 📌 COMMAND CHANNELS 📌 ====>',
}
