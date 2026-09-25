import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FINISHED_STATUSES,
  isFinished,
  ARCHIVE_DIVIDER_NAME,
  ARCHIVE_DIVIDER_TOPIC,
  ARCHIVE_STORE_KEY,
  archiveDividerIdOf,
} from './ticketArchive.js'
import { isTicketChannel } from './taskChannelName.js'
import { ChannelType } from 'discord.js'

test('a finished status is one of the four; anything else, including null, is live', () => {
  assert.deepEqual(FINISHED_STATUSES, ['done', 'resolved', 'closed', 'abandoned'])
  for (const s of FINISHED_STATUSES) assert.equal(isFinished(s), true)
  for (const s of ['open', 'pending', 'in_progress']) assert.equal(isFinished(s), false)
  // Case and whitespace do not matter: a status typed by hand on the site still files.
  assert.equal(isFinished(' Done '), true)
  assert.equal(isFinished('RESOLVED'), true)
  assert.equal(isFinished(null), false)
  assert.equal(isFinished(undefined), false)
  assert.equal(isFinished(''), false)
  assert.equal(isFinished('whatever'), false)
})

test('the divider name is four box-drawing dashes each side of "archive", with no spaces', () => {
  assert.equal(ARCHIVE_DIVIDER_NAME, `${'─'.repeat(4)}archive${'─'.repeat(4)}`)
  assert.ok(!/\s/.test(ARCHIVE_DIVIDER_NAME))
  assert.equal(ARCHIVE_STORE_KEY, 'archiveDivider')
  assert.match(ARCHIVE_DIVIDER_TOPIC, /^Finished tickets sit below this line/)
})

test('the divider is never mistaken for a ticket channel', () => {
  // `isTicketChannel` is what every consumer uses to decide "does a task own
  // this channel". The divider must fail it on BOTH halves: its topic is not a
  // ticket signature, and its name carries no ticket prefix.
  const divider = { type: ChannelType.GuildText, name: ARCHIVE_DIVIDER_NAME, topic: ARCHIVE_DIVIDER_TOPIC }
  assert.equal(isTicketChannel(divider), false)
  assert.equal(isTicketChannel({ ...divider, topic: null }), false)
})

test('archiveDividerIdOf reads the stored map — object or JSON string — else null', () => {
  assert.equal(archiveDividerIdOf({ discordChannels: { archiveDivider: 'd1', members: 'm1' } }), 'd1')
  assert.equal(archiveDividerIdOf({ discordChannels: JSON.stringify({ archiveDivider: 'd2' }) }), 'd2')
  assert.equal(archiveDividerIdOf({ discordChannels: '{not json' }), null)
  assert.equal(archiveDividerIdOf({ discordChannels: { members: 'm1' } }), null)
  assert.equal(archiveDividerIdOf({}), null)
  assert.equal(archiveDividerIdOf(null), null)
})
