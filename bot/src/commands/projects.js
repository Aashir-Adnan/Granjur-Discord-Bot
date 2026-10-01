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
import { SCOPE_CHOICES, scopeLabel } from '../utils/taskScope.js'
import { linkRepo, unlinkRepo, linkRefusalText, accessLine, linkUpdatedText } from '../services/projectRepoLinks.js'
import { checkRepoAccess } from '../services/github.js'
import { DELETED_NAME_HELD, DELETED_SLUG_HELD, PROJECT_DELETED, isDeletedProject } from '../utils/projectDeleted.js'
import { deleteProject, reactivateProject, deleteReply, reactivateReply } from '../services/projectLifecycle.js'
import { canUseCommand, commandRefusal } from '../config/commands.js'

const NO_SCOPE_VALUE = 'none'

/** Discord's hard limit on a message. */
const REPLY_LIMIT = 2000

/** Discord's hard limit on an embed field's value. */
const FIELD_LIMIT = 1024

/** `/projects` → Delete: the confirm name was not the project's. */
export const NAME_MISMATCH = 'The name does not match — nothing was deleted.'

export const data = new SlashCommandBuilder()
  .setName('projects')
  .setDescription('(CEO/Server Manager) List, add, delete or reactivate projects; link a repo')

export async function listPayload(cfg, { db: dbArg = db } = {}) {
  // Every project, soft-deleted ones included; the list below shows the live ones.
  const all = await dbArg.project.findMany({ where: { guildConfigId: cfg.id, includeDeleted: true } })
  const projects = all.filter((p) => !isDeletedProject(p))
  const counts = await dbArg.docPage.countsByProject({ guildConfigId: cfg.id })
  const byId = new Map(counts.map((c) => [c.projectId, Number(c.n)]))

  const deleted = all.filter((p) => isDeletedProject(p))

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
  if (deleted.length) {
    embed.addFields({
      name: 'Deleted',
      value: cut(deleted.map((p) => `**${p.name}**${deletedOn(p)}`).join('\n'), FIELD_LIMIT),
    })
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('projects_add').setLabel('Add project').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('projects_link_repo').setLabel('Link repo').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('projects_unlink_repo').setLabel('Unlink repo').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('projects_delete').setLabel('Delete project').setStyle(ButtonStyle.Danger)
  )
  if (deleted.length) {
    row.addComponents(
      new ButtonBuilder().setCustomId('projects_reactivate').setLabel('Reactivate project').setStyle(ButtonStyle.Success)
    )
  }

  return { embeds: [embed], components: [row], content: null }
}

