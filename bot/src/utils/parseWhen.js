/**
 * Lightweight natural-language date/time parser for `/schedule`.
 * Zero dependencies (repo convention).
 *
 * Wall-clock inputs ("tomorrow 3pm", "2025-03-01 14:00") are interpreted in the
 * caller-supplied IANA `zone` (the guild's configured timezone — see
 * bot/src/utils/timezone.js). Relative inputs ("in 2 hours") and inputs with an
 * explicit offset ("...T14:00Z") are absolute and ignore `zone`.
 *
 * Supported:
 *   - ISO-ish:      "2025-03-01", "2025-03-01 14:00", "2025-03-01T14:00[Z|+05:00]"
 *   - relative:     "in 2 days", "in 90 minutes", "in 1h30m", "in 1 day 6 hours", "in 2 weeks"
 *   - day words:    "today 3pm", "tomorrow", "tomorrow at 14:00", "tonight"
 *   - weekdays:     "monday 3pm", "next fri 14:00", "thu"
 *   - month/day:    "mar 3 2pm", "3 march", "march 3 2025 14:00"
 *   - bare time:    "3pm", "3:30 pm", "14:00", "9am"   (today, or tomorrow if already past)
 *
 * Returns a Date, or null if nothing could be understood.
 */
import { localZone, nowInZone, zonedWallTimeToDate } from "./timezone.js";

const WEEKDAYS = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const DEFAULT_HOUR = 9; // when a day is given with no time

/** Parse "3pm", "3:30 pm", "14:00", "9 am" -> { h, m } or null. */
function parseTimeOfDay(str) {
  if (!str) return null;
  const s = str.trim().toLowerCase();
  let m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = m[3];
    if (min > 59) return null;
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h > 23) return null;
    return { h, m: min };
  }
  m = s.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const ap = m[2];
    if (h > 23) return null;
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return { h, m: 0 };
  }
  m = s.match(/^(\d{1,2})$/);
  if (m) {
    const h = parseInt(m[1], 10);
    if (h >= 0 && h <= 23) return { h, m: 0 };
  }
  return null;
}

/** Pull a trailing time expression out of a string. Returns { time, rest }. */
function extractTime(input) {
  const s = input.trim();
  let m = s.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*$/i);
  if (m) return { time: parseTimeOfDay(m[1]), rest: s.slice(0, m.index).trim() };
  m = s.match(/\s(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*$/i);
  if (m && parseTimeOfDay(m[1])) {
    return { time: parseTimeOfDay(m[1]), rest: s.slice(0, m.index).trim() };
  }
  const whole = parseTimeOfDay(s);
  if (whole) return { time: whole, rest: "" };
  return { time: null, rest: s };
}

/** Add `days` to a {year,month,day} using UTC as a DST-free scratch calendar. */
function addDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month, day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

export function parseWhen(input, now = new Date(), zone = localZone()) {
  if (!input || typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const build = (ymd, time, fallbackHour = DEFAULT_HOUR) =>
    zonedWallTimeToDate(
      {
        year: ymd.year,
        month: ymd.month,
        day: ymd.day,
        hour: time ? time.h : fallbackHour,
        minute: time ? time.m : 0,
      },
      zone,
    );

  // Today's wall-clock date in the target zone.
  const tz = nowInZone(zone, now);
  const today = { year: tz.year, month: tz.month, day: tz.day };

  // 1. ISO-ish  (…date[ T]HH:MM[:SS][.fff][Z|±HH:MM])
  const isoM = lower.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?\s*(z|[+-]\d{2}:?\d{2})?)?/,
  );
  if (isoM) {
    if (!isoM[4]) {
      return build({ year: +isoM[1], month: +isoM[2] - 1, day: +isoM[3] }, null);
    }
    if (isoM[6] || /\d[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
      // explicit offset / Z -> absolute instant, ignore the target zone
      const d = new Date(raw.replace(" ", "T"));
      if (!Number.isNaN(d.getTime())) return d;
    }
    return build(
      { year: +isoM[1], month: +isoM[2] - 1, day: +isoM[3] },
      { h: +isoM[4], m: +isoM[5] },
    );
  }

  // 2. relative: "in 2 days", "in 1h30m", "in 1 day 6 hours"
  let m = lower.match(/^in\s+(.+)$/);
  if (m) {
    const parts = m[1].matchAll(
      /(\d+)\s*(w(?:eeks?)?|d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:utes?)?)?)/g,
    );
    let ms = 0;
    let found = false;
    for (const p of parts) {
      const n = parseInt(p[1], 10);
      const unit = p[2][0];
      found = true;
      if (unit === "w") ms += n * 7 * 24 * 3600e3;
      else if (unit === "d") ms += n * 24 * 3600e3;
      else if (unit === "h") ms += n * 3600e3;
      else ms += n * 60e3;
    }
    if (found) return new Date(now.getTime() + ms);
  }

  // 3. today / tonight / tomorrow
  const { time, rest } = extractTime(lower);
  if (rest === "tonight" || (rest === "" && lower === "tonight")) {
    return build(today, time, 19);
  }
  if (rest === "today") return build(today, time, tz.hour);
  if (rest === "tomorrow" || rest === "tmrw" || rest === "tmr") {
    return build(addDays(today, 1), time);
  }

  // 4. weekday, optionally "next"
  m = rest.match(/^(next\s+)?([a-z]+)$/);
  if (m && WEEKDAYS[m[2]] !== undefined) {
    const target = WEEKDAYS[m[2]];
    let delta = (target - tz.weekday + 7) % 7;
    if (delta === 0) delta = 7; // "monday" on a Monday -> the coming Monday
    if (m[1]) delta += 7; // "next monday" -> the Monday of next week
    return build(addDays(today, delta), time);
  }

  // 5. month + day (+ optional year)
  m = rest.match(/^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  let mo =
    m && MONTHS[m[1]] !== undefined
      ? { mon: MONTHS[m[1]], day: parseInt(m[2], 10), year: m[3] }
      : null;
  if (!mo) {
    m = rest.match(/^(\d{1,2})\s+([a-z]+)(?:,?\s+(\d{4}))?$/);
    if (m && MONTHS[m[2]] !== undefined) {
      mo = { mon: MONTHS[m[2]], day: parseInt(m[1], 10), year: m[3] };
    }
  }
  if (mo && mo.day >= 1 && mo.day <= 31) {
    let year = mo.year ? parseInt(mo.year, 10) : today.year;
    let d = build({ year, month: mo.mon, day: mo.day }, time);
    if (!mo.year && d.getTime() < now.getTime()) {
      d = build({ year: year + 1, month: mo.mon, day: mo.day }, time);
    }
    return d;
  }

  // 6. bare time -> today, or tomorrow if already past
  if (rest === "" && time) {
    let d = build(today, time);
    if (d.getTime() <= now.getTime()) d = build(addDays(today, 1), time);
    return d;
  }

  // 7. last resort
  const fallback = new Date(raw);
  if (!Number.isNaN(fallback.getTime())) return fallback;

  return null;
}
