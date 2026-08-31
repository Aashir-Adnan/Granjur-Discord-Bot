import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import db, { getOrCreateGuildConfig, getGuildConfig } from "../db/index.js";
import * as flowStore from "../flows/store.js";
import { parseWhen } from "../utils/parseWhen.js";
import { discordDateTime, plainDateTime } from "../utils/discordTime.js";
import { guildZone, zoneLabel } from "../utils/timezone.js";

const WHEN_EXAMPLES =
  '`tomorrow 3pm`, `next mon 14:00`, `in 90 minutes`, `2025-03-01 14:00`';

const MIN_LEAD_MS = 60 * 1000; // must be at least a minute in the future

export const data = new SlashCommandBuilder()
  .setName("schedule")
  .setDescription("Schedule a meeting")
  .addStringOption((o) =>
    o
      .setName("topic")
      .setDescription("Meeting topic")
      .setRequired(true)
      .setMaxLength(200),
  )
  .addStringOption((o) =>
    o
      .setName("when")
      .setDescription('When — e.g. "tomorrow 3pm", "next mon 14:00", "in 90 minutes"')
      .setRequired(true)
      .setAutocomplete(true),
  );

/** Short plain-text relative phrase for autocomplete labels (no Discord markdown there). */
function relativePhrase(date, now = new Date()) {
  let s = Math.round((date.getTime() - now.getTime()) / 1000);
  const past = s < 0;
  s = Math.abs(s);
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, secs] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      const phrase = `${n} ${name}${n === 1 ? "" : "s"}`;
      return past ? `${phrase} ago` : `in ${phrase}`;
    }
  }
  return past ? "just now" : "in under a minute";
}

/** Autocomplete for the `when` option — previews the resolved date as the user types. */
export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "when") return interaction.respond([]).catch(() => {});

  const q = (focused.value || "").trim();
  const now = new Date();
  const zone = guildZone(await getGuildConfig(interaction.guildId).catch(() => null));

  if (!q) {
    const presets = ["in 30 minutes", "tomorrow 09:00", "tomorrow 14:00", "next monday 10:00"];
    return interaction
      .respond(
        presets.map((p) => {
          const d = parseWhen(p, now, zone);
          return {
            name: d ? `${p}  →  ${plainDateTime(d, zone)}`.slice(0, 100) : p,
            value: p,
          };
        }),
      )
      .catch(() => {});
  }

  // The value is always the user's own phrase — execute() re-parses it fresh at
  // submit time (so "in 5 minutes" stays relative to *then*, not to now). The
  // label just previews where it lands.
  const value = q.slice(0, 100);
  const parsed = parseWhen(q, now, zone);
  let name;
  if (parsed) {
    const future = parsed.getTime() > now.getTime() + MIN_LEAD_MS;
    name = `${future ? "" : "⚠ past — "}${q} → ${plainDateTime(parsed, zone)} (${relativePhrase(parsed, now)})`;
  } else {
    name = `🤔 "${q}" — not understood yet — try: tomorrow 3pm`;
  }

  return interaction.respond([{ name: name.slice(0, 100), value }]).catch(() => {});
}

