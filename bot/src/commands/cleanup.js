import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
} from "discord.js";
import { CATEGORY_SUPPORT } from "../constants.js";
import { protectedCategoryNames, protectedChannelNames } from "../services/globalLayout.js";
import { claimedSectionIds } from "../services/projectSection.js";
import db, { getOrCreateGuildConfig } from "../db/index.js";

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
    // Everything living in a project category: its thirteen section channels,
    // the archive divider, every ticket channel, and the meeting pairs
    // /meeting-channel creates inside a section.
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
  // From the one global layout /init builds (services/globalLayout.js).
  const protectedChannels = protectedChannelNames();
  const protectedCategories = protectedCategoryNames();
  // Channels the bot stores by id — whatever they are called and wherever
  // they sit. #time-reports lives at the root, outside every category.
  const storedIds = new Set(
    [cfg?.onboardingChannelId, cfg?.adminChannelId, cfg?.timeReportChannelId, cfg?.feedbackChannelId].filter(Boolean),
  );

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

  // Every task's ticket channel, by id. Tickets for tasks with no project live
  // in the global Features/Bugs categories, and a trim must never offer one up.
  let tasks;
  try {
    tasks = (await dbArg.task.findMany({ where: { guildConfigId: cfg.id } })) ?? [];
  } catch (e) {
    console.error("[cleanup] task read failed:", e);
    return interaction.editReply({
      content:
        "I could not read this server's tasks, and their ticket channels are exactly what a cleanup has to leave alone. Nothing was listed. Try again in a moment.",
    });
  }
  const ticketIds = new Set(tasks.flatMap((t) => [t?.discordChannelId, t?.discordThreadId]).filter(Boolean));

  const channels = await guild.channels.fetch();
  // The global support pair, by id, and whatever category holds it.
  const supportIds = new Set([cfg?.supportChannelId, cfg?.supportVoiceChannelId].filter(Boolean));
  const supportCategoryIds = new Set(
    [...supportIds].map((id) => channels.get(id)?.parentId ?? channels.get(id)?.parent?.id).filter(Boolean),
  );
  // Before the first /init, /setup or client approval has run, cfg carries no
  // support ids at all — and the pair would then be swept away by the very
  // command whose job is to leave what the bot built alone. The name is the
  // fallback for exactly that window, never instead of the ids.
  for (const [, ch] of channels) {
    if (ch?.type === ChannelType.GuildCategory && ch.name === CATEGORY_SUPPORT) supportCategoryIds.add(ch.id);
  }

  // A category that is ours or a project's: never removed, and its channels
  // are judged by the protected-name rule below.
  const isProtectedCategory = (ch) => {
    const name = ch.name.toLowerCase();
    const stripped = name.replace(/^[^\w]+/, "").trim();
    return (
      section.sectionIds.has(ch.id) ||
      section.categoryIds.has(ch.id) ||
      supportCategoryIds.has(ch.id) ||
      protectedCategories.has(name) ||
      section.names.has(name) ||
      section.names.has(stripped)
    );
  };

  const toDelete = [];

  for (const [, ch] of channels) {
    if (!ch) continue;
    if (userCreatedIds.has(ch.id)) continue;
    if (storedIds.has(ch.id) || ticketIds.has(ch.id)) continue;
    // By id, before any name is looked at.
    if (section.sectionIds.has(ch.id)) continue;
    const parentId = ch.parentId ?? ch.parent?.id ?? null;
    if (supportIds.has(ch.id) || supportCategoryIds.has(ch.id)) continue;
    if (parentId && supportCategoryIds.has(parentId)) continue;
    const inProjectSection = Boolean(parentId) && section.categoryIds.has(parentId);
    if (inProjectSection) continue;

    const name = ch.name.toLowerCase();

    // Categories are decided after the loop, once their channels are known.
    if (ch.type === ChannelType.GuildCategory) continue;

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

  // A category goes only when it is not protected and every channel in it is
  // going — the trim would otherwise leave Rules, Archive and the rest behind
  // as empty shells. One protected channel inside (a /create-channel room, a
  // ticket) keeps it.
  const deleting = new Set(toDelete.map((c) => c.id));
  const emptyCategories = [];
  for (const [, ch] of channels) {
    if (!ch || ch.type !== ChannelType.GuildCategory || isProtectedCategory(ch)) continue;
    const children = [...channels.values()].filter((c) => c && (c.parentId ?? c.parent?.id ?? null) === ch.id);
    if (children.every((c) => deleting.has(c.id))) emptyCategories.push(ch);
  }

  if (toDelete.length === 0 && emptyCategories.length === 0) {
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
  const categoryBlock = emptyCategories.length
    ? `\n\n**Categories left empty, removed too:**\n${emptyCategories.map((c) => `- 📁 ${c.name}`).join("\n")}`
    : "";

  // Channels first, then their categories: Discord refuses nothing either way,
  // but a category deleted first would orphan its channels mid-run.
  pendingCleanups.set(guild.id, [...toDelete.map((ch) => ch.id), ...emptyCategories.map((c) => c.id)]);

  const total = toDelete.length + emptyCategories.length;
  const embed = new EmbedBuilder()
    .setTitle("Cleanup — Channels to Remove")
    .setDescription(
      `Found **${toDelete.length}** channel(s)${emptyCategories.length ? ` and **${emptyCategories.length}** empty categor${emptyCategories.length === 1 ? "y" : "ies"}` : ""} to remove:\n\n${list}${remaining}${categoryBlock}\n\nUser-created channels (from /create-channel), task tickets and project sections will NOT be removed.`,
    )
    .setColor(0xed4245)
    .setFooter({ text: "This cannot be undone" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("cleanup_confirm")
      .setLabel(`Delete ${total} item(s)`)
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
    content: `Cleanup complete. Deleted **${deleted}** item(s).${failed ? ` Failed: ${failed}.` : ""}`,
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