/** ` — deleted <date>` for the Deleted section, or nothing when the date cannot be read. */
function deletedOn(project) {
  const t = new Date(project?.deletedAt).getTime()
  return Number.isFinite(t) ? ` — deleted <t:${Math.floor(t / 1000)}:d>` : ''
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
  // `slugify`, never the raw field. A slug typed as `UBS Doc` is stored raw,
  // slips past the effective-slug conflict check below AND `/project-setup`'s
  // §13 duplicate-slug refusal, and then `channelNameFor` builds
  // `UBS Doc-members`, which Discord normalises server-side — so the name
  // fallback never matches what was created and ten fresh channels appear on
  // every run. One call here is the whole fix.
  const slug = slugify((interaction.fields.getTextInputValue('slug') || '').trim()) || slugify(name)
  const paths = (interaction.fields.getTextInputValue('paths') || '')
    .split(',')
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)

  // `findByName` returns a soft-deleted project too: its name stays reserved.
  const existing = await dbArg.project.findByName({ guildConfigId: cfg.id, name })
  if (existing) {
    const content = isDeletedProject(existing) ? DELETED_NAME_HELD : `**${name}** already exists.`
    return interaction.editReply({ content }).catch(() => {})
  }

  // Deleted projects included: a deleted project's slug stays reserved too.
  const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id, includeDeleted: true } })
  // Against the EFFECTIVE slug, not the stored column. A legacy project with a
  // NULL `docsSlug` still occupies `slugify(name)` — that is what its ten
  // section channels are named after — so comparing `p.docsSlug` lets `UBS-Doc`
  // in beside a NULL-slugged `UBS Doc`, and then each `/project-setup` run
  // drags the same ten channels into whichever category ran last.
  const slugConflict = projects.find((p) => projectSlug(p) === slug)
  if (slugConflict && isDeletedProject(slugConflict)) {
    return interaction.editReply({ content: DELETED_SLUG_HELD }).catch(() => {})
  }
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

  // `project:` takes an id from its own autocomplete, so telling the operator
  // to type the name would earn them "No project matches". Name the option and
  // send them to its suggestions instead.
  const later = `You can create it later with **/project-setup** — pick **${cut(name, 80)}** from the **project:** option's suggestions — once the bot has **Manage Channels** and **Manage Roles**.`
  let section
  if (!project?.id) {
    section = `Its private section was not built: the new project could not be read back. ${later}`
  } else {
    try {
      const { block, result, refused } = await setup(guild, project, {
        db: dbArg,
        cfg,
        botUserId: interaction.client?.user?.id ?? null,
      })
      // A refusal is not a permissions failure, and `later` would send the
      // operator to grant permissions that are already there.
      section = result?.category?.name
        ? `Its private section is ready in **${result.category.name}**.\n${block}`
        : refused
          ? `Its private section was not built: the run was refused for the reason below, nothing was changed, and re-running refuses the same way until that is resolved.\n${block}`
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
  flowStore.set(interaction.user.id, interaction.guild.id, 'projects_link', {
    ...state,
    projectId: interaction.values[0],
  })
  const select = new StringSelectMenuBuilder()
    .setCustomId('projects_link_scope_select')
    .setPlaceholder('Choose a scope…')
    .addOptions([
      ...SCOPE_CHOICES.map((c) => ({ label: c.name, value: c.value })),
      { label: 'No scope', value: NO_SCOPE_VALUE },
    ])
  return interaction
    .editReply({ content: 'As which scope?', components: [new ActionRowBuilder().addComponents(select)] })
    .catch(() => {})
}

export async function handleLinkScopeSelect(interaction) {
  const state = flowStore.get(interaction.user.id, interaction.guild.id, 'projects_link')
  if (!state?.repositoryId || !state?.projectId) {
    return interaction.editReply({ content: 'That selection expired — start again with /projects.', components: [] }).catch(() => {})
  }
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  const scope = interaction.values[0] === NO_SCOPE_VALUE ? null : interaction.values[0]
  // Picked before it was soft-deleted: the select hides it now, but this flow carries its id.
  if (isDeletedProject(await db.project.findFirst({ where: { id: state.projectId } }))) {
    flowStore.clear(interaction.user.id, interaction.guild.id, 'projects_link')
    return interaction.editReply({ content: PROJECT_DELETED, components: [] }).catch(() => {})
  }
  const result = await linkRepo({ db, projectId: state.projectId, repositoryId: state.repositoryId, scope })
  flowStore.clear(interaction.user.id, interaction.guild.id, 'projects_link')

  const [repo, project] = await Promise.all([
    db.repository.findFirst({ where: { id: state.repositoryId, guildConfigId: cfg.id } }),
    db.project.findFirst({ where: { id: state.projectId } }),
  ])

  if (!result.ok) {
    const holder = await db.repository.findFirst({ where: { id: result.holderRepositoryId, guildConfigId: cfg.id } })
    return interaction
      .editReply({
        content: linkRefusalText(project?.name ?? 'That project', holder?.name ?? 'another repository', scope),
        components: [],
      })
      .catch(() => {})
  }

  const scopeText = scope ? scopeLabel(scope) : 'no scope'
  const headline = result.updated
    ? linkUpdatedText(repo?.name ?? 'the repository', project?.name ?? 'the project', scope)
    : `Linked **${repo?.name ?? 'the repository'}** to **${project?.name ?? 'the project'}** as ${scopeText}.`
  const access = await checkRepoAccess(repo?.url)
  return interaction
    .editReply({ content: `${headline}\n\n${accessLine({ ...access, url: repo?.url })}`, components: [] })
    .catch(() => {})
}

export async function handleUnlinkRepo(interaction) {
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  if (projects.length === 0) {
    return interaction.editReply({ content: 'No projects yet — add one first.', components: [] }).catch(() => {})
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('projects_unlink_project_select')
    .setPlaceholder('Choose a project…')
    .addOptions(projects.slice(0, 25).map((p) => ({ label: p.name.slice(0, 100), value: p.id })))
  return interaction
    .editReply({
      content: 'Unlink a repository from which project?',
      embeds: [],
      components: [new ActionRowBuilder().addComponents(select)],
    })
    .catch(() => {})
}

export async function handleUnlinkProjectSelect(interaction) {
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  const projectId = interaction.values[0]
  const project = await db.project.findFirst({ where: { id: projectId } })
  const links = await db.projectRepos.findMany({ where: { project_id: projectId } })
  if (!links.length) {
    return interaction
      .editReply({ content: `**${project?.name ?? 'That project'}** has no linked repositories.`, components: [] })
      .catch(() => {})
  }
  const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
  const byId = new Map(repos.map((r) => [String(r.id), r]))
  flowStore.set(interaction.user.id, interaction.guild.id, 'projects_unlink', {
    projectId,
    projectName: project?.name ?? 'That project',
  })
  const select = new StringSelectMenuBuilder()
    .setCustomId('projects_unlink_repo_select')
    .setPlaceholder('Choose a repository…')
    .addOptions(
      links.slice(0, 25).map((l) => {
        const repo = byId.get(String(l.repository_id))
        const scopeText = l.scope ? scopeLabel(l.scope) : 'no scope'
        return {
          label: `${(repo?.name || 'Unknown repository').slice(0, 90)} · ${scopeText}`.slice(0, 100),
          value: l.repository_id,
        }
      })
    )
  return interaction
    .editReply({
      content: `Unlink which repository from **${project?.name ?? 'that project'}**?`,
      components: [new ActionRowBuilder().addComponents(select)],
    })
    .catch(() => {})
}

export async function handleUnlinkRepoSelect(interaction) {
  const state = flowStore.get(interaction.user.id, interaction.guild.id, 'projects_unlink')
  if (!state?.projectId) {
    return interaction.editReply({ content: 'That selection expired — start again with /projects.', components: [] }).catch(() => {})
  }
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  const repositoryId = interaction.values[0]
  const repo = await db.repository.findFirst({ where: { id: repositoryId, guildConfigId: cfg.id } })
  await unlinkRepo({ db, projectId: state.projectId, repositoryId })
  flowStore.clear(interaction.user.id, interaction.guild.id, 'projects_unlink')
  return interaction
    .editReply({ content: `Unlinked **${repo?.name ?? 'the repository'}** from **${state.projectName}**.`, components: [] })
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// Delete project / Reactivate project (services/projectLifecycle.js does the work)
// ---------------------------------------------------------------------------

/**
 * The router defers these (`deferUpdate` for a button or select, `deferReply`
 * for a modal); make sure of it here too, because what follows can be dozens
 * of Discord calls and the token only outlives them once acknowledged.
 */
async function acknowledge(interaction, how) {
  if (interaction.deferred || interaction.replied) return true
  try {
    if (how === 'update') await interaction.deferUpdate()
    else await interaction.deferReply({ flags: EPHEMERAL })
    return true
  } catch (e) {
    console.error('[projects] defer:', e?.message ?? e)
    return false
  }
}

const fold = (s) => String(s ?? '').trim().toLowerCase()

/** The project id a `<prefix>:<id>` custom id carries. */
const idFrom = (customId) => String(customId || '').split(':')[1] || ''

/** The guild's project with this id, deleted or not; null when it is not this guild's. */
async function projectOf(dbArg, cfg, projectId) {
  if (!projectId) return null
  const project = await dbArg.project.findFirst({ where: { id: projectId } })
  return project && String(project.guildConfigId) === String(cfg.id) ? project : null
}

/** Discord's limit on a select's options. */
const SELECT_LIMIT = 25

/**
 * A project picker's options (the first 25 by name) and the line that says how
 * many more there are, empty when all fit.
 */
function projectPicker(projects) {
  const sorted = [...projects].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const hidden = sorted.length - SELECT_LIMIT
  return {
    options: sorted.slice(0, SELECT_LIMIT).map((p) => ({ label: p.name.slice(0, 100), value: p.id })),
    note: hidden > 0 ? `\nShowing the first ${SELECT_LIMIT} by name — ${hidden} more not listed.` : '',
  }
}

/** The refusal while another delete or reactivate of the same project is running. */
export const PROJECT_BUSY = 'This project is being changed — try again in a minute.'

/**
 * Project ids with a delete or reactivate in flight, in this process. Held for
 * the whole operation, so a Reactivate pressed while a Delete is still
 * archiving (or two confirm-name submits) cannot overlap.
 */
const busy = new Set()

/**
 * The `/projects` role gate again, for the two steps that delete or rebuild. A
 * button or modal outlives the command that showed it (a message can be
 * forwarded, a member's role taken away since), and the router gates commands,
 * not components. Same rule and same refusal as the command gate; no member to
 * check is a refusal, never a pass.
 */
async function mayRunProjects(interaction, cfg) {
  const guild = interaction.guild
  const userId = interaction.user?.id
  const member = interaction.member?.roles
    ? interaction.member
    : (guild.members?.cache?.get?.(userId) ?? (await Promise.resolve(guild.members?.fetch?.(userId)).catch(() => null)))
  return Boolean(member) && canUseCommand(member, 'projects', { clientRoleId: cfg?.clientRoleId ?? null })
}

/** Run `fn` holding the project's lock; null (and nothing run) when it is held. */
async function withProjectLock(projectId, fn) {
  if (busy.has(projectId)) return null
  busy.add(projectId)
  try {
    return { value: await fn() }
  } finally {
    busy.delete(projectId)
  }
}

/**
 * What a delete does, said before the project is picked. The section channels
 * are deleted with their messages and pins, so it must not promise they come back.
 */
export const DELETE_PROMPT =
  'Deleting hides the project and its tasks and archives task channels. Its section channels (members, docs, chat, voice…) are deleted with their messages — Reactivate rebuilds them empty.'

/** `/projects` → Delete project: a select of the live projects. */
export async function handleDeleteButton(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  if (!interaction.guild || !(await acknowledge(interaction, 'update'))) return
  const cfg = await getConfig(interaction.guild.id)
  // The default read hides deleted projects.
  const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
  if (!projects.length) {
    return interaction.editReply({ content: 'No projects to delete.', embeds: [], components: [] }).catch(() => {})
  }
  const { options, note } = projectPicker(projects)
  const select = new StringSelectMenuBuilder()
    .setCustomId('projects_delete_select')
    .setPlaceholder('Choose a project to delete…')
    .addOptions(options)
  return interaction
    .editReply({
      content: `Delete which project? ${DELETE_PROMPT}${note}`,
      embeds: [],
      components: [new ActionRowBuilder().addComponents(select)],
    })
    .catch(() => {})
}

/**
 * The project picked: a modal asking for its name. The modal IS the answer to
 * this select, so the router must not defer it (`projects_delete_select` is in
 * `noDeferComponentIds`), and nothing is read first.
 */
export async function handleDeleteSelect(interaction) {
  const projectId = interaction.values?.[0]
  if (!projectId) return
  const modal = new ModalBuilder().setCustomId(`projects_delete_modal:${projectId}`).setTitle('Delete project')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Type the project name to confirm')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    )
  )
  return interaction.showModal(modal).catch((e) => console.error('[projects] delete modal:', e?.message ?? e))
}

/**
 * The confirm-name modal. A name that is not the project's (case and outer
 * spaces aside) deletes nothing.
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {{db?: object, getConfig?: Function, remove?: typeof deleteProject}} [deps]
 */
export async function handleDeleteModal(
  interaction,
  { db: dbArg = db, getConfig = getOrCreateGuildConfig, remove = deleteProject } = {}
) {
  const guild = interaction.guild
  if (!guild || !(await acknowledge(interaction, 'reply'))) return
  const say = (content) => interaction.editReply({ content: cut(content, REPLY_LIMIT) }).catch(() => {})
  const cfg = await getConfig(guild.id)
  if (!(await mayRunProjects(interaction, cfg))) return say(commandRefusal('projects'))
  const projectId = idFrom(interaction.customId)
  // Read and checked inside the lock, so the state checked is the state acted on.
  const held = await withProjectLock(projectId, async () => {
    const project = await projectOf(dbArg, cfg, projectId)
    if (!project) return 'That project no longer exists.'
    // Picked before somebody else deleted it: the select hid it, the id did not.
    if (isDeletedProject(project)) return PROJECT_DELETED
    if (fold(interaction.fields.getTextInputValue('name')) !== fold(project.name)) return NAME_MISMATCH
    try {
      const result = await remove({ db: dbArg, guild, cfg, project, actorId: interaction.user?.id ?? null, now: new Date() })
      return deleteReply(project.name, result)
    } catch (e) {
      console.error(`[projects] delete ${project.name}:`, e)
      return `Could not delete **${project.name}**: ${e?.message ?? String(e)}`
    }
  })
  return say(held ? held.value : PROJECT_BUSY)
}

/** `/projects` → Reactivate project: a select of the deleted projects. */
export async function handleReactivateButton(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  if (!interaction.guild || !(await acknowledge(interaction, 'update'))) return
  const cfg = await getConfig(interaction.guild.id)
  const all = await dbArg.project.findMany({ where: { guildConfigId: cfg.id, includeDeleted: true } })
  const deleted = all.filter((p) => isDeletedProject(p))
  if (!deleted.length) {
    return interaction.editReply({ content: 'No deleted projects.', embeds: [], components: [] }).catch(() => {})
  }
  const { options, note } = projectPicker(deleted)
  const select = new StringSelectMenuBuilder()
    .setCustomId('projects_reactivate_select')
    .setPlaceholder('Choose a project to reactivate…')
    .addOptions(options)
  return interaction
    .editReply({ content: `Reactivate which project?${note}`, embeds: [], components: [new ActionRowBuilder().addComponents(select)] })
    .catch(() => {})
}

/** The project picked: one confirm button carrying its id. */
export async function handleReactivateSelect(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  if (!interaction.guild || !(await acknowledge(interaction, 'update'))) return
  const cfg = await getConfig(interaction.guild.id)
  const project = await projectOf(dbArg, cfg, interaction.values?.[0])
  if (!project) {
    return interaction.editReply({ content: 'That project no longer exists.', components: [] }).catch(() => {})
  }
  const confirm = new ButtonBuilder()
    .setCustomId(`projects_reactivate_confirm:${project.id}`)
    .setLabel('Reactivate')
    .setStyle(ButtonStyle.Success)
  return interaction
    .editReply({
      content: `Reactivate **${project.name}**? Its section and role are rebuilt and its task channels come back.`,
      components: [new ActionRowBuilder().addComponents(confirm)],
    })
    .catch(() => {})
}

/**
 * The confirm button.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {{db?: object, getConfig?: Function, reactivate?: typeof reactivateProject}} [deps]
 */
export async function handleReactivateConfirm(
  interaction,
  { db: dbArg = db, getConfig = getOrCreateGuildConfig, reactivate = reactivateProject } = {}
) {
  const guild = interaction.guild
  if (!guild || !(await acknowledge(interaction, 'update'))) return
  const say = (content) =>
    interaction.editReply({ content: cut(content, REPLY_LIMIT), components: [], embeds: [] }).catch(() => {})
  const cfg = await getConfig(guild.id)
  if (!(await mayRunProjects(interaction, cfg))) return say(commandRefusal('projects'))
  const projectId = idFrom(interaction.customId)
  const held = await withProjectLock(projectId, async () => {
    const project = await projectOf(dbArg, cfg, projectId)
    if (!project) return 'That project no longer exists.'
    // Pressed twice, or reactivated by somebody else since the select.
    if (!isDeletedProject(project)) return `**${project.name}** is not deleted.`
    try {
      const result = await reactivate({ db: dbArg, guild, cfg, project, botUserId: interaction.client?.user?.id ?? null })
      return reactivateReply(project.name, result)
    } catch (e) {
      console.error(`[projects] reactivate ${project.name}:`, e)
      return `Could not reactivate **${project.name}**: ${e?.message ?? String(e)}`
    }
  })
  return say(held ? held.value : PROJECT_BUSY)
}
