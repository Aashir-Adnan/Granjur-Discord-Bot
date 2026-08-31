import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import db, { getOrCreateGuildConfig, getGuildConfig, ensureStringArray } from "../db/index.js";
import { parseWhen } from "../utils/parseWhen.js";
import { discordDateTime, plainDateTime } from "../utils/discordTime.js";
import { guildZone } from "../utils/timezone.js";

const MIN_LEAD_MS = 60 * 1000;
const MANAGER_ROLES = ["CEO", "Server Manager"];

export const data = new SlashCommandBuilder()
  .setName("meetings")
  .setDescription("List, reschedule, or cancel your scheduled meetings");

function isManager(member) {
  if (!member) return false;
  if (member.guild?.ownerId === member.id) return true;
  if (member.permissions?.has?.("ManageGuild") || member.permissions?.has?.("Administrator"))
    return true;
  return member.roles?.cache?.some((r) => MANAGER_ROLES.includes(r.name)) ?? false;
}

async function loadMeetings(interaction) {
  const guild = interaction.guild;
  const cfg = await getOrCreateGuildConfig(guild.id);
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  const manager = isManager(member);
  const meetings = await db.scheduledMeeting.findUpcoming({
    guildConfigId: cfg.id,
    createdBy: manager ? undefined : interaction.user.id,
  });
  return { cfg, manager, meetings, zone: guildZone(cfg) };
}

function meetingListComponents(meetings, zone) {
  const options = meetings.slice(0, 25).map((m) => ({
    label: (m.topic || "Meeting").slice(0, 100),
    value: m.id,
    description: `${plainDateTime(new Date(m.scheduledAt), zone)} · ${ensureStringArray(m.memberIds).length} invited`.slice(0, 100),
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("meetings_select")
      .setPlaceholder("Select a meeting to manage")
      .addOptions(options),
  );
}

export async function execute(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.editReply({ content: "Use this in a server." });

  const { manager, meetings, zone } = await loadMeetings(interaction);
  if (!meetings.length) {
    return interaction
      .editReply({
        content: manager
          ? "No upcoming meetings scheduled."
          : "You have no upcoming meetings. Schedule one with `/schedule`.",
      })
      .catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setTitle("Your upcoming meetings")
    .setDescription(
      meetings
        .slice(0, 25)
        .map((m) => `• **${(m.topic || "Meeting").slice(0, 80)}** — ${discordDateTime(new Date(m.scheduledAt))}`)
        .join("\n"),
    )
    .setColor(0x5865f2)
    .setFooter({ text: manager ? "Manager view — everyone's meetings" : "Select one to reschedule or cancel" });

  return interaction
    .editReply({ embeds: [embed], components: [meetingListComponents(meetings, zone)] })
    .catch(() => {});
}

export async function handleSelect(interaction) {
  const meetingId = interaction.values?.[0];
  if (!meetingId) return;
  const m = await db.scheduledMeeting.findById(meetingId).catch(() => null);
  if (!m || m.cancelled) {
    return interaction
      .editReply({ content: "That meeting is gone or already cancelled.", embeds: [], components: [] })
      .catch(() => {});
  }
  const cfg = await getGuildConfig(interaction.guild.id).catch(() => null);
  const invitees = ensureStringArray(m.memberIds).map((id) => `<@${id}>`).join(" ") || "None";

  const embed = new EmbedBuilder()
    .setTitle(m.topic || "Meeting")
    .addFields(
      { name: "When", value: discordDateTime(new Date(m.scheduledAt)), inline: false },
      { name: "Invitees", value: invitees, inline: false },
      { name: "Organizer", value: `<@${m.createdBy}>`, inline: false },
    )
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`meetings_reschedule:${m.id}`)
      .setLabel("Reschedule")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`meetings_cancel:${m.id}`)
      .setLabel("Cancel meeting")
      .setStyle(ButtonStyle.Danger),
  );

  return interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {});
}

export async function handleCancelButton(interaction) {
  const meetingId = interaction.customId.split(":")[1];
  const m = await db.scheduledMeeting.findById(meetingId).catch(() => null);
  if (!m || m.cancelled) {
    return interaction
      .editReply({ content: "Already cancelled or not found.", embeds: [], components: [] })
      .catch(() => {});
  }
  await db.scheduledMeeting.update(meetingId, { cancelled: true });
  return interaction
    .editReply({
      content: `Cancelled **${(m.topic || "Meeting").slice(0, 100)}** (was ${discordDateTime(new Date(m.scheduledAt))}).`,
      embeds: [],
      components: [],
    })
    .catch(() => {});
}

export async function handleRescheduleButton(interaction) {
  const meetingId = interaction.customId.split(":")[1];
  const m = await db.scheduledMeeting.findById(meetingId).catch(() => null);
  if (!m || m.cancelled) {
    return interaction
      .reply({ content: "That meeting is gone or already cancelled.", ephemeral: true })
      .catch(() => {});
  }
  const modal = new ModalBuilder()
    .setCustomId(`meetings_reschedule_modal:${meetingId}`)
    .setTitle("Reschedule meeting")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("when")
          .setLabel("New time")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("tomorrow 3pm · next mon 14:00 · in 2 days")
          .setRequired(true),
      ),
    );
  return interaction.showModal(modal).catch(() => {});
}

export async function handleRescheduleModal(interaction) {
  const meetingId = interaction.customId.split(":")[1];
  const m = await db.scheduledMeeting.findById(meetingId).catch(() => null);
  if (!m || m.cancelled) {
    return interaction.editReply({ content: "That meeting is gone or already cancelled." }).catch(() => {});
  }
  const cfg = await getGuildConfig(interaction.guild.id).catch(() => null);
  const zone = guildZone(cfg);
  const whenStr = interaction.fields.getTextInputValue("when");
  const now = new Date();
  const scheduledAt = parseWhen(whenStr, now, zone);

  if (!scheduledAt) {
    return interaction
      .editReply({ content: `Couldn't understand **"${whenStr}"**. Try \`tomorrow 3pm\` or \`in 2 days\`.` })
      .catch(() => {});
  }
  if (scheduledAt.getTime() < now.getTime() + MIN_LEAD_MS) {
    return interaction
      .editReply({ content: `${discordDateTime(scheduledAt)} is in the past. Pick a future time.` })
      .catch(() => {});
  }

  // Reset reminderSentAt so the 10-min reminder fires again for the new time.
  await db.scheduledMeeting.update(meetingId, { scheduledAt, reminderSentAt: null });
  return interaction
    .editReply({
      content: `**${(m.topic || "Meeting").slice(0, 100)}** moved to ${discordDateTime(scheduledAt)}.`,
    })
    .catch(() => {});
}
