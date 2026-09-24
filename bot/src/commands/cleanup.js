import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
} from "discord.js";
import {
  CATEGORY_ONBOARDING,
  CHANNEL_ONBOARDING,
  CATEGORY_RULES,
  CHANNEL_RULES,
  CATEGORY_DOCUMENTATION,
  CHANNEL_DOCUMENTATION,
  CATEGORY_MEETINGS,
  CHANNEL_MEETINGS_TEXT,
  CHANNEL_MEETINGS_VOICE,
  CHANNEL_UPCOMING_MEETINGS,
  CATEGORY_CASUAL,
  CHANNEL_CASUAL_CHAT,
  CHANNEL_OFF_TOPIC,
  CHANNEL_VOICE_LOUNGE,
  CATEGORY_PET_PICS,
  CHANNEL_PET_PICS,
  CATEGORY_FOODIE,
  CHANNEL_FOODIE_BLOG,
  CATEGORY_ARCHIVE,
  CHANNEL_ARCHIVE_METADATA,
  CHANNEL_ARCHIVE_SQL,
  CATEGORY_ANNOUNCEMENTS,
  CHANNEL_ANNOUNCEMENTS_ALL,
  CHANNEL_ANNOUNCEMENTS_VERIFIED,
  CHANNEL_ANNOUNCEMENTS_LEADERSHIP,
  CHANNEL_ADMIN,
  CATEGORY_FRONTEND,
  CHANNEL_FRONTEND_CHAT,
  CHANNEL_FRONTEND_VOICE,
  CATEGORY_BACKEND,
  CHANNEL_BACKEND_CHAT,
  CHANNEL_BACKEND_VOICE,
  CATEGORY_DATABASE,
  CHANNEL_DATABASE_CHAT,
  CHANNEL_DATABASE_VOICE,
  CATEGORY_COMMAND_CHANNELS,
  CHANNEL_BARE_TEXT,
  CHANNEL_BARE_VOICE,
  CATEGORY_BOLD_NAMES,
} from "../constants.js";
import { getDedicatedChannelCommands } from "../config/commands.js";
import { claimedSectionIds } from "../services/projectSection.js";
import db, { getOrCreateGuildConfig } from "../db/index.js";

// All channel names that /init creates (lowercased for matching)
function getProtectedChannelNames() {
  const names = new Set([
    CHANNEL_ONBOARDING,
    CHANNEL_RULES,
    CHANNEL_DOCUMENTATION,
    CHANNEL_MEETINGS_TEXT,
    CHANNEL_MEETINGS_VOICE,
    CHANNEL_UPCOMING_MEETINGS,
    CHANNEL_CASUAL_CHAT,
    CHANNEL_OFF_TOPIC,
    CHANNEL_VOICE_LOUNGE,
    CHANNEL_PET_PICS,
    CHANNEL_FOODIE_BLOG,
    CHANNEL_ARCHIVE_METADATA,
    CHANNEL_ARCHIVE_SQL,
    CHANNEL_ANNOUNCEMENTS_ALL,
    CHANNEL_ANNOUNCEMENTS_VERIFIED,
    CHANNEL_ANNOUNCEMENTS_LEADERSHIP,
    CHANNEL_ADMIN,
    CHANNEL_FRONTEND_CHAT,
    CHANNEL_FRONTEND_VOICE,
    CHANNEL_BACKEND_CHAT,
    CHANNEL_BACKEND_VOICE,
    CHANNEL_DATABASE_CHAT,
    CHANNEL_DATABASE_VOICE,
    CHANNEL_BARE_TEXT,
    CHANNEL_BARE_VOICE,
  ].map((n) => n.toLowerCase()));

  // Add cmd-* dedicated channels
  for (const cmd of getDedicatedChannelCommands()) {
    names.add(`cmd-${cmd}`);
  }

  return names;
}

