import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import db, { getOrCreateGuildConfig, updateGuildConfig } from "../db/index.js";
import { isValidZone, guildZone, zoneLabel, localZone } from "../utils/timezone.js";
import { parseWhen } from "../utils/parseWhen.js";
import { discordDateTime } from "../utils/discordTime.js";
import { syncGuildNow } from "../services/docsSync.js";

export const data = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("(CEO/Server Manager) Configure server settings")
  .addStringOption((o) =>
    o
      .setName("timezone")
      .setDescription("Server timezone, e.g. America/New_York — used by /schedule")
      .setRequired(false)
      .setAutocomplete(true),
  );

let ZONE_LIST = null;
function allZones() {
  if (ZONE_LIST) return ZONE_LIST;
  try {
    ZONE_LIST = Intl.supportedValuesOf("timeZone");
  } catch {
    ZONE_LIST = [
      "UTC", "America/New_York", "America/Chicago", "America/Denver",
      "America/Los_Angeles", "America/Sao_Paulo", "Europe/London", "Europe/Paris",
      "Europe/Berlin", "Europe/Madrid", "Africa/Lagos", "Asia/Karachi",
      "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo",
      "Australia/Sydney", "Pacific/Auckland",
    ];
  }
  return ZONE_LIST;
}

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "timezone") return interaction.respond([]).catch(() => {});
  const q = (focused.value || "").toLowerCase().replace(/\s+/g, "_");
  const matches = allZones()
    .filter((z) => z.toLowerCase().includes(q))
    .slice(0, 25)
    .map((z) => ({ name: z, value: z }));
  return interaction.respond(matches).catch(() => {});
}

export async function execute(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.editReply({ content: "Use this in a server." });

  const cfg = await getOrCreateGuildConfig(guild.id);
  const tzInput = interaction.options.getString("timezone");

  if (tzInput) {
    if (!isValidZone(tzInput)) {
      return interaction
        .editReply({
          content: `**${tzInput}** is not a valid IANA timezone. Examples: \`America/New_York\`, \`Europe/London\`, \`Asia/Karachi\`. Start typing in the \`timezone\` option to search.`,
        })
        .catch(() => {});
    }
    await updateGuildConfig(guild.id, { timezone: tzInput });
    const sample = parseWhen("tomorrow 3pm", new Date(), tzInput);
    return interaction
      .editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Server timezone updated")
            .setDescription(
              `Now **${zoneLabel(tzInput)}**.\n\n\`/schedule\` will read times in this zone. For example, "tomorrow 3pm" now means ${discordDateTime(sample)}.`,
            )
            .setColor(0x57f287),
        ],
      })
      .catch(() => {});
  }

  // No options -> show current settings
  const zone = guildZone(cfg);
  const configured = cfg.timezone && isValidZone(cfg.timezone);
  const embed = new EmbedBuilder()
    .setTitle("Server settings")
    .addFields({
      name: "Timezone",
      value: configured
        ? zoneLabel(zone)
        : `_not set_ — using bot host zone (${zoneLabel(localZone())})`,
      inline: false,
    })
    .setColor(0x5865f2)
    .setFooter({ text: "Set with /setup timezone:<zone>" });

  const src = await db.docSource.get({ guildConfigId: cfg.id }).catch(() => null);
  const counts = await db.docPage.countsByProject({ guildConfigId: cfg.id }).catch(() => []);
  const total = counts.reduce((n, r) => n + Number(r.n || 0), 0);
  embed.addFields({
    name: "Documentation",
    value: src
      ? `${total} page(s) from \`${src.owner}/${src.repo}\`\nLast synced: ${src.lastSyncedAt ? `<t:${Math.floor(new Date(src.lastSyncedAt).getTime() / 1000)}:R>` : "_never_"}${src.lastError ? `\nLast error: \`${String(src.lastError).slice(0, 200)}\`` : ""}`
      : "_not configured — press Sync to set it up_",
    inline: false,
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("setup_docs_sync")
      .setLabel("Sync docs now")
      .setStyle(ButtonStyle.Primary),
  );

  return interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {});
}

export async function handleDocsSync(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  await interaction
    .editReply({ content: "Syncing documentation…", embeds: [], components: [] })
    .catch(() => {});
  // The button forces a full pass: it is the documented recovery route, and
  // reporting "already up to date" is useless in exactly the states — a wiped
  // or mis-attributed mirror — that make someone press it. The 15-minute
  // background loop keeps its head-sha short-circuit.
  const res = await syncGuildNow(guild.id, { force: true });
  const text = res.failed
    ? `Sync failed: \`${res.error}\``
    : `Synced. ${res.upserted} page(s) added or updated, ${res.deleted} removed, ${res.reattributed} re-assigned to a project.${
        res.failedFiles
          ? `\n\n${res.failedFiles} file(s) could not be downloaded, so nothing was removed and the next sync will retry them.`
          : ""
      }`;
  return interaction.editReply({ content: text }).catch(() => {});
}
