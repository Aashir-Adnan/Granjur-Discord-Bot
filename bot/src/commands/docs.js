import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { rootOptions, childOptions, browseTargetFor } from '../utils/docTree.js'
import {
  ticketsRootOption,
  ticketProjectOptions,
  ticketDocOptions,
  ticketDocScopeFor,
  TICKETS_ROOT,
} from '../utils/ticketDocTree.js'
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

  // A document replaces the browse menu, so without this the only way back to
  // the picker is re-running /docs. There is no history to unwind — the row
  // itself says which folder it lives in.
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`docs_back:${row.id}`)
      .setLabel('← Back to docs')
      .setStyle(ButtonStyle.Secondary),
  ]
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

/** The stored write-ups from closed tickets, or [] when the table is unreadable. */
async function ticketRows(cfg) {
  try {
    return (await db.ticketDoc.listWithTask({ guildConfigId: cfg.id })) || []
  } catch (e) {
    console.warn('[docs] ticket doc lookup failed:', e?.message || e)
    return []
  }
}

/** One stored ticket write-up, rendered like any other page. */
function ticketDocPayload(row, page) {
  const rendered = renderForDiscord(row.content || '')
  const pages = paginate(rendered, PAGE_CHARS)
  const n = Math.min(Math.max(page, 0), pages.length - 1)

  const embed = new EmbedBuilder()
    .setTitle(String(row.title || row.taskTitle || 'Write-up').slice(0, 256))
    .setDescription(pages[n] || '_empty_')
    .setColor(0x5865f2)
    .setFooter({
      text: [row.projectName || 'No project', row.taskStatus, `page ${n + 1}/${pages.length}`]
        .filter(Boolean)
        .join(' · ')
        .slice(0, 2048),
    })

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`docs_tback:${row.id}`)
      .setLabel('← Back to ticket docs')
      .setStyle(ButtonStyle.Secondary),
  ]
  if (pages.length > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`docs_tpage_prev:${row.id}:${n}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(n === 0),
      new ButtonBuilder()
        .setCustomId(`docs_tpage_next:${row.id}:${n}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(n >= pages.length - 1)
    )
  }
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)], content: null }
}

