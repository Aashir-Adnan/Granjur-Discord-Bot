import db, { getOrCreateGuildConfig } from '../db/index.js'
import { getInviteUses, updateInviteUses } from './inviteUsesCache.js'

export async function handleMemberAdd(member) {
  const guild = member.guild
  const config = await getOrCreateGuildConfig(guild.id)
  let email = null

  try {
    const invites = await guild.invites.fetch()
    const pending = await db.pendingInvite.findByGuild(config.id)
    for (const row of pending) {
      const inv = invites.get(row.inviteCode)
      const prevUses = getInviteUses(guild.id, row.inviteCode)
      if (inv && inv.uses > prevUses) {
        email = row.email
        await db.pendingInvite.deleteByCode(config.id, row.inviteCode)
        updateInviteUses(guild.id, row.inviteCode, inv.uses)
        break
      }
    }
    for (const inv of invites.values()) {
      updateInviteUses(guild.id, inv.code, inv.uses)
    }
    if (pending.length > 0 && !email) {
      const codes = [...new Set(pending.map((r) => r.inviteCode))]
      const found = codes.filter((c) => invites.has(c)).length
      if (found === 0) {
        console.warn('[memberAdd] Pending invites exist but none found in guild list. Ensure the bot has **Manage Server** so it can list invites.')
      }
    }
  } catch (e) {
    // Listing invites requires "Manage Server". If this throws, we can't match invite → email.
    console.error('[memberAdd] Could not fetch invites (bot may need Manage Server):', e?.message ?? e)
  }

  if (config?.holdingRoleId) {
    try {
      await member.roles.add(config.holdingRoleId)
    } catch (_) {}
  }

  await db.guildMember.upsert({
    where: {
      guildId_discordId: { guildId: guild.id, discordId: member.id },
    },
    create: {
      guildId: guild.id,
      discordId: member.id,
      email: email ?? undefined,
      status: 'pending',
    },
    update: email ? { email } : {},
  })

  const ch = await guild.channels.fetch(config.onboardingChannelId).catch(() => null)
  if (ch?.isTextBased()) {
    const verifySteps = email
      ? "Run **/verify** and we'll send a **6-digit code** to your email. Enter the code in Discord to complete verification."
      : "Run **/verify** to get a code sent to your email. Your nickname will be set and you'll be in **Holding** until a CEO or Server Manager approves you."
    await ch.send({
      content: `Welcome **${member.user.tag}**. To get access: ${verifySteps}`,
    }).catch(() => {})
  }
}
