import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { rootOptions, childOptions } from '../utils/docTree.js'
import { renderForDiscord, paginate, docUrl } from '../utils/docRender.js'
import { DEFAULT_SOURCE } from '../services/docsSync.js'

const SELECT_ID = 'docs_browse'
const PAGE_CHARS = 3800

export const data = new SlashCommandBuilder()
  .setName('docs')
  .setDescription('Browse project and framework documentation')
  .addStringOption((o) =>
    o
      .setName('query')
      .setDescription('Search documentation by title or content')
      .setRequired(false)
      .setAutocomplete(true)
  )

async function context(interaction) {
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  const source = (await db.docSource.get({ guildConfigId: cfg.id })) || DEFAULT_SOURCE
  return { cfg, source }
}

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'query') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getOrCreateGuildConfig(interaction.guild.id)
    const rows = await db.docPage.search({ guildConfigId: cfg.id, q: focused.value, limit: 25 })
    // The choice value is the row id — an autocomplete value also caps at 100.
    return interaction
      .respond(rows.map((r) => ({ name: r.title.slice(0, 100), value: r.id })))
      .catch(() => {})
  } catch {
    return interaction.respond([]).catch(() => {})
  }
}

/** Build the embed + components for one page of one doc. */
function docPayload(row, source, page) {
  const rendered = renderForDiscord(row.content, { siteUrl: source.siteUrl, docId: row.docId })
  const pages = paginate(rendered, PAGE_CHARS)
  const n = Math.min(Math.max(page, 0), pages.length - 1)

  const embed = new EmbedBuilder()
    .setTitle(row.title.slice(0, 256))
    .setDescription(pages[n] || '_empty_')
    .setColor(0x5865f2)
    .setFooter({ text: `${row.docId} — page ${n + 1}/${pages.length}` })

  const buttons = []
  if (pages.length > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`docs_page_prev:${row.id}:${n}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(n === 0),
      new ButtonBuilder()
        .setCustomId(`docs_page_next:${row.id}:${n}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(n >= pages.length - 1)
    )
  }
  if (row.source !== 'local') {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Read full page ↗')
        .setStyle(ButtonStyle.Link)
        .setURL(docUrl(source.siteUrl, row.docId))
    )
  }

  const components = buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : []
  return { embeds: [embed], components, content: null }
}

async function browsePayload(cfg, scope, prefix, page) {
  const index = await db.docPage.listIndex({ guildConfigId: cfg.id })
  if (index.length === 0) {
    return {
      content: 'No documentation synced yet. A manager can run **/setup** and press **Sync docs now**.',
      embeds: [],
      components: [],
    }
  }

  let options
  let heading
  if (!scope) {
    const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
    options = rootOptions(index, projects)
    heading = 'Select a project or a documentation section.'
  } else {
    const res = childOptions(index, { scope, prefix, page })
    options = res.options
    heading = prefix ? `**${prefix}**` : 'Select a folder or a page.'
  }

  if (options.length === 0) {
    return { content: 'Nothing here.', embeds: [], components: [] }
  }

  const embed = new EmbedBuilder()
    .setTitle('📚 Documentation')
    .setDescription(heading)
    .setColor(0x5865f2)

  const select = new StringSelectMenuBuilder()
    .setCustomId(scope ? `${SELECT_ID}:${scope}` : SELECT_ID)
    .setPlaceholder('Choose…')
    .addOptions(options.slice(0, 25))

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], content: null }
}

export async function execute(interaction) {
  if (!interaction.guild) return interaction.editReply({ content: 'Use this in a server.' })
  const { cfg, source } = await context(interaction)

  const q = interaction.options.getString('query')
  if (q) {
    // Picking an autocomplete suggestion sends a row id; typing free text and
    // pressing enter sends whatever was typed, so fall back to a search.
    let row = await db.docPage.findById({ guildConfigId: cfg.id, id: q })
    if (!row) {
      const hits = await db.docPage.search({ guildConfigId: cfg.id, q, limit: 1 })
      if (hits.length) row = await db.docPage.findById({ guildConfigId: cfg.id, id: hits[0].id })
    }
    if (!row) {
      return interaction.editReply({ content: `No documentation found for **${q}**.` }).catch(() => {})
    }
    return interaction.editReply(docPayload(row, source, 0)).catch(() => {})
  }

  return interaction.editReply(await browsePayload(cfg, null, '', 0)).catch(() => {})
}

export async function handleDocsBrowse(interaction) {
  if (!interaction.guild) return
  const { cfg, source } = await context(interaction)
  const value = interaction.values?.[0]
  if (!value) return

  const scopeFromId = interaction.customId.startsWith(`${SELECT_ID}:`)
    ? interaction.customId.slice(SELECT_ID.length + 1)
    : null

  if (value.startsWith('proj:') || value.startsWith('sec:')) {
    return interaction.editReply(await browsePayload(cfg, value, '', 0)).catch(() => {})
  }
  if (value.startsWith('dir:')) {
    return interaction.editReply(await browsePayload(cfg, scopeFromId, value.slice(4), 0)).catch(() => {})
  }
  if (value.startsWith('back:')) {
    const parent = value.slice(5)
    if (!parent) return interaction.editReply(await browsePayload(cfg, null, '', 0)).catch(() => {})
    return interaction.editReply(await browsePayload(cfg, scopeFromId, parent, 0)).catch(() => {})
  }
  if (value.startsWith('more:')) {
    const rest = value.slice(5)
    const lastColon = rest.lastIndexOf(':')
    const prefix = rest.slice(0, lastColon)
    const page = Number(rest.slice(lastColon + 1)) || 0
    return interaction.editReply(await browsePayload(cfg, scopeFromId, prefix, page)).catch(() => {})
  }
  if (value.startsWith('doc:')) {
    const row = await db.docPage.findById({ guildConfigId: cfg.id, id: value.slice(4) })
    if (!row) {
      const src = await db.docSource.get({ guildConfigId: cfg.id })
      const when = src?.lastSyncedAt ? ` (last synced <t:${Math.floor(new Date(src.lastSyncedAt).getTime() / 1000)}:R>)` : ''
      return interaction
        .editReply({ content: `That page is not available — docs may be out of date${when}.`, embeds: [], components: [] })
        .catch(() => {})
    }
    return interaction.editReply(docPayload(row, source, 0)).catch(() => {})
  }

  return interaction.editReply({ content: 'Unknown selection.', components: [] }).catch(() => {})
}

export async function handleDocsPage(interaction) {
  if (!interaction.guild) return
  const { cfg, source } = await context(interaction)
  // customId is `docs_page_(prev|next):<row id>:<current page>` — a row id
  // never contains a colon, so a plain split is safe.
  const [action, rowId, pageStr] = interaction.customId.split(':')
  const page = Number(pageStr) || 0
  const row = await db.docPage.findById({ guildConfigId: cfg.id, id: rowId })
  if (!row) return interaction.editReply({ content: 'That page is no longer available.' }).catch(() => {})
  const next = action === 'docs_page_next' ? page + 1 : page - 1
  return interaction.editReply(docPayload(row, source, next)).catch(() => {})
}
