import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ROLE_CLIENT } from '../constants.js'

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

/** The commands a client may run. Everything else is refused to them. */
export function getClientCommands() {
  const cfg = loadCommandConfig()
  return Array.isArray(cfg.clientCommands) ? cfg.clientCommands : []
}

/**
 * Whether a member is a client: by the stored role id when the caller has one
 * (survives the role being renamed by hand), else by the role's name.
 */
export function memberIsClient(member, clientRoleId = null) {
  const cache = member?.roles?.cache
  if (!cache?.some) return false
  if (clientRoleId && cache.has?.(clientRoleId)) return true
  return cache.some((r) => r?.name === ROLE_CLIENT)
}

/**
 * True if member can use the command. Guild owner and anyone with Manage
 * Server can use any command. A CLIENT may use only `clientCommands` — an
 * empty role list means "anyone" for staff, never for a client.
 */
export function canUseCommand(member, commandName, { clientRoleId = null } = {}) {
  if (!member?.guild) return false
  // Server manager: guild owner or has Manage Server (or Administrator)
  if (member.guild.ownerId === member.id) return true
  if (member.permissions.has?.('ManageGuild') || member.permissions.has?.('Administrator')) return true
  if (memberIsClient(member, clientRoleId)) return getClientCommands().includes(commandName)
  const roles = getCommandRoles(commandName)
  if (roles.length === 0) return true
  return member.roles.cache.some((r) => roles.includes(r.name))
}

/**
 * Whether a member may reach a command's AUTOCOMPLETE handler.
 *
 * Autocomplete answers from the database before `execute` is ever called, so a
 * gate on `execute` alone leaves every project name, task title and doc page
 * open to anyone Discord offers the option to. A client is held to exactly the
 * same list as `canUseCommand` does — the client commands and nothing else.
 * Staff are not narrowed here: their own `commandRoles` gate still runs on
 * `execute`, and an autocomplete list is not a permission.
 */
export function autocompleteAllowed(member, commandName, { clientRoleId = null } = {}) {
  if (!memberIsClient(member, clientRoleId)) return true
  return getClientCommands().includes(commandName)
}

/** Default pinned message for a channel (by channel name). */
export function getChannelPinnedMessage(channelName) {
  const def = loadChannelDefaults()
  return def.pinnedMessages?.[channelName] ?? null
}
