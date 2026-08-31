/**
 * Discord renders `<t:UNIX:style>` tokens in each viewer's own local timezone,
 * so every meeting time we show to users should go through here instead of
 * `toISOString()` / `toLocaleString()` (which bake in UTC or the bot host's zone).
 *
 * Styles: t short time, T long time, d short date, D long date,
 *         f short date+time, F full, R relative ("in 2 hours").
 */
export function discordTime(date, style = "f") {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;
}

export function discordRelative(date) {
  return discordTime(date, "R");
}

/** "<full date> (in 2 hours)" — the phrasing we use in confirmations and reminders. */
export function discordDateTime(date) {
  return `${discordTime(date, "F")} (${discordRelative(date)})`;
}

/**
 * Plain-text rendering for places Discord markdown does NOT resolve
 * (autocomplete choice labels, logs). Pass an IANA `zone` to render in that
 * zone; omit it to use the bot host's zone.
 */
export function plainDateTime(date, zone) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(zone ? { timeZone: zone } : {}),
  });
}
