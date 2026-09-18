import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { buildDocTraversalPayload, getDocTraversalCustomIds } from '../services/docTraversal.js'
import { docUrl } from '../utils/docRender.js'

const BACK_CUSTOM_ID = 'doc_traversal_back'
const MAX_TITLE_LEN = 100
const MAX_DESC_LEN = 4000 // headroom under Discord's 4096 embed-description cap

function truncateTitle(title) {
  const t = String(title || '').trim()
  return t.length > MAX_TITLE_LEN ? `${t.slice(0, MAX_TITLE_LEN - 1)}…` : t
}

export async function handleDocTraversalSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const value = interaction.values?.[0]
  if (!value) return

  const cfg = await getOrCreateGuildConfig(guild.id)

  if (value === '__none__') {
    return interaction
      .editReply({
        content: 'No documentation synced yet. A manager can run **/setup** and press **Sync docs now**.',
        components: [],
        embeds: [],
      })
      .catch(() => {})
  }

  try {
    const projectId = value.startsWith('proj:') ? value.slice('proj:'.length) : value
    const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
    const project = projects.find((p) => p.id === projectId)
    if (!project) {
      return interaction
        .editReply({ content: 'That project no longer exists.', components: [], embeds: [] })
        .catch(() => {})
    }

    const index = await db.docPage.listIndex({ guildConfigId: cfg.id })
    const pages = index.filter((r) => r.projectId === projectId)
    const source = await db.docSource.get({ guildConfigId: cfg.id })
    const siteUrl = source?.siteUrl || ''

    const lines = pages.slice(0, 25).map((r) => {
      const title = truncateTitle(r.title)
      return r.source === 'local' || !siteUrl
        ? `📝 ${title}`
        : `📄 [${title}](${docUrl(siteUrl, r.docId)})`
    })
    const more = pages.length > 25 ? `\n\n…and ${pages.length - 25} more — use **/docs** to browse them all.` : ''

    let description = lines.length
      ? `${lines.join('\n')}${more}`
      : 'No documentation pages for this project yet.'
    if (description.length > MAX_DESC_LEN) {
      description = `${description.slice(0, MAX_DESC_LEN - 1)}…`
    }

    const embed = new EmbedBuilder()
      .setTitle(`📚 ${project.name}`)
      .setDescription(description)
      .setColor(0x5865f2)
      .setFooter({ text: `${pages.length} page(s) · read them in Discord with /docs` })

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(BACK_CUSTOM_ID).setLabel('Back to list').setStyle(ButtonStyle.Secondary)
    )

    return interaction.editReply({ embeds: [embed], components: [row], content: null }).catch(() => {})
  } catch (e) {
    return interaction
      .editReply({ content: `Could not load that project's documentation: ${e?.message ?? String(e)}`, components: [], embeds: [] })
      .catch(() => {})
  }
}

export async function handleDocTraversalRefresh(interaction) {
  const guild = interaction.guild
  if (!guild) return

  try {
    const payload = await buildDocTraversalPayload(guild.id)
    if (payload) await interaction.editReply(payload).catch(() => {})
    else await interaction.editReply({ content: 'Server not configured.', components: [], embeds: [] }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Refresh failed: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
  }
}

export async function handleDocTraversalBack(interaction) {
  const guild = interaction.guild
  if (!guild) return

  try {
    const payload = await buildDocTraversalPayload(guild.id)
    if (payload) await interaction.editReply(payload).catch(() => {})
  } catch (_) {}
}

export { getDocTraversalCustomIds }
