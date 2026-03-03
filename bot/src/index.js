import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'
import { config } from './config.js'
import { loadCommands, handleCommand, isModalFirstCommand } from './commands/index.js'
import { handleMemberAdd } from './events/memberAdd.js'
import { startVerifyServer } from './server.js'
import { EPHEMERAL } from './constants.js'
import handleInteractions from './handlers/interactions.js'
import { startMeetingReminder } from './services/meetingReminder.js'
import { startTicketReminder } from './services/ticketReminder.js'

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}]`, ...args)
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.GuildMember],
})

let commands

client.once(Events.ClientReady, async () => {
  commands = await loadCommands(client)
  startVerifyServer(client)
  startMeetingReminder(client)
  startTicketReminder(client)
  console.log(`Logged in as ${client.user.tag}`)
})

client.on(Events.InteractionCreate, async (interaction) => {
  debug(`Interaction received ${interaction.type}`)
  // Defer slash commands first — nothing else before this so we stay under 3s
  if (interaction.isChatInputCommand() && !isModalFirstCommand(interaction.commandName)) {
    try {
      await interaction.deferReply({ flags: EPHEMERAL })
    } catch (e) {
      if (e.code !== 10062) console.error('[index] deferReply error:', e)
      return
    }
  }
  else{
    debug('Interaction is not a chat input command')
  }

  const t0 = Date.now()
  const kind = interaction.isChatInputCommand()
    ? `command:${interaction.commandName}`
    : interaction.isButton()
      ? `button:${interaction.customId}`
      : interaction.isStringSelectMenu()
        ? `select:${interaction.customId}`
        : interaction.isModalSubmit()
          ? `modal:${interaction.customId}`
          : 'other'
  debug(`Interaction received ${kind}`)

  if (interaction.isChatInputCommand()) {
    const needsDefer = !isModalFirstCommand(interaction.commandName)
    if (needsDefer) debug(`deferReply already done (${Date.now() - t0}ms ago)`)
    if (!commands) {
      if (needsDefer) {
        await interaction.editReply({ content: 'Bot is still starting. Please try again in a few seconds.' }).catch(() => {})
      } else {
        await interaction.reply({ content: 'Bot is still starting. Please try again in a few seconds.', flags: EPHEMERAL }).catch(() => {})
      }
      return
    }
    try {
      await handleCommand(interaction, commands)
      debug(`handleCommand ${interaction.commandName} done (${Date.now() - t0}ms)`)
    } catch (err) {
      console.error('[index] handleCommand error:', err)
      if (needsDefer && (interaction.deferred || interaction.replied)) {
        await interaction.editReply({ content: 'Something went wrong. Please try again.' }).catch(() => {})
      } else if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong. Please try again.', flags: EPHEMERAL }).catch(() => {})
      }
    }
    return
  }

  if (interaction.isStringSelectMenu() || interaction.isButton() || interaction.isModalSubmit()) {
    // Do not defer components that may respond with showModal() — they must use the interaction once
    const noDeferComponentIds = [
      'feature_show_modal',
      'feature_edit',           // shows input modal again
      'schedule_show_modal',
      'invite_enter_email',
      'verify_enter_otp',  // Enter code → OTP modal
      'faq_ask',
      'faq_search',
      'backlog_select_user',    // can show role step
      'backlog_select_roles',   // can show add-role modal
      'backlog_approve_btn',    // shows confirm-approval modal
      'bug_repo',               // repo select → title/description modal (legacy, kept for ticket)
      'create_task_show_modal',  // opens details modal
      'create_task_repo',       // repo select → details modal for bug
      // create-task: skip defer so select/next can update message immediately (avoids interaction failed)
      'create_task_type_feature',
      'create_task_type_bug',
      'create_task_select_repos',
      'create_task_select_projects',
      'create_task_repos_next',
      'create_task_members',
      'create_task_members_next',
      'create_task_assignees',
      'create_task_metric_api',
      'create_task_metric_qa',
      'create_task_metric_ac',
    ]
    const customId = interaction.customId || ''
    const skipDefer = (interaction.isButton() || interaction.isStringSelectMenu()) &&
      noDeferComponentIds.some((id) => customId === id || customId.startsWith(id + ':'))
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      if (!skipDefer) {
        try {
          await interaction.deferUpdate()
        } catch (e) {
          if (e.code !== 10062) console.error('[index] deferUpdate error:', e)
          await interaction.reply({ content: 'Could not process that action. Please try again.', flags: EPHEMERAL }).catch(() => {})
          return
        }
      }
    } else if (interaction.isModalSubmit()) {
      try {
        await interaction.deferReply({ flags: EPHEMERAL })
      } catch (e) {
        if (e.code !== 10062) console.error('[index] deferReply (modal) error:', e)
        await interaction.reply({ content: 'Could not process. Please try again.', flags: EPHEMERAL }).catch(() => {})
        return
      }
    }
    debug(`Routing component ${kind} (${Date.now() - t0}ms since receive)`)
    try {
      await handleInteractions(interaction)
      debug(`handleInteractions ${kind} done (${Date.now() - t0}ms)`)
    } catch (err) {
      console.error(`[index] handleInteractions ${kind} error:`, err)
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong. Please try again.', flags: EPHEMERAL }).catch(() => {})
      } else {
        await interaction.editReply({ content: 'Something went wrong. Please try again.' }).catch(() => {})
      }
    }
  }
})

client.on(Events.GuildMemberAdd, handleMemberAdd)

client.login(config.discord.token).catch((err) => {
  console.error('Login failed:', err)
  process.exit(1)
})
