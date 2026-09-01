import db from '../db/index.js'

// Pure: build the alias list used to match a person's name in transcripts.
// displayName (full) + each word longer than 1 char + discord username + email local-part.
// Deduped, no blanks.
export function aliasesFor(member, email) {
  const out = new Set()
  const dn = member?.displayName || member?.user?.globalName || member?.user?.username || ''
  if (dn) {
    out.add(dn)
    for (const w of dn.split(/\s+/)) if (w.length > 1) out.add(w)
  }
  if (member?.user?.username) out.add(member.user.username)
  if (email && email.includes('@')) out.add(email.split('@')[0])
  return [...out].map((s) => (typeof s === 'string' ? s.trim() : s)).filter(Boolean)
}

// Verified members who were present in the meeting (have a MeetingRecording row),
// falling back to all verified members if none matched.
export async function buildRoster({ guild, guildConfigId, meetingId }) {
  const members = await db.guildMember.findMany({ where: { guildConfigId, status: 'verified' } })
  const recs = meetingId
    ? await db.meetingRecording.findMany({ where: { meetingId } })
    : []
  const present = new Set(recs.map((r) => r.memberId))

  const pick = present.size
    ? members.filter((m) => present.has(m.discordId))
    : members

  const roster = []
  for (const gm of pick) {
    let dm = null
    try {
      dm = await guild.members.fetch(gm.discordId)
    } catch {
      /* member may have left the guild */
    }
    roster.push({
      ref: gm.discordId,
      displayName: dm?.displayName || gm.email?.split('@')[0] || gm.discordId,
      aliases: aliasesFor(dm || {}, gm.email),
    })
  }
  return roster
}
