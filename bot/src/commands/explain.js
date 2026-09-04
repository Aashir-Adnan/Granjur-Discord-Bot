import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { explain, CsaasError, isConfigured } from '../services/csaasClient.js'
import { buildExplainEmbed, refDocId } from '../services/explainRender.js'
import { DEFAULT_SOURCE } from '../services/docsSync.js'

export const NO_PROJECT = 'none'
const NO_PROJECT_LABEL = 'No project — all documentation'
const QUESTION_MAX = 500

export const data = new SlashCommandBuilder()
  .setName('explain')
  .setDescription('Ask a question about a project — answered from its documentation, with references')
  .addStringOption((o) =>
    o
      .setName('project')
      .setDescription('Which project to answer from (or "No project" for everything)')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((o) =>
    o
      .setName('question')
      .setDescription('What do you want explained?')
      .setRequired(true)
      .setMaxLength(QUESTION_MAX)
  )

/** Autocomplete choices: "No project" first, then projects matching the typed text. Pure. */
export function projectChoices(projects, term) {
  const t = String(term || '').trim().toLowerCase()
  const head = { name: NO_PROJECT_LABEL, value: NO_PROJECT }
  const rest = (projects || [])
    .filter((p) => !t || String(p.name || '').toLowerCase().includes(t))
    .map((p) => ({ name: String(p.name || p.id).slice(0, 100), value: String(p.id) }))
  return [head, ...rest].slice(0, 25)
}

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'project') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getOrCreateGuildConfig(interaction.guild.id)
    const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
    return interaction.respond(projectChoices(projects, focused.value)).catch(() => {})
  } catch (e) {
    console.error('[explain] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}

export async function execute(interaction) {
  if (!interaction.guild) return interaction.editReply({ content: 'Use this in a server.' }).catch(() => {})
  if (!isConfigured()) {
    return interaction.editReply({ content: 'The explainer is not configured on this bot (CSAAS_API_URL / CSAAS_ACTOR_URDD).' }).catch(() => {})
  }

  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  const projectValue = interaction.options.getString('project')
  const question = String(interaction.options.getString('question') || '').trim()
  if (!question) return interaction.editReply({ content: 'Ask a question.' }).catch(() => {})

  // The picker's value is a project id; free text typed past the suggestions
  // arrives as-is and matches nothing, which is treated as "no project".
  let project = null
  if (projectValue && projectValue !== NO_PROJECT) {
    const row = await db.project.findFirst({ where: { id: projectValue } }).catch(() => null)
    if (row && row.guildConfigId === cfg.id) {
      project = { name: row.name, docsPaths: Array.isArray(row.docsPaths) ? row.docsPaths : null }
    }
  }

  await interaction.editReply({ content: `Reading the ${project ? `**${project.name}**` : ''} documentation… this takes a minute.` }).catch(() => {})

  let result
  try {
    result = await explain({ question, project })
  } catch (e) {
    const status = e instanceof CsaasError ? e.status : null
    console.error(`[explain] CSAAS failed (status ${status}):`, e?.message ?? e)
    return interaction.editReply({ content: "Couldn't reach the explainer — try again in a minute." }).catch(() => {})
  }

  const source = (await db.docSource.get({ guildConfigId: cfg.id }).catch(() => null)) || DEFAULT_SOURCE
  // Titles come from the mirrored pages when present; the renderer falls back
  // to the filename for anything not mirrored.
  const titles = new Map()
  for (const ref of result.references) {
    const docId = refDocId(ref.path)
    if (titles.has(docId)) continue
    const row = await db.docPage.findByDocId({ guildConfigId: cfg.id, docId }).catch(() => null)
    titles.set(docId, row?.title || null)
  }
  const lookupTitle = (docId) => titles.get(docId) ?? null

  const embed = buildExplainEmbed({ ...result, question, siteUrl: source.siteUrl }, lookupTitle)
  return interaction.editReply({ content: null, embeds: [embed] }).catch(() => {})
}
