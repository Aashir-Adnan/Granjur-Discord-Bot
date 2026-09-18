import {
  SlashCommandBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'
import { MANAGED_ROLES, roleDiff, roleSelectOptions } from '../utils/roleSync.js'
import { EPHEMERAL } from '../constants.js'

export const data = new SlashCommandBuilder()
  .setName('set-roles')
  .setDescription('Change a member’s roles — works on anyone, not just people awaiting approval')
  .addUserOption((o) =>
    o.setName('member').setDescription('Skip the picker and go straight to this member').setRequired(false),
  )

/** Step 2: the role picker for one member, with their current roles ticked. */
async function rolePicker(guild, member) {
  const current = member.roles.cache.map((r) => r.name)
  const options = roleSelectOptions(current)

  const embed = new EmbedBuilder()
    .setTitle(`Roles for ${member.displayName}`)
    .setDescription(
      'Tick every role this member should have and untick the rest.\n\n' +
        'Only the roles listed here are touched — **Verified**, **Holding** and anything ' +
        'else they hold are left exactly as they are.',
    )
    .setColor(0x5865f2)

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`set_roles_apply:${member.id}`)
      .setPlaceholder('Choose roles')
      .setMinValues(0)
      .setMaxValues(MANAGED_ROLES.length)
      .addOptions(options),
  )

  return { embeds: [embed], components: [row] }
}

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  const picked = interaction.options.getUser('member')
  if (picked) {
    const member = await guild.members.fetch(picked.id).catch(() => null)
    if (!member) return interaction.editReply({ content: 'That user is not in this server.' })
    return interaction.editReply(await rolePicker(guild, member))
  }

  const row = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('set_roles_member')
      .setPlaceholder('Pick a member')
      .setMinValues(1)
      .setMaxValues(1),
  )

  const embed = new EmbedBuilder()
    .setTitle('Change a member’s roles')
    .setDescription('Pick the member whose roles you want to change.')
    .setColor(0x5865f2)

  await interaction.editReply({ embeds: [embed], components: [row] })
}

/** Step 1 -> 2: a member was chosen. */
export async function handleMemberSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const userId = interaction.values?.[0]
  const member = await guild.members.fetch(userId).catch(() => null)
  if (!member) {
    return interaction.update({ content: 'That user is not in this server.', embeds: [], components: [] }).catch(() => {})
  }
  const payload = await rolePicker(guild, member)
  await interaction.update({ ...payload, content: null }).catch(() => {})
}

/** Step 2 -> done: apply the difference. */
export async function handleApply(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const userId = interaction.customId.split(':')[1]
  const member = await guild.members.fetch(userId).catch(() => null)
  if (!member) {
    return interaction.update({ content: 'That user is not in this server.', embeds: [], components: [] }).catch(() => {})
  }

  const current = member.roles.cache.map((r) => r.name)
  const { add, remove } = roleDiff(current, interaction.values || [])

  if (add.length === 0 && remove.length === 0) {
    return interaction
      .update({ content: `No change — **${member.displayName}** already has exactly those roles.`, embeds: [], components: [] })
      .catch(() => {})
  }

  const byName = (name) => guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase())
  const added = []
  const removed = []
  const missing = []
  const failed = []

  for (const name of add) {
    const role = byName(name)
    if (!role) { missing.push(name); continue }
    try { await member.roles.add(role); added.push(name) } catch (e) { failed.push(`${name} (${e.message})`) }
  }
  for (const name of remove) {
    const role = byName(name)
    if (!role) continue // not a real role here, so nothing to take away
    try { await member.roles.remove(role); removed.push(name) } catch (e) { failed.push(`${name} (${e.message})`) }
  }

  // Keep the bot's own copy in step. Nothing gates on it, but /approve merges
  // against it, so letting it drift would resurrect roles removed here.
  try {
    const cfg = await getOrCreateGuildConfig(guild.id)
    const dbMember = await db.guildMember.findUnique({
      where: { guildId_discordId: { guildId: guild.id, discordId: member.id } },
    })
    if (cfg && dbMember) {
      const fresh = await guild.members.fetch(member.id).catch(() => member)
      await db.guildMember.update({
        where: { id: dbMember.id },
        data: { roleIds: fresh.roles.cache.map((r) => r.id) },
      })
    }
  } catch (e) {
    console.warn('[set-roles] could not update stored roleIds:', e?.message || e)
  }

  const lines = []
  if (added.length) lines.push(`**Added:** ${added.join(', ')}`)
  if (removed.length) lines.push(`**Removed:** ${removed.join(', ')}`)
  if (missing.length) lines.push(`**No such role in this server:** ${missing.join(', ')} — create the role first, then try again.`)
  if (failed.length) lines.push(`**Failed:** ${failed.join(', ')} — usually means the bot’s own role sits below that role in the list.`)

  const embed = new EmbedBuilder()
    .setTitle(`Roles updated — ${member.displayName}`)
    .setDescription(lines.join('\n'))
    .setColor(failed.length || missing.length ? 0xfaa61a : 0x57f287)

  await interaction.update({ embeds: [embed], components: [], content: null }).catch(() => {})
}

export { EPHEMERAL }
