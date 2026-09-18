/**
 * `/create-project-role` — create or repair one project's role, and with it the
 * rest of the project's private section.
 *
 * A project role only means something as its section's gate: a role without
 * its category gates nothing, and the next `/project-setup` would adopt it
 * anyway. So this runs the same one-project routine as `/project-setup`
 * (role, category, channels, role sync) and says so in its reply. It owns
 * nothing of its own beyond finding the project by name and refusing a
 * managed job-role name before anything is touched.
 */
import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { MANAGED_ROLES } from '../utils/roleSync.js'
import { cut } from '../services/projectSection.js'
import { setupOneProject } from './project-setup.js'

const REPLY_LIMIT = 2000

const fold = (s) => String(s ?? '').trim().toLowerCase()
/**
 * What this database already treats as one name: `utf8mb4_general_ci` ignores
 * case and accents alike, so `Éclair` and `Eclair` are the same row to it.
 * Kept separate from `fold` on purpose — the managed-role check must not start
 * refusing `Désign` because a job role is called `Design`.
 */
const loose = (s) => fold(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const MANAGED_FOLDED = new Set(MANAGED_ROLES.map(fold))

export const data = new SlashCommandBuilder()
  .setName('create-project-role')
  .setDescription("Create or repair a project's role and its private section (same as /project-setup)")
  .addStringOption((o) =>
    o.setName('project').setDescription('Project name (e.g. Fittour)').setRequired(true).setMaxLength(100)
  )

/**
 * The project row whose name matches, exactly first, then ignoring case.
 *
 * The full sweep runs BEFORE `findByName` is trusted, not after it comes back
 * empty. `project.findByName` is a plain `name = ?` and this database's tables
 * are `utf8mb4_general_ci`, which ignores case AND accents, so the "exact"
 * step can match several rows and `queryOne` hands back an arbitrary one of
 * them. This command creates a role and opens a private section, so picking a
 * project by coin toss is not an option: say the name is ambiguous instead.
 *
 * @returns {Promise<{project: object|null, ambiguous?: string[]}>}
 */
async function findProject(dbArg, cfg, name) {
  const rows = (await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })) ?? []
  const matches = rows.filter((p) => loose(p?.name) === loose(name))
  // Two projects the database cannot tell apart: naming one would be a guess.
  if (matches.length > 1) return { project: null, ambiguous: matches.map((p) => String(p?.name ?? p?.id)) }
  if (matches.length === 1) return { project: matches[0] }
  const exact = await dbArg.project.findByName({ guildConfigId: cfg.id, name })
  return { project: exact ?? null }
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction already deferred
 * @param {{db?: object, getConfig?: Function, setup?: typeof setupOneProject}} [deps]
 */
export async function execute(
  interaction,
  { db: dbArg = db, getConfig = getOrCreateGuildConfig, setup = setupOneProject } = {}
) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const projectName = String(interaction.options.getString('project') ?? '').trim()
  if (!projectName) return interaction.editReply({ content: 'Project name is required.' })

  // Refused before anything is read or created: a managed job role is handed
  // out by the bot for a job, and gating a project on it would open the
  // section to everyone who holds that job.
  if (MANAGED_FOLDED.has(fold(projectName))) {
    return interaction.editReply({
      content: `**${cut(projectName, 100)}** is a managed job role the bot assigns, so it cannot be a project role. Nothing was created.`,
    })
  }

  const cfg = await getConfig(guild.id)
  const { project, ambiguous } = await findProject(dbArg, cfg, projectName)
  if (ambiguous) {
    return interaction.editReply({
      content: cut(
        `**${cut(projectName, 100)}** is ambiguous — ${ambiguous.length} projects in this server go by that name (${ambiguous.map((n) => `**${cut(n, 60)}**`).join(', ')}), and picking one of them would be a guess. Nothing was created. Rename one of them in **/projects**, then run this again.`,
        REPLY_LIMIT
      ),
    })
  }
  if (!project) {
    return interaction.editReply({
      content: `No project named **${cut(projectName, 100)}**. Add it with **/projects** → Add project — a new project gets its role and private section straight away.`,
    })
  }

  try {
    const { block, result, refused } = await setup(guild, project, {
      db: dbArg,
      cfg,
      botUserId: interaction.client?.user?.id ?? null,
    })
    const role = result?.role?.name ? `**${result.role.name}**` : 'the project role'
    // A refusal is not a failure: nothing was touched, permissions are not the
    // problem, and running it again refuses identically until a human acts.
    const head = result?.category
      ? `This does more than create a role: ${role} gates **${project.name}**'s private section, so the section's category and channels were created or repaired too.`
      : refused
        ? `This does more than create a role: it creates or repairs **${project.name}**'s whole private section. Nothing was created or changed — the run was refused, for the reason below, and it will be refused the same way until that is resolved.`
        : `This does more than create a role: it creates or repairs **${project.name}**'s whole private section. The section's category could not be built — see below, and run **/project-setup** once the bot has **Manage Channels** and **Manage Roles**.`
    return interaction.editReply({ content: cut(`${head}\n\n${block}`, REPLY_LIMIT) })
  } catch (e) {
    console.error('[create-project-role]', e)
    return interaction.editReply({
      content: cut(
        `Could not set up **${project.name}**: ${e?.message ?? String(e)}. Ensure the bot has **Manage Roles** and **Manage Channels**, then run **/project-setup**.`,
        REPLY_LIMIT
      ),
    })
  }
}
