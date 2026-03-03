import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let _commandConfig = null
let _channelDefaults = null

function loadCommandConfig() {
  if (_commandConfig) return _commandConfig
  const p = path.join(__dirname, 'command-config.json')
  _commandConfig = JSON.parse(fs.readFileSync(p, 'utf8'))
  return _commandConfig
}

function loadChannelDefaults() {
  if (_channelDefaults) return _channelDefaults
  const p = path.join(__dirname, 'channel-defaults.json')
  _channelDefaults = JSON.parse(fs.readFileSync(p, 'utf8'))
  return _channelDefaults
}

/** Roles required for a command (by name). Empty array = anyone can use. */
export function getCommandRoles(commandName) {
  const cfg = loadCommandConfig()
  const roles = cfg.commandRoles?.[commandName]
  return Array.isArray(roles) ? roles : []
}

/** Whether this command gets a dedicated channel in the command-channels category. */
export function hasDedicatedChannel(commandName) {
  const cfg = loadCommandConfig()
  return cfg.dedicatedChannels?.[commandName] === true
}

/** All command names that have dedicated channels. */
export function getDedicatedChannelCommands() {
  const cfg = loadCommandConfig()
  const ded = cfg.dedicatedChannels || {}
  return Object.keys(ded).filter((k) => ded[k] === true)
}

/** Description object { summary, syntax, detail } for a command. */
export function getCommandDescription(commandName) {
  const cfg = loadCommandConfig()
  return cfg.commandDescriptions?.[commandName] || { summary: '', syntax: '', detail: '' }
}

/** True if member can use the command (has one of the required roles, or no roles required). Guild owner and anyone with Manage Server can use any command. */
export function canUseCommand(member, commandName) {
  if (!member?.guild) return false
  // Server manager: guild owner or has Manage Server (or Administrator)
  if (member.guild.ownerId === member.id) return true
  if (member.permissions.has?.('ManageGuild') || member.permissions.has?.('Administrator')) return true
  const roles = getCommandRoles(commandName)
  if (roles.length === 0) return true
  return member.roles.cache.some((r) => roles.includes(r.name))
}

/** Default pinned message for a channel (by channel name). */
export function getChannelPinnedMessage(channelName) {
  const def = loadChannelDefaults()
  return def.pinnedMessages?.[channelName] ?? null
}
