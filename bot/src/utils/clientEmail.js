// The two ways an email outside the allowed domains gets through /verify:
// the caller's own row already says client (the join matched the invite), or
// an unclaimed client invite names the email (the join did not match — the
// bot lacked Manage Server). Claiming the second is the caller's job; this
// only says which it was.
export async function clientEmailAccess({ db, cfg, guildId, discordId, email }) {
  const e = String(email ?? '').trim().toLowerCase()
  if (!e || !cfg?.id) return { allowed: false, claim: null }
  const me = await db.guildMember.findUnique({ where: { guildId_discordId: { guildId, discordId } } }).catch(() => null)
  if (me?.kind === 'client' && String(me.email ?? '').trim().toLowerCase() === e) return { allowed: true, claim: null }
  const rows = await db.pendingInvite.findByEmail(cfg.id, e).catch(() => [])
  const claim = (rows ?? []).find((r) => r?.kind === 'client') ?? null
  return claim ? { allowed: true, claim } : { allowed: false, claim: null }
}