// All category names that /init creates (including bold variants from /migrate)
function getProtectedCategoryNames() {
  const names = new Set([
    CATEGORY_ONBOARDING,
    CATEGORY_RULES,
    CATEGORY_DOCUMENTATION,
    CATEGORY_MEETINGS,
    CATEGORY_CASUAL,
    CATEGORY_PET_PICS,
    CATEGORY_FOODIE,
    CATEGORY_ARCHIVE,
    CATEGORY_ANNOUNCEMENTS,
    CATEGORY_FRONTEND,
    CATEGORY_BACKEND,
    CATEGORY_DATABASE,
    CATEGORY_COMMAND_CHANNELS,
  ].map((n) => n.toLowerCase()));

  // Also protect bold/renamed variants from /migrate
  for (const name of Object.values(CATEGORY_BOLD_NAMES)) {
    names.add(name.toLowerCase());
  }

  return names;
}

export const data = new SlashCommandBuilder()
  .setName("cleanup")
  .setDescription("(CEO/Server Manager) Remove leftover channels not created by /init");

// Store pending cleanup per guild
const pendingCleanups = new Map();

/**
 * A project's section, by ID — the only protection that actually holds.
 *
 * The name rule below it cannot: `categoryNameFor` renders `📂 <NAME>` and
 * this command lowercases, strips leading non-word characters and compares to
 * the project name, which fails for `(Legacy) App` (→ `legacy) app`),
 * `[Client] Portal`, `.NET Rewrite`, `#1 Client`, `Éclair` (JS `\w` has no
 * `u` flag, so the accent is stripped too → `clair`), `Ünité`, `日本 Portal`,
 * `Straße` (upper-casing then lower-casing is not a round trip), any name past
 * ~97 characters (the category name is cut at 100 and the modal sets no
 * maximum) and any category an operator renamed by hand — which the planner
 * still treats as ours, because IT looks the category up by id. For every one
 * of those the whole section, its ten channels and every task channel moved
 * into it, was listed for deletion behind the confirm button.
 *
 * So: the recorded category ids, and the recorded section channel ids
 * (`claimedSectionIds` — the same set the planner refuses to adopt), and then
 * anything whose parent is one of those categories. This is spec §6's by-id
 * principle, the one the rest of the branch runs on. The name rule stays for
 * categories that predate the recorded ids.
 */
