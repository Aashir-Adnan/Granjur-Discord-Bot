import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import db, { getOrCreateGuildConfig, ensureStringArray } from "../db/index.js";
import fs from "fs";
import path from "path";

const PANEL_MODULES = [
  {
    value: "recordings",
    label: "Recordings",
    description: "View meeting recordings and their status",
  },
  {
    value: "meetings",
    label: "Meetings",
    description: "View all scheduled and past meetings",
  },
  {
    value: "members",
    label: "Members",
    description: "View guild member list and statuses",
  },
];

export const data = new SlashCommandBuilder()
  .setName("admin-panel")
  .setDescription("(CEO/Server Manager) Open the admin panel in a private admin channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
  const guild = interaction.guild;
  if (!guild)
    return interaction.editReply({ content: "Use this in a server." });

  const member = await guild.members
    .fetch(interaction.user.id)
    .catch(() => null);
  if (!member?.permissions.has("Administrator")) {
    return interaction.editReply({
      content: "Only administrators can use the admin panel.",
    });
  }

  const embed = new EmbedBuilder()
    .setTitle("Admin Panel")
    .setDescription(
      "Select a module below to view admin data.\nThis panel is only visible to you.",
    )
    .setColor(0xed4245)
    .setFooter({ text: "Admin only" });

  const select = new StringSelectMenuBuilder()
    .setCustomId("admin_panel_select")
    .setPlaceholder("Select a module to view")
    .addOptions(
      PANEL_MODULES.map((m) => ({
        label: m.label,
        value: m.value,
        description: m.description,
      })),
    );

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

export async function handlePanelSelect(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const value = interaction.values?.[0];
  if (!value) return;

  const cfg = await getOrCreateGuildConfig(guild.id);

  if (value === "recordings") {
    return showRecordings(interaction, cfg);
  }
  if (value === "meetings") {
    return showMeetings(interaction, cfg);
  }
  if (value === "members") {
    return showMembers(interaction, cfg, guild);
  }
}

async function showRecordings(interaction, cfg) {
  const recordings = await db.meetingRecording.findMany({
    where: { guildConfigId: cfg.id },
  });

  if (!recordings || recordings.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle("Admin Panel — Recordings")
      .setDescription("No recordings found.")
      .setColor(0xed4245);
    return interaction.editReply({ embeds: [embed], components: [] });
  }

  const byMeeting = {};
  for (const r of recordings) {
    (byMeeting[r.meetingId] = byMeeting[r.meetingId] || []).push(r);
  }

  const meetingIds = Object.keys(byMeeting).slice(0, 10);
  const lines = [];

  for (const meetingId of meetingIds) {
    const recs = byMeeting[meetingId];
    const totalDuration = recs.reduce(
      (sum, r) => sum + (r.durationSeconds || 0),
      0,
    );
    const fileCount = recs.length;
    const started = recs[0]?.startedAt
      ? new Date(recs[0].startedAt).toISOString().slice(0, 16).replace("T", " ")
      : "—";

    const fileStatus = recs.map((r) => {
      const exists = r.filePath ? fs.existsSync(r.filePath) : false;
      return exists ? "on disk" : "missing";
    });
    const onDisk = fileStatus.filter((s) => s === "on disk").length;

    lines.push(
      `**Meeting:** \`${meetingId.slice(0, 8)}...\`\n` +
        `  Started: ${started} | Clips: ${fileCount} | Duration: ${totalDuration}s\n` +
        `  Files on disk: ${onDisk}/${fileCount}`,
    );
  }

  const remaining = Object.keys(byMeeting).length - meetingIds.length;
  if (remaining > 0) {
    lines.push(`\n_… and ${remaining} more meetings_`);
  }

  const embed = new EmbedBuilder()
    .setTitle("Admin Panel — Recordings")
    .setDescription(lines.join("\n\n"))
    .setColor(0xed4245)
    .setFooter({ text: `Total: ${recordings.length} recording(s)` });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("admin_panel_recording_details")
      .setLabel("View Recording Details")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("admin_panel_back")
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [buttons] });
}

