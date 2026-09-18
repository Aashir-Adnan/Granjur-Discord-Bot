import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as flowStore from '../flows/store.js'
import { slugify } from '../utils/docPath.js'
import { reattributeGuildDocs } from '../services/docsSync.js'
import { cut, projectSlug } from '../services/projectSection.js'
import { EPHEMERAL } from '../constants.js'
import { setupOneProject } from './project-setup.js'

/** Discord's hard limit on a message. */
const REPLY_LIMIT = 2000

export const data = new SlashCommandBuilder()
  .setName('projects')
  .setDescription('(CEO/Server Manager) List projects, add a project, link a repo')

async function listPayload(cfg) {
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  const counts = await db.docPage.countsByProject({ guildConfigId: cfg.id })
  const byId = new Map(counts.map((c) => [c.projectId, Number(c.n)]))

  const embed = new EmbedBuilder()
    .setTitle('Projects')
    .setColor(0x5865f2)
    .setDescription(
      projects.length
        ? projects
            .map((p) => `**${p.name}** — \`${p.docsSlug || slugify(p.name)}\` — ${byId.get(p.id) || 0} doc page(s)`)
            .join('\n')
        : '_No projects yet._'
    )

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('projects_add').setLabel('Add project').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('projects_link_repo').setLabel('Link repo').setStyle(ButtonStyle.Secondary)
  )

  return { embeds: [embed], components: [row], content: null }
}

export async function execute(interaction) {
  if (!interaction.guild) return interaction.editReply({ content: 'Use this in a server.' })
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  return interaction.editReply(await listPayload(cfg)).catch(() => {})
}

export async function handleAddButton(interaction) {
  const modal = new ModalBuilder().setCustomId('projects_add_modal').setTitle('Add project')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Project name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('slug')
        .setLabel('Docs folder under docs/projects/ (optional)')
        .setPlaceholder('leave blank to derive from the name')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('paths')
        .setLabel('Extra doc paths, comma separated (optional)')
        .setPlaceholder('hms-documentation')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
    )
  )
  return interaction.showModal(modal).catch(() => {})
}

/**
 * The Add project modal. The project row is written first and is the source of
 * truth; its private section (role, category, channels, members panel) is then
 * built through the same one-project routine `/project-setup` runs. A section
 * that cannot be built never rolls the row back and never throws out of here:
 * the reply says so and points at `/project-setup`.
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction deferred by the router
 * @param {{db?: object, getConfig?: Function, reattribute?: typeof reattributeGuildDocs, setup?: typeof setupOneProject}} [deps]
 */