export async function execute(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.editReply({ content: "Use this in a server." });

  const cfg = await getOrCreateGuildConfig(guild.id);
  const zone = guildZone(await getGuildConfig(interaction.guildId).catch(() => null));

  const topic = interaction.options.getString("topic");
  const whenStr = interaction.options.getString("when");
  const now = new Date();
  const scheduledAt = parseWhen(whenStr, now, zone);

  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
    return interaction
      .editReply({
        content: `I couldn't understand **"${whenStr}"**. Try one of: ${WHEN_EXAMPLES}`,
      })
      .catch(() => {});
  }
  if (scheduledAt.getTime() < now.getTime() + MIN_LEAD_MS) {
    return interaction
      .editReply({
        content: `That time (${discordDateTime(scheduledAt)}) is in the past. Pick a future time.`,
      })
      .catch(() => {});
  }

  flowStore.set(interaction.user.id, guild.id, "schedule", {
    topic,
    scheduledAt,
    voiceChannelId: null,
    recordingEnabled: false,
  });

  const members = await guild.members.fetch();
  const options = Array.from(members.values())
    .filter((m) => !m.user.bot)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .slice(0, 25)
    .map((m) => ({
      label: m.displayName.slice(0, 100),
      value: m.id,
      description: `@${m.user.username}`.slice(0, 100),
    }));

  const embed = new EmbedBuilder()
    .setTitle("Schedule meeting")
    .setDescription("**Step 2 of 3** — select members to invite.")
    .addFields(
      { name: "Topic", value: topic.slice(0, 200), inline: false },
      { name: "When", value: discordDateTime(scheduledAt), inline: false },
      { name: "Server timezone", value: zoneLabel(zone, scheduledAt), inline: false },
    )
    .setColor(0x5865f2)
    .setFooter({ text: "Times shown in your local timezone. Change the server zone with /setup." });

  const select = new StringSelectMenuBuilder()
    .setCustomId("schedule_members")
    .setPlaceholder("Select members (optional)")
    .setMinValues(0)
    .setMaxValues(Math.min(25, options.length || 1))
    .addOptions(
      options.length
        ? options
        : [{ label: "None", value: "none", description: "No invitees" }],
    );

  return interaction
    .editReply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(select)],
    })
    .catch(() => {});
}

export async function handleMembersSelect(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const state = flowStore.get(interaction.user.id, guild.id, "schedule");
  if (!state)
    return interaction
      .update({
        content: "Session expired. Run /schedule again.",
        components: [],
        embeds: [],
      })
      .catch(() => {});

  const memberIds = (interaction.values || []).filter((id) => id !== "none");
  const taggedMentions = memberIds.map((id) => `<@${id}>`).join(" ") || "None";

  const embed = new EmbedBuilder()
    .setTitle("Confirm meeting")
    .setDescription("**Step 3 of 3** — create this scheduled meeting?")
    .addFields(
      { name: "Topic", value: state.topic, inline: false },
      { name: "When", value: discordDateTime(new Date(state.scheduledAt)), inline: false },
      { name: "Invitees", value: taggedMentions, inline: false },
    )
    .setColor(0x5865f2);

  flowStore.set(interaction.user.id, guild.id, "schedule", { ...state, memberIds });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("schedule_confirm")
      .setLabel("Schedule")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("schedule_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {});
}

export async function handleConfirm(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const state = flowStore.get(interaction.user.id, guild.id, "schedule");
  if (!state)
    return interaction
      .update({ content: "Session expired. Run /schedule again.", components: [], embeds: [] })
      .catch(() => {});

  try {
    const cfg = await getOrCreateGuildConfig(guild.id);
    const scheduledAt = new Date(state.scheduledAt);
    await db.scheduledMeeting.create({
      data: {
        guildConfigId: cfg.id,
        topic: state.topic,
        scheduledAt,
        memberIds: state.memberIds || [],
        createdBy: interaction.user.id,
        voiceChannelId: state.voiceChannelId || null,
        recordingEnabled: Boolean(state.voiceChannelId),
      },
    });

    flowStore.clear(interaction.user.id, guild.id, "schedule");
    const mentions = (state.memberIds || []).map((id) => `<@${id}>`).join(" ");
    const embed = new EmbedBuilder()
      .setTitle("Meeting scheduled")
      .setDescription(
        `**${state.topic}**\n${discordDateTime(scheduledAt)}${mentions ? `\nInvited: ${mentions}` : ""}`,
      )
      .setColor(0x57f287);

    await interaction.update({ embeds: [embed], components: [] }).catch(() => {});
  } catch (e) {
    await interaction
      .update({
        content: `Failed: ${e?.message ?? String(e)}`,
        components: [],
        embeds: [],
      })
      .catch(() => {});
  }
}

export async function handleCancel(interaction) {
  flowStore.clear(interaction.user.id, interaction.guild?.id, "schedule");
  await interaction
    .update({ content: "Cancelled.", components: [], embeds: [] })
    .catch(() => {});
}
