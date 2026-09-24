// The vocabulary behind the archive divider: which statuses count as finished,
// what the divider channel is called, and where its id is kept.
//
// A leaf, like `statusBuckets.js` before it: imported by
// `services/taskTicketChannel.js`, which must never reach the section planner
// (`projectSection.js` → `projectMembersPanel.js` → `db/index.js` → the
// production `.env`, dragged into a module whose tests touch no database).
import { storedChannels } from './projectStore.js'

/**
 * The statuses that put a ticket BELOW the line. Everything else — open,
 * pending, in_progress, an unknown status, no status at all — is live.
 */
export const FINISHED_STATUSES = ['done', 'resolved', 'closed', 'abandoned']

const FINISHED = new Set(FINISHED_STATUSES)

/** Case- and whitespace-insensitive; null, empty and unknown are all live. Never throws. */
export function isFinished(status) {
  return FINISHED.has(String(status ?? '').trim().toLowerCase())
}

/**
 * The divider channel's name: four U+2500 BOX DRAWINGS LIGHT HORIZONTAL, the
 * word `archive`, four more. No spaces — Discord turns a space in a channel
 * name into a hyphen, which would leave the line broken by dashes.
 */
export const ARCHIVE_DIVIDER_NAME = '────archive────'

/**
 * The divider's topic. Deliberately NOT a `Feature:`/`Bug:`/`Task:` sentence:
 * `isTicketChannel` reads the topic first, and a divider that looked like a
 * ticket would be renamed into a task's channel by `/project-setup`, moved by
 * the mover, and deleted by the sweep.
 */
export const ARCHIVE_DIVIDER_TOPIC =
  'Finished tickets sit below this line, read-only, and are removed 14 days after finishing.'

/**
 * The key the divider's id lives under in the project's `discordChannels` JSON
 * map, beside the thirteen section channel ids. Reusing that map means
 * `claimedSectionIds` (cross-project adoption) and `/cleanup`'s protection set
 * cover the divider with no new code.
 */
export const ARCHIVE_STORE_KEY = 'archiveDivider'

/** The project's stored divider id, or null. */
export function archiveDividerIdOf(project) {
  return storedChannels(project)[ARCHIVE_STORE_KEY] || null
}
