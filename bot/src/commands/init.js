import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js'
import db, { getGuildConfig, getOrCreateGuildConfig, updateGuildConfig, ensureStringArray } from '../db/index.js'
import {
  HIERARCHY_ROLES,
  DISCIPLINE_ROLES,
  CATEGORY_ONBOARDING,
  CHANNEL_ONBOARDING,
  ROLE_HOLDING,
  ROLE_VERIFIED,
  ROLE_CLIENT,
  ROLE_COLORS,
  CHANNEL_DOCUMENTATION,
  CATEGORY_ANNOUNCEMENTS,
  CHANNEL_ANNOUNCEMENTS_ALL,
  CHANNEL_ANNOUNCEMENTS_VERIFIED,
  CHANNEL_ANNOUNCEMENTS_LEADERSHIP,
  CHANNEL_ADMIN,
  CHANNEL_FEEDBACK,
} from '../constants.js'
import { EPHEMERAL } from '../constants.js'
import { config } from '../config.js'
import { getChannelPinnedMessage } from '../config/commands.js'
import { ensureSupportChannels } from '../services/clientAccess.js'
import { GLOBAL_LAYOUT, createGlobalCategories } from '../services/globalLayout.js'

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}]`, ...args)
}

export const data = new SlashCommandBuilder()
  .setName('init')
  .setDescription('Set up Granjur roles, onboarding channel, and verification flow for this server')

export async function execute(interaction) {
  try {
    const guild = interaction.guild
    if (!guild) {
      return interaction.editReply({ content: 'This command can only be used in a server.' })
    }

    const existing = await getGuildConfig(guild.id)
    if (existing) {
      return interaction.editReply({
        content:
          'This server is already set up. Run **/scrap** first to reset the server to bare bones (one text and one voice channel), then run **/init** again.',
        components: [],
      })
    }

    const embed = new EmbedBuilder()
      .setTitle('Server setup')
      .setDescription(
        'This will create:\n' +
          '• **Onboarding**, **Announcements** (all, verified, leadership + **admin** for backlog pings), **Casual**, **Documentation** (in-chat doc traversal), **Feedback**, **Meetings**, **Support**\n' +
          '• **Holding** and **Verified** roles + hierarchy & discipline roles\n\n' +
          'New members see onboarding until they verify via **/verify** (OTP). When someone enters holding, server owner and CEOs are tagged in **admin**.'
      )
      .setColor(0x5865f2)
      .setFooter({ text: 'Step 1 of 2 — Confirm to continue' })

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('init_confirm').setLabel('Confirm setup').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('init_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    )

    await interaction.editReply({ embeds: [embed], components: [row] })
  } catch (e) {
    const msg = e?.message ?? String(e)
    debug('init execute error', msg)
    await interaction.editReply({ content: `Setup step failed: ${msg}` }).catch(() => {})
  }
}

function wrapStep(stepName, fn) {
  return async (...args) => {
    try {
      return await fn(...args)
    } catch (e) {
      const msg = e?.message ?? String(e)
      throw new Error(`${stepName}: ${msg}`)
    }
  }
}

export async function runInit(guild) {
  const t0 = Date.now()
  debug('runInit: create category')
  const category = await wrapStep('Creating category', () =>
    guild.channels.create({
      name: CATEGORY_ONBOARDING,
      type: ChannelType.GuildCategory,
      position: 0,
      permissionOverwrites: [{ id: guild.id, type: 0, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }],
    })
  )()

  debug('runInit: create channel', Date.now() - t0, 'ms')
  const onboardingChannel = await wrapStep('Creating onboarding channel', () =>
    guild.channels.create({
      name: CHANNEL_ONBOARDING,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: 'Run /verify to get a code by email (OTP). Then wait for CEO/Server Manager to approve.',
    })
  )()

  debug('runInit: create holding/verified roles', Date.now() - t0, 'ms')
  const holdingRole = await wrapStep('Creating Holding role', () =>
    guild.roles.create({ name: ROLE_HOLDING, color: ROLE_COLORS[ROLE_HOLDING] ?? 0x808080, reason: 'Granjur init' })
  )()
  const verifiedRole = await wrapStep('Creating Verified role', () =>
    guild.roles.create({ name: ROLE_VERIFIED, color: ROLE_COLORS[ROLE_VERIFIED] ?? 0x57f287, reason: 'Granjur init' })
  )()
  const clientRole = await wrapStep('Creating Client role', () =>
    guild.roles.create({ name: ROLE_CLIENT, color: ROLE_COLORS[ROLE_CLIENT] ?? 0x00b0f4, reason: 'Granjur init' })
  )()

  debug('runInit: hierarchy/discipline roles', Date.now() - t0, 'ms')
  await wrapStep('Creating hierarchy roles', async () => {
    for (const name of HIERARCHY_ROLES) {
      await guild.roles.create({ name, color: ROLE_COLORS[name] ?? 0x99aab5, reason: 'Granjur init' })
    }
  })()
  await wrapStep('Creating discipline roles', async () => {
    for (const name of DISCIPLINE_ROLES) {
      await guild.roles.create({ name, color: ROLE_COLORS[name] ?? 0x99aab5, reason: 'Granjur init' })
    }
  })()

  debug('runInit: global categories', Date.now() - t0, 'ms')
  // Everything after Onboarding, from the one layout /cleanup also reads.
  const made = await wrapStep('Creating global categories', () =>
    createGlobalCategories(guild, GLOBAL_LAYOUT.filter((e) => e.category !== CATEGORY_ONBOARDING))
  )()
  const documentationChannel = made.get(CHANNEL_DOCUMENTATION) ?? null
  const feedbackChannel = made.get(CHANNEL_FEEDBACK) ?? null

  const everyoneId = guild.id
  debug('runInit: fetch channels and set permissions', Date.now() - t0, 'ms')
  const channels = await guild.channels.fetch()
  const onboardingIds = new Set([category.id, onboardingChannel.id])

  await wrapStep('Setting channel permissions', async () => {
    for (const [, ch] of channels) {
      if (ch.isThread()) continue
      const parentName = ch.parent?.name ?? ''
      const isOnboarding = onboardingIds.has(ch.id) || onboardingIds.has(ch.parent?.id)
      if (isOnboarding) {
        if (ch.id === category.id || ch.id === onboardingChannel.id) {
          await ch.permissionOverwrites.edit(everyoneId, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {})
          if (ch.id === onboardingChannel.id) {
            await ch.permissionOverwrites.edit(everyoneId, { SendMessages: true }).catch(() => {})
          }
        }
        continue
      }
      // Announcements get their tier permissions below.
      if (parentName === CATEGORY_ANNOUNCEMENTS) continue
      // Everything else — Casual, Documentation, Feedback, Meetings — is
      // Verified-only. Clients never hold Verified, so they see none of it.
      try {
        await ch.permissionOverwrites.edit(everyoneId, { ViewChannel: false })
        await ch.permissionOverwrites.edit(verifiedRole.id, { ViewChannel: true, ReadMessageHistory: true })
        if (ch.type === ChannelType.GuildVoice) {
          await ch.permissionOverwrites.edit(verifiedRole.id, { Connect: true, Speak: true }).catch(() => {})
        }
        // Constraint: #feedback — Verified also gets SendMessages, matching ensureFeedbackChannel.
        if (feedbackChannel && ch.id === feedbackChannel.id) {
          await ch.permissionOverwrites.edit(verifiedRole.id, { SendMessages: true }).catch(() => {})
        }
      } catch (_) {}
    }
    await category.permissionOverwrites.edit(everyoneId, { ViewChannel: true, ReadMessageHistory: true })
    await onboardingChannel.permissionOverwrites.edit(everyoneId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
    })
  })()

  debug('runInit: getOrCreateGuildConfig', Date.now() - t0, 'ms')
  await wrapStep('Saving guild config', () =>
    getOrCreateGuildConfig(guild.id, {
      onboardingChannelId: onboardingChannel.id,
      holdingRoleId: holdingRole.id,
      verifiedRoleId: verifiedRole.id,
      clientRoleId: clientRole.id,
      allowedDomains: config.allowedDomains,
      seniorRoleIds: [],
      dashboardRoleIds: [],
    })
  )()

  debug('runInit: updateGuildConfig (senior/dashboard)', Date.now() - t0, 'ms')
  const ceoRole = guild.roles.cache.find((r) => r.name === 'CEO')
  const serverMgrRole = guild.roles.cache.find((r) => r.name === 'Server Manager')
  const seniorRole = guild.roles.cache.find((r) => r.name === 'Senior Dev')
  const g = await getOrCreateGuildConfig(guild.id)
  const existingSenior = ensureStringArray(g.seniorRoleIds)
  const existingDashboard = ensureStringArray(g.dashboardRoleIds)
  await wrapStep('Updating senior/dashboard roles', () =>
    updateGuildConfig(guild.id, {
      seniorRoleIds: [...new Set([...existingSenior, ceoRole?.id, serverMgrRole?.id, seniorRole?.id].filter(Boolean))],
      dashboardRoleIds: [...new Set([...existingDashboard, ceoRole?.id, serverMgrRole?.id].filter(Boolean))],
    })
  )()

  if (feedbackChannel) {
    await wrapStep('Saving feedback channel', () => updateGuildConfig(guild.id, { feedbackChannelId: feedbackChannel.id }))()
  }

  await wrapStep('Creating Support category', async () => {
    const cfgNow = await getGuildConfig(guild.id)
    await ensureSupportChannels(guild, cfgNow, { botUserId: guild.client?.user?.id ?? null })
  })()

  const g2 = await getGuildConfig(guild.id)
  const dashboardRoleIds = ensureStringArray(g2?.dashboardRoleIds)
  const leadershipRoleIds = [...new Set([ceoRole?.id, serverMgrRole?.id, ...dashboardRoleIds].filter(Boolean))]
  await wrapStep('Setting Announcements tier permissions and admin channel', async () => {
    for (const [, ch] of channels) {
      if (ch.isThread() || ch.parent?.name !== CATEGORY_ANNOUNCEMENTS) continue
      await ch.permissionOverwrites.edit(everyoneId, { ViewChannel: false }).catch(() => {})
      if (ch.name === CHANNEL_ANNOUNCEMENTS_ALL) {
        await ch.permissionOverwrites.edit(everyoneId, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {})
      } else if (ch.name === CHANNEL_ANNOUNCEMENTS_VERIFIED) {
        await ch.permissionOverwrites.edit(verifiedRole.id, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {})
      } else if (ch.name === CHANNEL_ANNOUNCEMENTS_LEADERSHIP || ch.name === CHANNEL_ADMIN) {
        for (const roleId of leadershipRoleIds) {
          await ch.permissionOverwrites.edit(roleId, { ViewChannel: true, ReadMessageHistory: true, SendMessages: true }).catch(() => {})
        }
      }
    }
    const adminChannel = channels.find((c) => c.name === CHANNEL_ADMIN && c.parent?.name === CATEGORY_ANNOUNCEMENTS)
    if (adminChannel) {
      await updateGuildConfig(guild.id, { adminChannelId: adminChannel.id })
    }
  })()

  if (documentationChannel) {
    await wrapStep('Posting documentation traversal message', async () => {
      const { buildDocTraversalPayload } = await import('../services/docTraversal.js')
      const payload = await buildDocTraversalPayload(guild.id)
      if (payload) await documentationChannel.send(payload).catch(() => {})
    })().catch(() => {})
  }

  await wrapStep('Sending and pinning default channel messages', async () => {
    const allChannels = await guild.channels.fetch()
    for (const [, ch] of allChannels) {
      if (ch.isThread() || !ch.isTextBased()) continue
      const msg = getChannelPinnedMessage(ch.name)
      if (!msg) continue
      try {
        const sent = await ch.send({ content: msg })
        await sent.pin().catch(() => {})
      } catch (_) {}
    }
  })().catch(() => {})

  debug('runInit: complete', Date.now() - t0, 'ms')
  return { category, onboardingChannel, holdingRole, verifiedRole }
}

export async function handleConfirm(interaction) {
  const t0 = Date.now()
  debug('init handleConfirm: start')
  const guild = interaction.guild
  if (!guild) {
    return interaction.editReply({ content: 'Invalid.' }).catch(() => {})
  }
  try {
    debug('init handleConfirm: runInit start')
    const result = await runInit(guild)
    debug('init handleConfirm: runInit done', Date.now() - t0, 'ms')
    const embed = new EmbedBuilder()
      .setTitle('Setup complete')
      .setDescription(
        `• Category: **${CATEGORY_ONBOARDING}**\n` +
          `• Channel: ${result.onboardingChannel}\n` +
          `• Roles: **${ROLE_HOLDING}**, **${ROLE_VERIFIED}**, ${HIERARCHY_ROLES.join(', ')}, ${DISCIPLINE_ROLES.join(', ')}\n` +
          `Add repos with **/repos** and use **/backlog** or **/approve** to grant access.`
      )
      .setColor(0x57f287)
    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {})
    debug('init handleConfirm: editReply done', Date.now() - t0, 'ms')
  } catch (e) {
    const msg = e?.message ?? String(e)
    debug('init handleConfirm: error', msg, Date.now() - t0, 'ms')
    await interaction.editReply({ content: `Setup failed: ${msg}`, embeds: [], components: [] }).catch(() => {})
  }
}

export async function handleCancel(interaction) {
  await interaction.editReply({
    content: 'Setup cancelled.',
    embeds: [],
    components: [],
  }).catch(() => {})
}