export async function handleAddModal(
  interaction,
  {
    db: dbArg = db,
    getConfig = getOrCreateGuildConfig,
    reattribute = reattributeGuildDocs,
    setup = setupOneProject,
  } = {}
) {
  const guild = interaction.guild
  if (!guild) return
  // The router defers every modal but a named few. A section build is a dozen
  // Discord calls and a modal must be acknowledged within three seconds, so
  // make sure of it here rather than trusting the router's list forever.
  if (!interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferReply({ flags: EPHEMERAL })
    } catch (e) {
      console.error('[projects] deferReply:', e?.message ?? e)
      return
    }
  }
  const cfg = await getConfig(guild.id)
  const name = interaction.fields.getTextInputValue('name').trim()
  const slug = (interaction.fields.getTextInputValue('slug') || '').trim() || slugify(name)
  const paths = (interaction.fields.getTextInputValue('paths') || '')
    .split(',')
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)

  const existing = await dbArg.project.findByName({ guildConfigId: cfg.id, name })
  if (existing) {
    return interaction.editReply({ content: `**${name}** already exists.` }).catch(() => {})
  }

  const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
  // Against the EFFECTIVE slug, not the stored column. A legacy project with a
  // NULL `docsSlug` still occupies `slugify(name)` — that is what its ten
  // section channels are named after — so comparing `p.docsSlug` lets `UBS-Doc`
  // in beside a NULL-slugged `UBS Doc`, and then each `/project-setup` run
  // drags the same ten channels into whichever category ran last.
  const slugConflict = projects.find((p) => projectSlug(p) === slug)
  if (slugConflict) {
    return interaction
      .editReply({ content: `Docs folder \`${slug}\` is already used by **${slugConflict.name}** — pick another slug.` })
      .catch(() => {})
  }

  const project = await dbArg.project.create({
    data: { guildConfigId: cfg.id, name, docsSlug: slug, docsPaths: paths },
  })

  // Already-mirrored pages match this project by path prefix, and nothing about
  // the repository changed, so a sync would short-circuit and never notice.
  // Re-run attribution here instead — it is a read of the index plus one write
  // per page that actually moved.
  const attributed = await reattribute(cfg.id).catch(() => 0)
  const note = attributed
    ? ` **${attributed}** already-synced page(s) now appear under it in **/docs**.`
    : ' No synced pages match those paths yet — they will be attributed as the documentation repository grows, or run **/setup** → **Sync docs now**.'
  const added = `Added **${name}** (docs folder \`docs/projects/${slug}/\`${paths.length ? `, plus ${paths.map((p) => `\`${p}\``).join(', ')}` : ''}).${note}`

  // Say the project exists before the build starts: the row is already the
  // truth, and the build is the slow part.
  await interaction.editReply({ content: `${added}\n\nBuilding its private section…` }).catch(() => {})

  const later = `You can create it later with **/project-setup project:${cut(name, 80)}** once the bot has **Manage Channels** and **Manage Roles**.`
  let section
  if (!project?.id) {
    section = `Its private section was not built: the new project could not be read back. ${later}`
  } else {
    try {
      const { block, result } = await setup(guild, project, {
        db: dbArg,
        cfg,
        botUserId: interaction.client?.user?.id ?? null,
      })
      section = result?.category?.name
        ? `Its private section is ready in **${result.category.name}**.\n${block}`
        : `Its private section could not be built. ${later}\n${block}`
    } catch (e) {
      console.error(`[projects] section for ${name}:`, e)
      section = `Its private section could not be built: ${e?.message ?? String(e)}. ${later}`
    }
  }

  return interaction.editReply({ content: cut(`${added}\n\n${section}`, REPLY_LIMIT) }).catch(() => {})
}

export async function handleLinkRepo(interaction) {
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
  if (repos.length === 0) {
    return interaction.editReply({ content: 'No repositories yet — add one with **/repos**.', components: [] }).catch(() => {})
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('projects_link_repo_select')
    .setPlaceholder('Choose a repository…')
    .addOptions(
      repos.slice(0, 25).map((r) => ({
        label: (r.name || '').slice(0, 100),
        value: r.id,
        description: (r.url || '').slice(0, 100),
      }))
    )
  return interaction
    .editReply({ content: 'Which repository?', embeds: [], components: [new ActionRowBuilder().addComponents(select)] })
    .catch(() => {})
}

export async function handleLinkRepoSelect(interaction) {
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  flowStore.set(interaction.user.id, interaction.guild.id, 'projects_link', { repositoryId: interaction.values[0] })
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  if (projects.length === 0) {
    return interaction.editReply({ content: 'No projects yet — add one first.', components: [] }).catch(() => {})
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('projects_link_project_select')
    .setPlaceholder('Choose a project…')
    .addOptions(projects.slice(0, 25).map((p) => ({ label: p.name.slice(0, 100), value: p.id })))
  return interaction
    .editReply({ content: 'Link it to which project?', components: [new ActionRowBuilder().addComponents(select)] })
    .catch(() => {})
}

export async function handleLinkProjectSelect(interaction) {
  const state = flowStore.get(interaction.user.id, interaction.guild.id, 'projects_link')
  if (!state?.repositoryId) {
    return interaction.editReply({ content: 'That selection expired — start again with /projects.', components: [] }).catch(() => {})
  }
  await db.projectRepos.add({ data: { project_id: interaction.values[0], repository_id: state.repositoryId } })
  flowStore.clear(interaction.user.id, interaction.guild.id, 'projects_link')
  return interaction.editReply({ content: 'Linked.', components: [] }).catch(() => {})
}
