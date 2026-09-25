import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits as F, PermissionsBitField } from 'discord.js'
import { TEXT_ALLOW, TEXT_ALLOW_OBJ, TEXT_BITS, VOICE_EXTRA, lacksTextAllow, missingTextBits, viewerTextGaps, textFlagsOf } from './textAllow.js'

const OLD_THREE = F.ViewChannel | F.SendMessages | F.ReadMessageHistory
const SIX = OLD_THREE | F.AttachFiles | F.EmbedLinks | F.AddReactions

test('the text allow is the old three plus attachments, embeds and reactions', () => {
  assert.deepEqual(TEXT_ALLOW, [F.ViewChannel, F.SendMessages, F.ReadMessageHistory, F.AttachFiles, F.EmbedLinks, F.AddReactions])
  assert.equal(TEXT_BITS, SIX)
})

test('the object form names the same six flags, each true', () => {
  assert.deepEqual(TEXT_ALLOW_OBJ, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true, AddReactions: true,
  })
  const fromObj = Object.keys(TEXT_ALLOW_OBJ).reduce((a, k) => a | F[k], 0n)
  assert.equal(fromObj, TEXT_BITS)
})

test('the voice extras are the four bits a voice channel adds', () => {
  assert.deepEqual(VOICE_EXTRA, [F.Connect, F.Speak, F.UseVAD, F.Stream])
})

test('lacksTextAllow reads a bigint', () => {
  assert.equal(lacksTextAllow(OLD_THREE), true)
  assert.equal(lacksTextAllow(SIX), false)
  assert.equal(lacksTextAllow(SIX | F.Connect), false)
})

test('lacksTextAllow reads a PermissionsBitField, a number and a string', () => {
  assert.equal(lacksTextAllow(new PermissionsBitField(OLD_THREE)), true)
  assert.equal(lacksTextAllow(new PermissionsBitField(SIX)), false)
  assert.equal(lacksTextAllow(Number(OLD_THREE)), true)
  assert.equal(lacksTextAllow(String(SIX)), false)
  assert.equal(lacksTextAllow(String(OLD_THREE)), true)
})

test('an unreadable allow is never "incomplete"', () => {
  assert.equal(lacksTextAllow(null), false)
  assert.equal(lacksTextAllow(undefined), false)
  assert.equal(lacksTextAllow('not a number'), false)
  assert.equal(lacksTextAllow({}), false)
})

test('a bit the overwrite DENIES is not missing: a locked ticket is never re-opened', () => {
  // lockTicketChannel moves SendMessages from allow to deny. Counting it as
  // missing would OR it back into the allow, and allow beats deny in Discord's
  // overwrite resolution: the finished ticket would take messages again.
  const lockedAllow = SIX & ~F.SendMessages
  assert.equal(lacksTextAllow(lockedAllow, F.SendMessages), false)
  assert.equal(missingTextBits(lockedAllow, F.SendMessages), 0n)
  // The old three, locked: only the three new bits are missing.
  const oldLocked = OLD_THREE & ~F.SendMessages
  assert.equal(missingTextBits(oldLocked, F.SendMessages), F.AttachFiles | F.EmbedLinks | F.AddReactions)
  assert.equal(lacksTextAllow(oldLocked, new PermissionsBitField(F.SendMessages)), true)
})

test('missingTextBits is 0n when the allow or a present deny cannot be read', () => {
  assert.equal(missingTextBits(null), 0n)
  assert.equal(missingTextBits(OLD_THREE, 'garbage'), 0n)
  // An absent deny is "nothing denied", not unreadable.
  assert.equal(missingTextBits(OLD_THREE, undefined), F.AttachFiles | F.EmbedLinks | F.AddReactions)
})

test('viewerTextGaps: only an overwrite that allows ViewChannel is ever short', () => {
  assert.equal(viewerTextGaps({ allow: OLD_THREE, deny: 0n }), F.AttachFiles | F.EmbedLinks | F.AddReactions)
  assert.equal(viewerTextGaps({ allow: 0n, deny: F.ViewChannel }), 0n)
  assert.equal(viewerTextGaps({ allow: F.SendMessages, deny: 0n }), 0n)
  assert.equal(viewerTextGaps({ allow: SIX, deny: 0n }), 0n)
  assert.equal(viewerTextGaps(null), 0n)
  assert.equal(viewerTextGaps({ id: 'x' }), 0n)
})

test('textFlagsOf names exactly the text bits it is given', () => {
  assert.deepEqual(textFlagsOf(F.AttachFiles | F.AddReactions), { AttachFiles: true, AddReactions: true })
  assert.deepEqual(textFlagsOf(0n), {})
})
