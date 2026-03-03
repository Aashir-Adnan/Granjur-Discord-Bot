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
  ROLE_COLORS,
  CATEGORY_MEETINGS,
  CHANNEL_MEETINGS_TEXT,
  CHANNEL_MEETINGS_VOICE,
  CHANNEL_UPCOMING_MEETINGS,
  CATEGORY_CASUAL,
  CHANNEL_CASUAL_CHAT,
  CHANNEL_OFF_TOPIC,
  CHANNEL_VOICE_LOUNGE,
  CATEGORY_PET_PICS,
  CHANNEL_PET_PICS,
  CATEGORY_FOODIE,
  CHANNEL_FOODIE_BLOG,
  CATEGORY_RULES,
  CHANNEL_RULES,
  CATEGORY_DOCUMENTATION,
  CHANNEL_DOCUMENTATION,
  CATEGORY_ARCHIVE,
  CHANNEL_ARCHIVE_METADATA,
  CHANNEL_ARCHIVE_SQL,
  CATEGORY_ANNOUNCEMENTS,
  CHANNEL_ANNOUNCEMENTS_ALL,
  CHANNEL_ANNOUNCEMENTS_VERIFIED,
  CHANNEL_ANNOUNCEMENTS_LEADERSHIP,
  CHANNEL_ADMIN,
  CATEGORY_FRONTEND,
  CHANNEL_FRONTEND_CHAT,
  CHANNEL_FRONTEND_VOICE,
  CATEGORY_BACKEND,
  CHANNEL_BACKEND_CHAT,
  CHANNEL_BACKEND_VOICE,
  CATEGORY_DATABASE,
  CHANNEL_DATABASE_CHAT,
  CHANNEL_DATABASE_VOICE,
  INIT_PROJECT_NAMES,
  CATEGORY_COMMAND_CHANNELS,
} from '../constants.js'
import { EPHEMERAL } from '../constants.js'
import { config } from '../config.js'
import { getDedicatedChannelCommands, getCommandDescription, getCommandRoles, getChannelPinnedMessage } from '../config/commands.js'

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}]`, ...args)
}

export const data = new SlashCommandBuilder()
  .setName('init')
  .setDescription('Set up Granjur roles, onboarding channel, and verification flow for this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

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
          '• **Onboarding**, **Rules**, **Documentation** (in-chat doc traversal), **Meetings**, **Casual**, **Pet Pictures**, **Foodie**, **Archive**\n' +
          '• **Announcements** (all, verified, leadership + **admin** for backlog pings)\n' +
          '• **Frontend** / **Backend** / **Database** (role-locked) + project categories (Fittour, Edarete, Framework)\n' +
          '• **Holding** and **Verified** roles + hierarchy & discipline roles\n\n' +
          'Categories are ordered (Onboarding → Rules → Documentation → …). New members see onboarding until they verify via **/verify** (OTP). When someone enters holding, server owner and CEOs are tagged in **admin**.'
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

  const frontendRole = guild.roles.cache.find((r) => r.name === 'Frontend')
  const backendRole = guild.roles.cache.find((r) => r.name === 'Backend')
  const databaseRole = guild.roles.cache.find((r) => r.name === 'Database')

  debug('runInit: Rules and Documentation (cascade order)', Date.now() - t0, 'ms')
  const rulesCategory = await wrapStep('Creating Rules category', () =>
    guild.channels.create({ name: CATEGORY_RULES, type: ChannelType.GuildCategory, position: 1 })
  )()
  const rulesChannel = await wrapStep('Creating rules channel', () =>
    guild.channels.create({
      name: CHANNEL_RULES,
      type: ChannelType.GuildText,
      parent: rulesCategory.id,
      topic: 'Server rules — read before participating',
    })
  )()
  const documentationCategory = await wrapStep('Creating Documentation category', () =>
    guild.channels.create({ name: CATEGORY_DOCUMENTATION, type: ChannelType.GuildCategory, position: 2 })
  )()
  let documentationChannel = null
  documentationChannel = await wrapStep('Creating documentation channel', () =>
    guild.channels.create({
      name: CHANNEL_DOCUMENTATION,
      type: ChannelType.GuildText,
      parent: documentationCategory.id,
      topic: 'Browse project documentation — select a project below',
    })
  )()

  debug('runInit: extra categories and channels', Date.now() - t0, 'ms')
  await wrapStep('Creating Meetings category', async () => {
    const cat = await guild.channels.create({ name: CATEGORY_MEETINGS, type: ChannelType.GuildCategory })
    await guild.channels.create({ name: CHANNEL_MEETINGS_TEXT, type: ChannelType.GuildText, parent: cat.id, topic: 'General meetings and sync' })
    await guild.channels.create({ name: CHANNEL_MEETINGS_VOICE, type: ChannelType.GuildVoice, parent: cat.id })
    await guild.channels.create({ name: CHANNEL_UPCOMING_MEETINGS, type: ChannelType.GuildText, parent: cat.id, topic: 'Reminders 10 min before meetings — tagged here' })
  })()
  await wrapStep('Creating Casual category', async () => {
    const cat = await guild.channels.create({ name: CATEGORY_CASUAL, type: ChannelType.GuildCategory })
    await guild.channels.create({ name: CHANNEL_CASUAL_CHAT, type: ChannelType.GuildText, parent: cat.id })
    await guild.channels.create({ name: CHANNEL_OFF_TOPIC, type: ChannelType.GuildText, parent: cat.id })
    await guild.channels.create({ name: CHANNEL_VOICE_LOUNGE, type: ChannelType.GuildVoice, parent: cat.id })
  })()
  await wrapStep('Creating Pet Pictures category', async () => {
    const cat = await guild.channels.create({ name: CATEGORY_PET_PICS, type: ChannelType.GuildCategory })
    await guild.channels.create({ name: CHANNEL_PET_PICS, type: ChannelType.GuildText, parent: cat.id, topic: 'Share pet pictures' })
  })()
  await wrapStep('Creating Foodie category', async () => {
    const cat = await guild.channels.create({ name: CATEGORY_FOODIE, type: ChannelType.GuildCategory })
    await guild.channels.create({ name: CHANNEL_FOODIE_BLOG, type: ChannelType.GuildText, parent: cat.id, topic: 'Foodie blogs and recipes' })
  })()
  await wrapStep('Creating Archive category', async () => {
    const cat = await guild.channels.create({ name: CATEGORY_ARCHIVE, type: ChannelType.GuildCategory })
    await guild.channels.create({ name: CHANNEL_ARCHIVE_METADATA, type: ChannelType.GuildText, parent: cat.id, topic: 'Meeting metadata and notes' })
    await guild.channels.create({ name: CHANNEL_ARCHIVE_SQL, type: ChannelType.GuildText, parent: cat.id, topic: 'SQL dumps and schema archives' })
  })()
  await wrapStep('Creating Announcements category (tiers + admin)', async () => {
    const cat = await guild.channels.create({ name: CATEGORY_ANNOUNCEMENTS, type: ChannelType.GuildCategory })
    await guild.channels.create({ name: CHANNEL_ANNOUNCEMENTS_ALL, type: ChannelType.GuildText, parent: cat.id, topic: 'Announcements for everyone' })
    await guild.channels.create({ name: CHANNEL_ANNOUNCEMENTS_VERIFIED, type: ChannelType.GuildText, parent: cat.id, topic: 'Announcements for verified members' })
    await guild.channels.create({ name: CHANNEL_ANNOUNCEMENTS_LEADERSHIP, type: ChannelType.GuildText, parent: cat.id, topic: 'Announcements for leadership' })
    await guild.channels.create({ name: CHANNEL_ADMIN, type: ChannelType.GuildText, parent: cat.id, topic: 'Backlog notifications — server owner & CEOs tagged when someone enters holding' })
  })()
  await wrapStep('Creating Frontend category (role-locked)', async () => {
    const cat = await guild.channels.create({ name: CATEGORY_FRONTEND, type: ChannelType.GuildCategory })
    await guild.channels.create({ name: CHANNEL_FRONTEND_CHAT, type: ChannelType.GuildText, parent: cat.id })
    await guild.channels.create({ name: CHANNEL_FRONTEND_VOICE, type: ChannelType.GuildVoice, parent: cat.id })
  })()
  await wrapStep('Creating Backend category (role-locked)', async () => {
    const cat = await guild.channels.create({ name: CATEGORY_BACKEND, type: ChannelType.GuildCategory })
    await guild.channels.create({ name: CHANNEL_BACKEND_CHAT, type: ChannelType.GuildText, parent: cat.id })
    await guild.channels.create({ name: CHANNEL_BACKEND_VOICE, type: ChannelType.GuildVoice, parent: cat.id })
  })()
  await wrapStep('Creating Database category (role-locked)', async () => {
    const cat = await guild.channels.create({ name: CATEGORY_DATABASE, type: ChannelType.GuildCategory })
    await guild.channels.create({ name: CHANNEL_DATABASE_CHAT, type: ChannelType.GuildText, parent: cat.id })
    await guild.channels.create({ name: CHANNEL_DATABASE_VOICE, type: ChannelType.GuildVoice, parent: cat.id })
  })()
  for (const projectName of INIT_PROJECT_NAMES) {
    await wrapStep(`Creating project category: ${projectName}`, async () => {
      const cat = await guild.channels.create({ name: `📂 ${projectName}`, type: ChannelType.GuildCategory })
      await guild.channels.create({ name: `${projectName.toLowerCase()}-chat`, type: ChannelType.GuildText, parent: cat.id })
      await guild.channels.create({ name: `${projectName.toLowerCase()}-voice`, type: ChannelType.GuildVoice, parent: cat.id })
    })()
  }

  await wrapStep('Creating Command channels category', async () => {
    const cat = await guild.channels.create({ name: CATEGORY_COMMAND_CHANNELS, type: ChannelType.GuildCategory })
    const cmdNames = getDedicatedChannelCommands()
    for (const cmdName of cmdNames) {
      const ch = await guild.channels.create({
        name: `cmd-${cmdName}`,
        type: ChannelType.GuildText,
        parent: cat.id,
        topic: `Use /${cmdName} here — see message below for details`,
      })
      const desc = getCommandDescription(cmdName)
      const roles = getCommandRoles(cmdName)
      const roleText = roles.length ? `**Allowed roles:** ${roles.join(', ')}` : '**Allowed:** Everyone'
      const embed = new EmbedBuilder()
        .setTitle(`/${cmdName}`)
        .setDescription(desc.detail || desc.summary)
        .addFields(
          { name: 'Syntax', value: desc.syntax || `\`/${cmdName}\``, inline: false },
          { name: 'Permission', value: roleText, inline: false }
        )
        .setColor(0x5865f2)
      await ch.send({ content: '**Command usage**', embeds: [embed] }).catch(() => {})
    }
  })()

  const everyoneId = guild.id
  debug('runInit: fetch channels and set permissions', Date.now() - t0, 'ms')
  const channels = await guild.channels.fetch()
  const onboardingIds = new Set([category.id, onboardingChannel.id])
  const roleLockedCategories = new Map() // category name prefix -> role id (only that role can view)
  if (frontendRole) roleLockedCategories.set('Frontend', frontendRole.id)
  if (backendRole) roleLockedCategories.set('Backend', backendRole.id)
  if (databaseRole) roleLockedCategories.set('Database', databaseRole.id)

  await wrapStep('Setting channel permissions', async () => {
    for (const [, ch] of channels) {
      if (ch.isThread()) continue
      const parentName = ch.parent?.name ?? ''
      const isOnboarding = onboardingIds.has(ch.id) || onboardingIds.has(ch.parent?.id)
      const isRules = parentName === CATEGORY_RULES
      const isDocumentation = parentName === CATEGORY_DOCUMENTATION
      const isAnnouncements = parentName === CATEGORY_ANNOUNCEMENTS
      const isRoleLocked = [...roleLockedCategories.entries()].some(([name]) => parentName.includes(name))
      const roleIdForCategory = isRoleLocked && ch.parent
        ? [...roleLockedCategories.entries()].find(([name]) => (ch.parent?.name ?? '').includes(name))?.[1]
        : null

      if (isOnboarding) {
        if (ch.id === category.id || ch.id === onboardingChannel.id) {
          await ch.permissionOverwrites.edit(everyoneId, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {})
          if (ch.id === onboardingChannel.id) {
            await ch.permissionOverwrites.edit(everyoneId, { SendMessages: true }).catch(() => {})
          }
        }
        continue
      }
      if (isRules || (ch.type === ChannelType.GuildCategory && ch.name === CATEGORY_RULES)) {
        await ch.permissionOverwrites.edit(everyoneId, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {})
        continue
      }
      if (isDocumentation || (ch.type === ChannelType.GuildCategory && ch.name === CATEGORY_DOCUMENTATION)) {
        await ch.permissionOverwrites.edit(everyoneId, { ViewChannel: false }).catch(() => {})
        await ch.permissionOverwrites.edit(verifiedRole.id, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {})
        continue
      }
      if (isAnnouncements) continue
      try {
        await ch.permissionOverwrites.edit(everyoneId, { ViewChannel: false })
        if (roleIdForCategory) {
          await ch.permissionOverwrites.edit(roleIdForCategory, { ViewChannel: true, ReadMessageHistory: true })
          if (ch.type === ChannelType.GuildVoice) {
            await ch.permissionOverwrites.edit(roleIdForCategory, { Connect: true }).catch(() => {})
          }
        } else {
          await ch.permissionOverwrites.edit(verifiedRole.id, { ViewChannel: true, ReadMessageHistory: true })
          if (ch.type === ChannelType.GuildVoice) {
            await ch.permissionOverwrites.edit(verifiedRole.id, { Connect: true }).catch(() => {})
          }
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