function projectSectionGuards(projects) {
  const rows = projects ?? [];
  return {
    // The category itself and its ten channels, wherever they currently sit.
    sectionIds: claimedSectionIds(rows, null),
    // Everything living in a project category: its task channels, and the
    // meeting pairs `/meeting-channel` creates inside a section.
    categoryIds: new Set(rows.map((p) => p?.discordCategoryId).filter(Boolean)),
    names: new Set(rows.map((p) => (p?.name || "").toLowerCase())),
  };
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction already deferred
 * @param {{db?: object, getConfig?: (guildId: string) => Promise<{id: string}>}} [deps]
 */
export async function execute(
  interaction,
  { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {},
) {
  const guild = interaction.guild;
  if (!guild)
    return interaction.editReply({ content: "Use this in a server." });

  const cfg = await getConfig(guild.id);
  const protectedChannels = getProtectedChannelNames();
  const protectedCategories = getProtectedCategoryNames();

  // Get user-created channels from DB (protected from cleanup)
  let userCreatedIds = new Set();
  try {
    const userChannels = await dbArg.userChannel.findMany({
      where: { guildConfigId: cfg.id },
    });
    for (const uc of userChannels || []) {
      if (uc.voiceChannelId) userCreatedIds.add(uc.voiceChannelId);
      if (uc.textChannelId) userCreatedIds.add(uc.textChannelId);
    }
  } catch (_) {
    // Table might not exist yet
  }

  // The project rows ARE the protection. A read that fails used to come back
  // as `[]`, which does not mean "no projects" — it means every project
  // section in the guild was about to be offered up for deletion.
  let projects;
  try {
    projects = (await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })) ?? [];
  } catch (e) {
    console.error("[cleanup] project read failed:", e);
    return interaction.editReply({
      content:
        "I could not read this server's projects, and their sections are exactly what a cleanup has to leave alone. Nothing was listed. Try again in a moment.",
    });
  }
  const section = projectSectionGuards(projects);

  const channels = await guild.channels.fetch();
  // The global support pair, by id, and whatever category holds it.
  const supportIds = new Set([cfg?.supportChannelId, cfg?.supportVoiceChannelId].filter(Boolean));
  const supportCategoryIds = new Set(
    [...supportIds].map((id) => channels.get(id)?.parentId ?? channels.get(id)?.parent?.id).filter(Boolean),
  );
  const toDelete = [];

  for (const [, ch] of channels) {
    if (!ch) continue;
    if (userCreatedIds.has(ch.id)) continue;
    // By id, before any name is looked at.
    if (section.sectionIds.has(ch.id)) continue;
    const parentId = ch.parentId ?? ch.parent?.id ?? null;
    if (supportIds.has(ch.id) || supportCategoryIds.has(ch.id)) continue;
    if (parentId && supportCategoryIds.has(parentId)) continue;
    const inProjectSection = Boolean(parentId) && section.categoryIds.has(parentId);
    if (inProjectSection) continue;

    const name = ch.name.toLowerCase();

    if (ch.type === ChannelType.GuildCategory) {
      if (protectedCategories.has(name)) continue;
      // Protect project categories
      if (section.names.has(name)) continue;
      // Check if it's a project category with emoji prefix
      const stripped = name.replace(/^[^\w]+/, "").trim();
      if (section.names.has(stripped)) continue;
      continue; // Don't delete categories directly — only their orphan channels
    }

    // Check if channel is under a protected category
    const parentName = ch.parent?.name?.toLowerCase() || "";
    const isUnderProtectedCategory =
      protectedCategories.has(parentName) ||
      section.names.has(parentName) ||
      section.names.has(parentName.replace(/^[^\w]+/, "").trim());

    if (protectedChannels.has(name) && isUnderProtectedCategory) continue;

    // Leftover meeting channels (meet-*), orphan text/voice not from init
    if (
      name.startsWith("meet-") ||
      (name.endsWith("-chat") && name.startsWith("meet-"))
    ) {
      toDelete.push(ch);
    } else if (!isUnderProtectedCategory && !protectedChannels.has(name)) {
      toDelete.push(ch);
    }
  }

  if (toDelete.length === 0) {
    return interaction.editReply({
      content: "No leftover channels found. Everything looks clean.",
    });
  }

  const list = toDelete
    .slice(0, 25)
    .map((ch) => {
      const type = ch.type === ChannelType.GuildVoice ? "voice" : "text";
      const parent = ch.parent?.name || "no category";
      return `- #${ch.name} (${type}, under ${parent})`;
    })
    .join("\n");

  const remaining = toDelete.length > 25 ? `\n_… and ${toDelete.length - 25} more_` : "";

  pendingCleanups.set(guild.id, toDelete.map((ch) => ch.id));

  const embed = new EmbedBuilder()
    .setTitle("Cleanup — Channels to Remove")
    .setDescription(
      `Found **${toDelete.length}** channel(s) to remove:\n\n${list}${remaining}\n\nUser-created channels (from /create-channel) will NOT be removed.`,
    )
    .setColor(0xed4245)
    .setFooter({ text: "This cannot be undone" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("cleanup_confirm")
      .setLabel(`Delete ${toDelete.length} channel(s)`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("cleanup_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

export async function handleConfirm(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const channelIds = pendingCleanups.get(guild.id);
  pendingCleanups.delete(guild.id);

  if (!channelIds || channelIds.length === 0) {
    return interaction.editReply({
      content: "Nothing to clean up.",
      embeds: [],
      components: [],
    });
  }

  let deleted = 0;
  let failed = 0;

  for (const id of channelIds) {
    try {
      const ch = await guild.channels.fetch(id).catch(() => null);
      if (ch) {
        await ch.delete("Cleanup command");
        deleted++;
      }
    } catch (_) {
      failed++;
    }
  }

  await interaction.editReply({
    content: `Cleanup complete. Deleted **${deleted}** channel(s).${failed ? ` Failed: ${failed}.` : ""}`,
    embeds: [],
    components: [],
  });
}

export async function handleCancel(interaction) {
  const guild = interaction.guild;
  if (guild) pendingCleanups.delete(guild.id);
  await interaction.editReply({
    content: "Cleanup cancelled.",
    embeds: [],
    components: [],
  });
}
