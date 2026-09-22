# Current Session

**Date:** 2026-09-22

## Goal
Follow-ups on the task time tracking shipped earlier the same day: a CSV export, a person filter
on the site's Time tab, and a daily 23:59 report posted to a channel everyone can read.

## Outcome — COMPLETE, MERGED AND DEPLOYED
Brainstorm → spec → plan → subagent-driven-development, 6 tasks across the three repos. See
`completed.md` for what shipped and `backlog.md` for what was deliberately deferred.

- Spec: `docs/superpowers/specs/2026-09-22-time-reporting-followups-design.md`
- Plan: `docs/superpowers/plans/2026-09-22-time-reporting-followups.md`
- Merges: bot `9dcac65`, CSAAS `b192294`, site `a09410e` — all pushed and deployed 2026-09-22.
- Verified in production: migration 024 applied; the first pass adopted `2026-09-21` and posted
  nothing, as designed. The first real report lands at 23:59 Asia/Karachi, which also creates
  `#time-reports`.

## Decisions worth remembering
- **A timer still running at 23:59 counts as zero and the day is then closed for good.** When
  `clockWatch` later auto-stops a forgotten timer it attributes up to 12h to a day whose public
  post already said "0m", and nothing revisits that post. We chose honest disclosure (an embed
  footer) over changing when the report posts. If that trade stops being acceptable, the fix is
  a spec change — post after midnight, or count elapsed-so-far.
- **`guildMemberFindMany` silently caps at 25 rows unless `where.all` is true.** Any new caller
  that reads a full roster must pass it; the daily report's test pins this.
- **Two repos bind SQL dates in deliberately opposite ways.** The bot binds raw `Date`s (its pool
  has no `timezone` option, so writes and reads agree); CSAAS binds strings through
  `toMysqlUtc` (its pool sets `+05:00`). Each is correct in its own repo and wrong in the other.
- **`__identityVerified`/`actor_email` are derived, never supplied.** `config.js` merges the
  request body wholesale into the auth payload, so any endpoint that trusts those fields to skip
  a permission check is forgeable unless the middleware strips them first — which it now does.
- **An unknown value is recorded as unknown, not guessed.** Same principle as the September
  migration that closed legacy rows at 0 minutes rather than a fabricated 12h.

## Open question for the owner
`.claude/state/completed.md` still labels the 2026-09-20 and 2026-09-21 entries "NOT YET MERGED"
although their merge commits are in `main`. Flagged on 2026-09-22 and still uncorrected.
