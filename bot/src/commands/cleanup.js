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

export async function execute(interaction) {
  const guild = interaction.guild;
  if (!guild)
    return interaction.editReply({ content: "Use this in a server." });

  const cfg = await getOrCreateGuildConfig(guild.id);
  const protectedChannels = getProtectedChannelNames();
  const protectedCategories = getProtectedCategoryNames();

  // Get user-created channels from DB (protected from cleanup)
  let userCreatedIds = new Set();
  try {
    const userChannels = await db.userChannel.findMany({
      where: { guildConfigId: cfg.id },
    });
    for (const uc of userChannels || []) {
      if (uc.voiceChannelId) userCreatedIds.add(uc.voiceChannelId);
      if (uc.textChannelId) userCreatedIds.add(uc.textChannelId);
    }
  } catch (_) {
    // Table might not exist yet
  }

  // Also protect project categories (created by /create-project-categories)
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } }).catch(() => []);
  const projectCategoryNames = new Set(
    (projects || []).map((p) => (p.name || "").toLowerCase()),
  );

  const channels = await guild.channels.fetch();
  const toDelete = [];

  for (const [, ch] of channels) {
    if (!ch) continue;
    if (userCreatedIds.has(ch.id)) continue;

    const name = ch.name.toLowerCase();

    if (ch.type === ChannelType.GuildCategory) {
      if (protectedCategories.has(name)) continue;
      // Protect project categories
      if (projectCategoryNames.has(name)) continue;
      // Check if it's a project category with emoji prefix
      const stripped = name.replace(/^[^\w]+/, "").trim();
      if (projectCategoryNames.has(stripped)) continue;
      continue; // Don't delete categories directly — only their orphan channels
    }

    // Check if channel is under a protected category
    const parentName = ch.parent?.name?.toLowerCase() || "";
    const isUnderProtectedCategory =
      protectedCategories.has(parentName) ||
      projectCategoryNames.has(parentName) ||
      projectCategoryNames.has(parentName.replace(/^[^\w]+/, "").trim());

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
