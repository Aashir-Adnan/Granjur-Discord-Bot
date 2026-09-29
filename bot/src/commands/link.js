import { randomInt } from 'node:crypto'
import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'

// /link — a one-time code that links this Discord member to a UBS-Doc account.
// The site links accounts by verified email automatically; this is the way in
// when the emails differ (or two members share one). CSAAS redeems the code.

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I
const CODE_LENGTH = 6
const MAX_ATTEMPTS = 5

export const data = new SlashCommandBuilder()
  .setName('link')
  .setDescription('Get a code to link your Discord account to UBS-Doc')

export function generateCode(pick = randomInt) {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[pick(CODE_ALPHABET.length)]
  return out
}

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig, makeCode = generateCode } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })
  const cfg = await getConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = makeCode()
    try {
      await dbArg.discordLinkCode.issue({ guildConfigId: cfg.id, discordId: interaction.user.id, code })
      return interaction.editReply({
        content: `Your link code is **${code}**. On UBS-Doc, open **Team**, and enter it under **Link your Discord account** within 10 minutes. It works once.`,
      })
    } catch (e) {
      if (e?.code !== 'ER_DUP_ENTRY') throw e
    }
  }
  return interaction.editReply({ content: 'Could not make a code right now. Try /link again in a moment.' })
}
