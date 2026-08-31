/**
 * Timezone helpers for /schedule. The server's zone is stored on
 * `guildConfig.timezone` (IANA name, e.g. "America/New_York"); when unset we
 * fall back to the bot host's local zone. Configured via /setup.
 *
 * No dependency — uses Intl to compute zone offsets.
 */

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** True if `name` is an IANA zone this runtime understands. */
export function isValidZone(name) {
  if (!name || typeof name !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The effective zone for a guild: its configured zone, else the bot host's. */
export function guildZone(cfg) {
  const z = cfg?.timezone;
  return z && isValidZone(z) ? z : localZone();
}

/** Break a Date instant into wall-clock parts in `zone`. */
export function partsInZone(date, zone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  let hour = parseInt(parts.hour, 10) % 24; // Intl can emit "24" at midnight
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10) - 1,
    day: parseInt(parts.day, 10),
    hour,
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? new Date(date).getUTCDay(),
  };
}

/** Current wall-clock parts in `zone`. */
export function nowInZone(zone, now = new Date()) {
  return partsInZone(now, zone);
}

/**
 * Convert a wall-clock time in `zone` to the corresponding UTC Date.
 * Two-pass to settle DST boundaries.
 */
export function zonedWallTimeToDate({ year, month, day, hour = 0, minute = 0 }, zone) {
  // T = the target wall time treated as if it were UTC.
  const T = Date.UTC(year, month, day, hour, minute, 0);
  let R = T; // current estimate of the real UTC instant
  for (let i = 0; i < 3; i++) {
    const p = partsInZone(new Date(R), zone);
    const seenAsUTC = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, 0);
    const zoneOffset = seenAsUTC - R; // zone's UTC offset at instant R
    const next = T - zoneOffset; // wall(next) should now equal the target
    if (next === R) break;
    R = next;
  }
  return new Date(R);
}

/** Short label like "PST (UTC-8)" for display. */
export function zoneLabel(zone, date = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    });
    const off = dtf.formatToParts(date).find((p) => p.type === "timeZoneName");
    return off ? `${zone} (${off.value})` : zone;
  } catch {
    return zone;
  }
}