/** A level of the Ticket docs branch: `tickets:`, `tickets:proj:<id>`, `tickets:none`. */
async function ticketsPayload(cfg, scope) {
  const rows = await ticketRows(cfg)
  if (rows.length === 0) {
    return {
      content: 'No ticket write-ups yet. They appear here when a feature ticket is closed with a document attached.',
      embeds: [],
      components: [],
    }
  }
  const atRoot = scope === TICKETS_ROOT
  const options = atRoot ? ticketProjectOptions(rows) : ticketDocOptions(rows, scope)
  const embed = new EmbedBuilder()
    .setTitle('🎫 Ticket docs')
    .setDescription(atRoot ? 'Write-ups from closed tickets, by project.' : 'Select a write-up.')
    .setColor(0x5865f2)
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${SELECT_ID}:${scope}`)
    .setPlaceholder('Choose…')
    .addOptions(options.slice(0, 25))
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], content: null }
}

async function browsePayload(cfg, scope, prefix, page) {
  if (scope && scope.startsWith(TICKETS_ROOT)) return ticketsPayload(cfg, scope)

  const index = await db.docPage.listIndex({ guildConfigId: cfg.id })
  const tickets = await ticketRows(cfg)
  if (index.length === 0 && tickets.length === 0) {
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
    // Ticket write-ups live beside the synced corpus rather than inside it —
    // they are written in Discord and belong to a task, not to a repo path.
    const ticketsEntry = ticketsRootOption(tickets)
    if (ticketsEntry) options = [...options.slice(0, 24), ticketsEntry]
    heading = 'Select a project or a documentation section.'
  } else {
    const res = childOptions(index, { scope, prefix, page })
    options = res.options
    // A section scope rewrites its base prefix to the section name (see
    // childOptions), so at that level `prefix` reads like a folder name even
    // though it is really the scope root — only show the folder heading once
    // the user is genuinely below the scope root.
    const atScopeRoot = !prefix || (scope.startsWith('sec:') && prefix === scope.slice(4))
    heading = atScopeRoot ? 'Select a folder or a page.' : `**${prefix}**`
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
  if (!interaction.guild) return interaction.editReply({ content: 'Use this in a server.' }).catch(() => {})
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

  if (value.startsWith(TICKETS_ROOT)) {
    return interaction.editReply(await browsePayload(cfg, value, '', 0)).catch(() => {})
  }
  if (value.startsWith('tdoc:')) {
    const rows = await ticketRows(cfg)
    const row = rows.find((r) => r.id === value.slice(5))
    if (!row) return interaction.editReply({ content: 'That write-up is no longer available.', embeds: [], components: [] }).catch(() => {})
    const full = await db.ticketDoc.findFirst({ where: { id: row.id } }).catch(() => null)
    if (!full?.content) return interaction.editReply({ content: 'That write-up is empty.', embeds: [], components: [] }).catch(() => {})
    return interaction.editReply(ticketDocPayload({ ...row, content: full.content }, 0)).catch(() => {})
  }
  if (value.startsWith('proj:') || value.startsWith('sec:')) {
    return interaction.editReply(await browsePayload(cfg, value, '', 0)).catch(() => {})
  }
  if (value.startsWith('dir:')) {
    return interaction.editReply(await browsePayload(cfg, scopeFromId, value.slice(4), 0)).catch(() => {})
  }
  if (value === 'root:') {
    return interaction.editReply(await browsePayload(cfg, null, '', 0)).catch(() => {})
  }
  if (value.startsWith('back:')) {
    const parent = value.slice(5)
    if (!parent) {
      // Empty parent from a scope root means "back to the top of this scope",
      // not the global root — losing scopeFromId here silently drops the
      // project/section the user was browsing. Only fall back to the global
      // root if we truly don't know the scope.
      return interaction.editReply(await browsePayload(cfg, scopeFromId || null, '', 0)).catch(() => {})
    }
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

export async function handleDocsBack(interaction) {
  if (!interaction.guild) return
  const { cfg } = await context(interaction)
  const rowId = interaction.customId.slice('docs_back:'.length)
  const row = await db.docPage.findById({ guildConfigId: cfg.id, id: rowId })
  // A page deleted by a sync since it was opened still gets the user somewhere
  // useful, so fall back to the global root rather than erroring.
  const { scope, prefix } = row ? browseTargetFor(row) : { scope: null, prefix: '' }
  return interaction.editReply(await browsePayload(cfg, scope, prefix, 0)).catch(() => {})
}

/** Load one ticket write-up with its content, or null. */
async function ticketDocById(cfg, id) {
  const rows = await ticketRows(cfg)
  const row = rows.find((r) => r.id === id)
  if (!row) return null
  const full = await db.ticketDoc.findFirst({ where: { id } }).catch(() => null)
  return full?.content ? { ...row, content: full.content } : null
}

export async function handleTicketDocBack(interaction) {
  if (!interaction.guild) return
  const { cfg } = await context(interaction)
  const id = interaction.customId.slice('docs_tback:'.length)
  const rows = await ticketRows(cfg)
  const row = rows.find((r) => r.id === id)
  return interaction.editReply(await browsePayload(cfg, row ? ticketDocScopeFor(row) : TICKETS_ROOT, '', 0)).catch(() => {})
}

export async function handleTicketDocPage(interaction) {
  if (!interaction.guild) return
  const { cfg } = await context(interaction)
  const [action, id, pageStr] = interaction.customId.split(':')
  const row = await ticketDocById(cfg, id)
  if (!row) return interaction.editReply({ content: 'That write-up is no longer available.' }).catch(() => {})
  const next = (Number(pageStr) || 0) + (action === 'docs_tpage_next' ? 1 : -1)
  return interaction.editReply(ticketDocPayload(row, next)).catch(() => {})
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
