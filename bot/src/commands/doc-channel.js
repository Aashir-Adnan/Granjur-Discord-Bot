import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { getRepoFileContent } from '../services/github.js'
import { buildDocTraversalPayload, getDocTraversalCustomIds } from '../services/docTraversal.js'

const BACK_CUSTOM_ID = 'doc_traversal_back'
const MAX_EMBED_DESC = 4096

function truncate(str, max = MAX_EMBED_DESC - 20) {
  if (!str || str.length <= max) return str
  return str.slice(0, max) + '\n…'
}

export async function handleDocTraversalSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const value = interaction.values?.[0]
  if (!value) return

  const cfg = await getOrCreateGuildConfig(guild.id)

  if (value === '__none__') {
    return interaction.editReply({ content: 'No projects yet. Add repos with **/repos** and click **Refresh list**.', components: [], embeds: [] }).catch(() => {})
  }

  let content = null
  let projectName = value
  let isMarkdown = false

  if (value.startsWith('schema:')) {
    const projectId = value.slice('schema:'.length)
    const s = await db.projectSchema.findFirst({
      where: { guildConfigId: cfg.id, projectId },
    })
    if (s) {
      content = s.readme || s.schemaContent
      projectName = s.projectName || s.projectId
      isMarkdown = !!s.readme
    }
  } else if (value.startsWith('repo:')) {
    const repoId = value.slice('repo:'.length)
    const repo = await db.repository.findFirst({
      where: { guildConfigId: cfg.id, id: repoId },
    })
    if (repo) {
      projectName = repo.name
      const readme = await getRepoFileContent(repo.url, 'README.md')
      if (readme) {
        content = readme
        isMarkdown = true
      } else {
        const s = await db.projectSchema.findFirst({
          where: { guildConfigId: cfg.id, projectId: repo.id },
        })
        content = s?.readme || s?.schemaContent || `No README.md in repo and no stored doc for ${repo.name}. Use **/edit-docs** or **/project-db** to add one.`
      }
    }
  }

  try {
    if (!content) {
      return interaction.editReply({ content: 'No documentation found for this project.', components: [], embeds: [] }).catch(() => {})
    }

    const desc = isMarkdown ? truncate(content) : `\`\`\`sql\n${truncate(content, 3900)}\n\`\`\``
    const embed = new EmbedBuilder()
      .setTitle(`📚 ${projectName}`)
      .setDescription(desc)
      .setColor(0x5865f2)
      .setFooter({ text: `${content.length} chars · Click Back to return to list` })

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(BACK_CUSTOM_ID).setLabel('Back to list').setStyle(ButtonStyle.Secondary)
    )

    await interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {})
  } catch (e) {
    await interaction.editReply({ content: `Failed: ${e?.message ?? String(e)}`, components: [], embeds: [] }).catch(() => {})
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
