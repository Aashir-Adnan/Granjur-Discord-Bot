import 'dotenv/config'
import { REST, Routes } from 'discord.js'
import { getCommands } from '../src/commands/index.js'

const token = process.env.DISCORD_TOKEN
const clientId = process.env.DISCORD_CLIENT_ID
const guildId = process.env.DISCORD_GUILD_ID

if (!token || !clientId) {
  console.error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID in .env')
  process.exit(1)
}

const commands = getCommands().map((c) => c.toJSON())
const rest = new REST({ version: '10' }).setToken(token)

if (guildId) {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
  console.log(`Registered ${commands.length} commands for guild ${guildId}`)
} else {
  await rest.put(Routes.applicationCommands(clientId), { body: commands })
  console.log(`Registered ${commands.length} global commands`)
}
