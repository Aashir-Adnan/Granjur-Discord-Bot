import {
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
} from 'discord.js'
import { config } from '../config.js'
import { EPHEMERAL } from '../constants.js'
import { canUseCommand, getCommandDescription } from '../config/commands.js'
import * as initCmd from './init.js'
import * as createTaskCmd from './create-task.js'
import * as fetchMyCmd from './fetch-my.js'
import * as scheduleCmd from './schedule.js'
import * as projectDbCmd from './project-db.js'
import * as evaluateCmd from './evaluate.js'
import * as docsCmd from './docs.js'
import * as faqCmd from './faq.js'
import * as faqAnswerCmd from './faq-answer.js'
import * as scrapCmd from './scrap.js'
import * as dashboardCmd from './dashboard.js'
import * as approveCmd from './approve.js'
import * as reposCmd from './repos.js'
import * as verifyCmd from './verify.js'
import * as ticketCmd from './ticket.js'
import * as inviteCmd from './invite.js'
import * as backlogCmd from './backlog.js'
import * as editDocsCmd from './edit-docs.js'
import * as clockInCmd from './clock-in.js'
import * as clockOutCmd from './clock-out.js'
import * as sqlDumpCmd from './sql-dump.js'
import * as closeFeatureCmd from './close-feature.js'
import * as resolveBugCmd from './resolve-bug.js'
import * as migrateCmd from './migrate.js'
import * as updateTaskCmd from './update-task.js'
import * as createProjectRoleCmd from './create-project-role.js'
import * as createProjectCategoriesCmd from './create-project-categories.js'

const commandModules = [
  initCmd,
  verifyCmd,
  inviteCmd,
  backlogCmd,
  createTaskCmd,
  updateTaskCmd,
  createProjectRoleCmd,
  createProjectCategoriesCmd,
  ticketCmd,
  fetchMyCmd,
  scheduleCmd,
  projectDbCmd,
  evaluateCmd,
  docsCmd,
  faqCmd,
  faqAnswerCmd,
  scrapCmd,
  dashboardCmd,
  approveCmd,
  reposCmd,
  editDocsCmd,
  clockInCmd,
  clockOutCmd,
  sqlDumpCmd,
  closeFeatureCmd,
  resolveBugCmd,
  migrateCmd,
]

export function getCommands() {
  return commandModules.map((m) => m.data).filter(Boolean)
}

export async function loadCommands(client) {
  const map = new Map()
  for (const m of commandModules) {
    if (m.data) map.set(m.data.name, m)
  }
  const commands = getCommands()
  const rest = new REST({ version: '10' }).setToken(config.discord.token)
  const payload = commands.map((c) => c.toJSON())
  try {
    if (config.discord.guildId) {
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
        { body: payload }
      )
      console.log(`Registered ${payload.length} slash commands for guild ${config.discord.guildId}`)
    } else {
      await rest.put(Routes.applicationCommands(config.discord.clientId), { body: payload })
      console.log(`Registered ${payload.length} slash commands globally (may take up to 1 hour to appear)`)
    }
  } catch (e) {
    console.error('Slash command registration failed:', e.message)
    if (e.code === 50001) {
      console.error('Tip: Re-invite the bot with the "applications.commands" scope in the OAuth2 URL.')
    }
  }
  return map
}

// Commands that show a modal — we defer all slash commands so we stay under 3s; modal is shown via a button
const MODAL_FIRST_COMMANDS = new Set([])

export function isModalFirstCommand(name) {
  return MODAL_FIRST_COMMANDS.has(name)
}

export async function handleCommand(interaction, commands) {
  const cmd = commands?.get(interaction.commandName)
  if (!cmd?.execute) {
    if (interaction.deferred) {
      return interaction.editReply({ content: 'Unknown command.' }).catch(() => {})
    }
    return interaction.reply({ content: 'Unknown command.', flags: EPHEMERAL }).catch(() => {})
  }
  const member = interaction.guild?.members?.cache?.get(interaction.user.id) ?? await interaction.guild?.members?.fetch(interaction.user.id).catch(() => null)
  if (member && !canUseCommand(member, interaction.commandName)) {
    const msg = 'You don\'t have permission to use this command. Required role(s) are in the command channel description.'
    if (interaction.deferred) return interaction.editReply({ content: msg }).catch(() => {})
    return interaction.reply({ content: msg, flags: EPHEMERAL }).catch(() => {})
  }
  try {
    await cmd.execute(interaction)
  } catch (err) {
    console.error(`Command ${interaction.commandName}:`, err)
    const msg = err.message || 'Something went wrong.'
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: msg }).catch(() => {})
    } else {
      await interaction.reply({ content: msg, flags: EPHEMERAL }).catch(() => {})
    }
  }
}
