import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getOrCreateGuildConfig, updateGuildConfig } from "../db/index.js";
import { isValidZone, guildZone, zoneLabel, localZone } from "../utils/timezone.js";
import { parseWhen } from "../utils/parseWhen.js";
import { discordDateTime } from "../utils/discordTime.js";

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

  return interaction.editReply({ embeds: [embed] }).catch(() => {});
}
