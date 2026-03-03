import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js'
import { getOrCreateGuildConfig } from '../db/index.js'
import { EPHEMERAL } from '../constants.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = path.join(__dirname, '..', '..', 'docs')

const EMBED_DESC_MAX = 4096
const EMBED_FIELD_VALUE_MAX = 1024
const SELECT_OPTIONS_MAX = 25
const LABEL_MAX = 100

/** Resolve and ensure path is under DOCS_ROOT (no path traversal). */
function resolveDocsPath(relativePath) {
  if (!relativePath || relativePath.trim() === '') return DOCS_ROOT
  const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '')
  const full = path.join(DOCS_ROOT, normalized)
  const resolved = path.resolve(full)
  if (!resolved.startsWith(path.resolve(DOCS_ROOT))) return null
  return resolved
}

/** List direct children of docs/(relativePath): dirs and .md/.mdx files. */
function listDocsDir(relativePath) {
  const dirPath = resolveDocsPath(relativePath)
  if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return { dirs: [], files: [] }
  }
  const dirs = []
  const files = []
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, value: rel })
      } else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
        files.push({ name: entry.name, value: rel })
      }
    }
  } catch (_) {
    return { dirs: [], files: [] }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))
  return { dirs, files }
}

/** Build select menu options for a given path (back + folders + files), max 25. */
function buildBrowseOptions(relativePath) {
  const { dirs, files } = listDocsDir(relativePath)
  const options = []

  if (relativePath) {
    const parent = relativePath.includes('/') ? relativePath.split('/').slice(0, -1).join('/') : ''
    options.push({
      label: '← Back',
      value: `back:${relativePath}`,
      description: parent ? `Back to ${parent}` : 'Back to root',
    })
  }

  for (const d of dirs) {
    if (options.length >= SELECT_OPTIONS_MAX) break
    options.push({
      label: `📁 ${d.name}`.slice(0, LABEL_MAX),
      value: `dir:${d.value}`,
      description: `Open folder`,
    })
  }
  for (const f of files) {
    if (options.length >= SELECT_OPTIONS_MAX) break
    options.push({
      label: `📄 ${f.name}`.slice(0, LABEL_MAX),
      value: `file:${f.value}`,
      description: f.value,
    })
  }

  return options
}

/** Strip YAML frontmatter and truncate for Discord embed. */
function formatDocContent(raw) {
  let text = raw
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/
  if (frontmatter.test(text)) text = text.replace(frontmatter, '')
  text = text.trim()
  return text
}

/** Chunk content for embed: description (4096) + fields (1024 each). */
function chunkForEmbed(content) {
  const chunks = []
  let rest = content
  const descMax = EMBED_DESC_MAX - 50
  if (rest.length <= descMax) {
    chunks.push({ type: 'description', text: rest })
    return chunks
  }
  chunks.push({ type: 'description', text: rest.slice(0, descMax) + '\n\n… *(truncated)*' })
  rest = rest.slice(descMax)
  const fieldMax = EMBED_FIELD_VALUE_MAX - 20
  while (rest.length > 0 && chunks.length < 25) {
    chunks.push({ type: 'field', text: rest.slice(0, fieldMax) + (rest.length > fieldMax ? '…' : '') })
    rest = rest.slice(fieldMax)
  }
  return chunks
}

/** Read file from docs and return formatted content or null. */
function readDocFile(relativePath) {
  const filePath = resolveDocsPath(relativePath)
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return formatDocContent(raw)
  } catch (_) {
    return null
  }
}

export const data = new SlashCommandBuilder()
  .setName('docs')
  .setDescription('Browse documentation — open folders and view .md files from bot/docs/')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run `/init` first.' })

  const options = buildBrowseOptions('')
  if (options.length === 0) {
    return interaction.editReply({
      content: 'No documentation folders or .md/.mdx files found in `bot/docs/`.',
      flags: EPHEMERAL,
    })
  }

  const embed = new EmbedBuilder()
    .setTitle('📚 Documentation')
    .setDescription('Select a **folder** to open it or a **file** to view its content.')
    .setColor(0x5865f2)
    .setFooter({ text: 'bot/docs/' })

  const select = new StringSelectMenuBuilder()
    .setCustomId('docs_browse')
    .setPlaceholder('Choose a folder or file…')
    .addOptions(options.slice(0, SELECT_OPTIONS_MAX))

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  })
}

/** Handle docs_browse select: navigate to dir, back, or show file. */
export async function handleDocsBrowse(interaction) {
  const guild = interaction.guild
  if (!guild) return

  const value = interaction.values?.[0]
  if (!value) return

  if (value.startsWith('file:')) {
    const relPath = value.slice(5).trim()
    const content = readDocFile(relPath)
    if (content == null) {
      return interaction.editReply({
        content: 'Could not read that file.',
        embeds: [],
        components: [],
      }).catch(() => {})
    }

    const chunks = chunkForEmbed(content)
    const embed = new EmbedBuilder()
      .setTitle(`📄 ${relPath}`)
      .setColor(0x5865f2)
      .setFooter({ text: 'bot/docs/' })

    const descChunk = chunks.find(c => c.type === 'description')
    if (descChunk) embed.setDescription(descChunk.text)

    const fieldChunks = chunks.filter(c => c.type === 'field')
    for (let i = 0; i < fieldChunks.length; i++) {
      embed.addFields({ name: `Continued (${i + 1})`, value: fieldChunks[i].text, inline: false })
    }

    return interaction.editReply({
      content: null,
      embeds: [embed],
      components: [],
    }).catch(() => {})
  }

  if (value.startsWith('back:')) {
    const fromPath = value.slice(5).trim()
    const parent = fromPath.includes('/') ? fromPath.split('/').slice(0, -1).join('/') : ''
    const options = buildBrowseOptions(parent)
    if (options.length === 0) {
      return interaction.editReply({
        content: 'No items here.',
        embeds: [],
        components: [],
      }).catch(() => {})
    }
    const embed = new EmbedBuilder()
      .setTitle('📚 Documentation')
      .setDescription(parent ? `**${parent}** — Select a folder or file.` : 'Select a **folder** or **file**.')
      .setColor(0x5865f2)
      .setFooter({ text: parent ? `bot/docs/${parent}` : 'bot/docs/' })
    const select = new StringSelectMenuBuilder()
      .setCustomId('docs_browse')
      .setPlaceholder('Choose a folder or file…')
      .addOptions(options.slice(0, SELECT_OPTIONS_MAX))
    return interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(select)],
    }).catch(() => {})
  }

  if (value.startsWith('dir:')) {
    const dirPath = value.slice(4).trim()
    const options = buildBrowseOptions(dirPath)
    if (options.length === 0) {
      return interaction.editReply({
        content: 'This folder is empty or has no .md/.mdx files.',
        embeds: [],
        components: [],
      }).catch(() => {})
    }
    const embed = new EmbedBuilder()
      .setTitle('📚 Documentation')
      .setDescription(`**${dirPath}** — Select a folder or file.`)
      .setColor(0x5865f2)
      .setFooter({ text: `bot/docs/${dirPath}` })
    const select = new StringSelectMenuBuilder()
      .setCustomId('docs_browse')
      .setPlaceholder('Choose a folder or file…')
      .addOptions(options.slice(0, SELECT_OPTIONS_MAX))
    return interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(select)],
    }).catch(() => {})
  }

  await interaction.editReply({ content: 'Unknown selection.', components: [] }).catch(() => {})
}
