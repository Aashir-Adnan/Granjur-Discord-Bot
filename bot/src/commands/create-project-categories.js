/**
 * `/create-project-categories` — the older name for `/project-setup all:true`.
 *
 * It used to build a `📂 Name` category per `projectschema` row with its own
 * role and overwrites. That table is empty and that layout is gone; a
 * project's section is now one thing, built one way, so this command runs the
 * very same walk `/project-setup all:true` runs — every guard included — and
 * owns nothing of its own.
 */
import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { runProjectSetup } from './project-setup.js'

export const data = new SlashCommandBuilder()
  .setName('create-project-categories')
  .setDescription('Create a category for each project in the DB — only users with that project role can access')

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction already deferred
 * @param {{db?: object, getConfig?: Function, run?: typeof runProjectSetup}} [deps]
 */
export async function execute(
  interaction,
  { db: dbArg = db, getConfig = getOrCreateGuildConfig, run = runProjectSetup } = {}
) {
  if (!interaction.guild) return interaction.editReply({ content: 'Use this in a server.' })
  return run(interaction, { all: true }, { db: dbArg, getConfig })
}
