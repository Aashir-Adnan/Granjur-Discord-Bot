import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'

const SELECT_CUSTOM_ID = 'doc_traversal_select'
const REFRESH_CUSTOM_ID = 'doc_traversal_refresh'

/**
 * Build embed + components for the #documentation channel (in-chat project doc traversal).
 * Options are built from repos and project schemas for the given guild.
 */
export async function buildDocTraversalPayload(guildId) {
  const cfg = await getOrCreateGuildConfig(guildId)
  if (!cfg) return null

  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  const counts = await db.docPage.countsByProject({ guildConfigId: cfg.id })
  const byId = new Map(counts.map((c) => [c.projectId, Number(c.n)]))

  const options = []
  for (const p of projects) {
    const n = byId.get(p.id) || 0
    if (!n) continue
    options.push({
      label: `${p.name}`.slice(0, 100),
      value: `proj:${p.id}`,
      description: `${n} documentation page(s)`,
    })
  }
  if (options.length === 0) {
    options.push({
      label: 'No documentation synced yet',
      value: '__none__',
      description: 'A manager can run /setup → Sync docs now',
    })
  }

  const embed = new EmbedBuilder()
    .setTitle('📚 Project documentation')
    .setDescription(
      'Select a project below to view its documentation (schema or repo docs). Add repos with **/repos** and store schemas with **/project-db**.'
    )
    .setColor(0x5865f2)
    .setFooter({ text: `${options.length} option(s)` })

  const select = new StringSelectMenuBuilder()
    .setCustomId(SELECT_CUSTOM_ID)
    .setPlaceholder('Choose a project…')
    .addOptions(options.slice(0, 25))

  const row1 = new ActionRowBuilder().addComponents(select)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(REFRESH_CUSTOM_ID).setLabel('Refresh list').setStyle(ButtonStyle.Secondary)
  )

  return { embeds: [embed], components: [row1, row2] }
}

export function getDocTraversalCustomIds() {
  return { SELECT_CUSTOM_ID, REFRESH_CUSTOM_ID }
}