async function showMeetings(interaction, cfg) {
  const [scheduled, recordings] = await Promise.all([
    db.scheduledMeeting.findMany({
      where: { guildConfigId: cfg.id },
      orderBy: { scheduledAt: "desc" },
      take: 15,
    }),
    db.meetingRecording.findMany({
      where: { guildConfigId: cfg.id },
    }),
  ]);

  const recordedMeetingIds = new Set(
    (recordings || []).map((r) => r.meetingId),
  );

  const pad = (s, n) => String(s ?? "—").slice(0, n).padEnd(n);
  const lines = (scheduled || []).map((m) => {
    const date = m.scheduledAt
      ? new Date(m.scheduledAt).toISOString().slice(0, 16).replace("T", " ")
      : "—";
    const topic = (m.topic || "—").slice(0, 30);
    const members = ensureStringArray(m.memberIds).length;
    const hasRecording = recordedMeetingIds.has(m.id) ? "Yes" : "No";
    return `${pad(date, 16)} | ${pad(topic, 30)} | ${pad(members + " members", 12)} | Recorded: ${hasRecording}`;
  });

  const desc = lines.length
    ? "```\n" +
      pad("Date", 16) +
      " | " +
      pad("Topic", 30) +
      " | " +
      pad("Members", 12) +
      " | Recorded\n" +
      "—".repeat(75) +
      "\n" +
      lines.join("\n") +
      "\n```"
    : "No scheduled meetings found.";

  const embed = new EmbedBuilder()
    .setTitle("Admin Panel — Meetings")
    .setDescription(desc)
    .setColor(0x5865f2)
    .setFooter({ text: `Showing up to 15 most recent` });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("admin_panel_back")
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [buttons] });
}

async function showMembers(interaction, cfg, guild) {
  const members = await db.guildMember.findMany({
    where: { guildConfigId: cfg.id },
  });

  if (!members || members.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle("Admin Panel — Members")
      .setDescription("No members found in database.")
      .setColor(0x57f287);
    return interaction.editReply({ embeds: [embed], components: [] });
  }

  const statusCounts = {};
  for (const m of members) {
    const st = m.status || "unknown";
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  }

  const summaryLines = Object.entries(statusCounts)
    .map(([status, count]) => `**${status}:** ${count}`)
    .join("\n");

  const recentMembers = members.slice(0, 15);
  const pad = (s, n) => String(s ?? "—").slice(0, n).padEnd(n);
  const memberLines = recentMembers.map((m) => {
    const name = (m.email || m.discordId || "—").slice(0, 25);
    const status = (m.status || "—").slice(0, 10);
    const verified = m.verifiedAt
      ? new Date(m.verifiedAt).toISOString().slice(0, 10)
      : "—";
    return `${pad(name, 25)} | ${pad(status, 10)} | ${pad(verified, 10)}`;
  });

  const table = memberLines.length
    ? "```\n" +
      pad("Email/ID", 25) +
      " | " +
      pad("Status", 10) +
      " | " +
      pad("Verified", 10) +
      "\n" +
      "—".repeat(50) +
      "\n" +
      memberLines.join("\n") +
      "\n```"
    : "";

  const embed = new EmbedBuilder()
    .setTitle("Admin Panel — Members")
    .setDescription(`**Status Summary:**\n${summaryLines}\n\n**Recent Members:**\n${table}`)
    .setColor(0x57f287)
    .setFooter({ text: `Total: ${members.length} member(s)` });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("admin_panel_back")
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [buttons] });
}

export async function handleRecordingDetails(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const cfg = await getOrCreateGuildConfig(guild.id);
  const recordings = await db.meetingRecording.findMany({
    where: { guildConfigId: cfg.id },
  });

  if (!recordings || recordings.length === 0) {
    return interaction.editReply({
      content: "No recordings found.",
      embeds: [],
      components: [],
    });
  }

  const details = recordings.slice(0, 20).map((r) => {
    const exists = r.filePath ? fs.existsSync(r.filePath) : false;
    const size = exists
      ? `${(fs.statSync(r.filePath).size / 1024).toFixed(1)} KB`
      : "—";
    const date = r.startedAt
      ? new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " ")
      : "—";
    return (
      `**${r.fileName || "unknown"}**\n` +
      `  Member: \`${r.memberId}\` | Duration: ${r.durationSeconds || 0}s\n` +
      `  Date: ${date} | Size: ${size} | ${exists ? "On disk" : "Missing"}`
    );
  });

  const remaining = recordings.length - 20;
  if (remaining > 0) {
    details.push(`\n_… and ${remaining} more_`);
  }

  const embed = new EmbedBuilder()
    .setTitle("Admin Panel — Recording Details")
    .setDescription(details.join("\n\n").slice(0, 4000))
    .setColor(0xed4245)
    .setFooter({ text: `${recordings.length} total recording(s)` });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("admin_panel_back")
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [buttons] });
}

export async function handleBack(interaction) {
  return execute(interaction);
}
