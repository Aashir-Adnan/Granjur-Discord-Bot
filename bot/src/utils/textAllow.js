// The one text allow every channel the bot creates or repairs grants, and the
// test a repair uses to decide an existing overwrite is short of it.
//
// A leaf: `services/taskTicketChannel.js`, `services/clientAccess.js`, the
// section planner and the ticket commands all import it, and none of them may
// drag another module's database import in through here.
//
// Why six bits and not three: the bot used to grant only ViewChannel,
// SendMessages and ReadMessageHistory, so whether anyone could attach a
// document, have a link unfurl or add a reaction depended on the server's
// @everyone defaults. Clients attach documents to their request channels.
import { PermissionFlagsBits as F } from 'discord.js'

export const TEXT_ALLOW = [F.ViewChannel, F.SendMessages, F.ReadMessageHistory, F.AttachFiles, F.EmbedLinks, F.AddReactions]

/** The same set as the `{ Flag: true }` object `permissionOverwrites.edit` takes. */
export const TEXT_ALLOW_OBJ = {
  ViewChannel: true,
  SendMessages: true,
  ReadMessageHistory: true,
  AttachFiles: true,
  EmbedLinks: true,
  AddReactions: true,
}

/** What a voice channel adds on top of the text set (a voice channel has a text chat too). */
export const VOICE_EXTRA = [F.Connect, F.Speak, F.UseVAD, F.Stream]

/** `TEXT_ALLOW` as one bitfield. */
export const TEXT_BITS = TEXT_ALLOW.reduce((a, b) => a | b, 0n)

/**
 * A permission bitfield as a BigInt: a BigInt, a discord.js
 * `PermissionsBitField`, a number or a decimal string. Null when it cannot be
 * read — "no permissions" and "could not tell" are different answers.
 */
export function bitsOf(permissions) {
  if (permissions === null || permissions === undefined) return null
  try {
    if (typeof permissions === 'bigint') return permissions
    if (typeof permissions === 'number') return BigInt(permissions)
    if (typeof permissions === 'string') return BigInt(permissions)
    const raw = permissions.bitfield ?? permissions.valueOf?.()
    if (raw === null || raw === undefined || typeof raw === 'object') return null
    return BigInt(raw)
  } catch {
    return null
  }
}

/**
 * The `TEXT_ALLOW` bits an overwrite neither allows nor denies — what a repair
 * may OR into its allow. A bit the overwrite DENIES is somebody's decision and
 * is never counted: `lockTicketChannel` moves `SendMessages` from allow to deny
 * on a finished ticket, and allow beats deny inside one overwrite, so OR-ing
 * it back would re-open every locked ticket. An absent `deny` is "nothing
 * denied"; an allow, or a present deny, that cannot be read is 0n — never
 * guessed at.
 */
export function missingTextBits(allow, deny = null) {
  const a = bitsOf(allow)
  if (a === null) return 0n
  const d = deny === null || deny === undefined ? 0n : bitsOf(deny)
  if (d === null) return 0n
  return TEXT_BITS & ~a & ~d
}

/** True when `allow` can be read and lacks a `TEXT_ALLOW` bit `deny` does not deny. Unreadable → false. */
export function lacksTextAllow(allow, deny = null) {
  return missingTextBits(allow, deny) !== 0n
}

/**
 * The text bits a repair may add to an existing overwrite: `missingTextBits`,
 * but only for an overwrite that ALLOWS ViewChannel. An entry that only
 * denies (somebody shut out of a channel, a role kept off it) is a human's
 * decision and gets nothing — adding allow bits to it would be a permission
 * change nobody asked for. 0n when absent or unreadable.
 */
export function viewerTextGaps(overwrite) {
  if (!overwrite) return 0n
  const allow = bitsOf(overwrite.allow)
  if (allow === null || (allow & F.ViewChannel) === 0n) return 0n
  return missingTextBits(allow, overwrite.deny)
}

/** The `TEXT_ALLOW` bits set in `bits`, as the `{ Flag: true }` object `permissionOverwrites.edit` takes. */
export function textFlagsOf(bits) {
  return Object.fromEntries(Object.keys(TEXT_ALLOW_OBJ).filter((k) => (bits & F[k]) !== 0n).map((k) => [k, true]))
}
