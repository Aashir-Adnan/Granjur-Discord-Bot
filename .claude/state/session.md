# Current Session

**Date:** 2026-09-23

## Goal
Project Stats tab, and the Time tab under the shared filters — spec
`docs/superpowers/specs/2026-09-23-project-stats-and-time-filters-design.md`, plan
`docs/superpowers/plans/2026-09-23-project-stats-and-time-filters.md`.

## Outcome — COMPLETE, IMPLEMENTED ON BRANCHES, NOT MERGED, NOT PUSHED, NOT DEPLOYED
8 code tasks via subagent-driven development, every task reviewed, 1–2 fix rounds each, a
final whole-branch review clean after one fix wave. See `completed.md` for the commits
and files per repo — CSAAS `feat/project-stats` (6 commits `2e8d503..28a6830`), UBS-Doc
`feat/project-stats` (11 commits `ecfc40f..00ae80c`). Both branches sit unmerged and
unpushed, awaiting the owner's go-ahead.

## Decisions worth not re-litigating
- Time series come from the new `/api/discord/projects/stats` endpoint; snapshot numbers
  come from the tasks payload (activity capped at 15/task there).
- Completions are bucketed by DB-local day via `toMysqlUtc(...).slice(0,10)` so all
  series share one frame.
- Assignee options are the roster on every tab; `timeSelfScoped` hides the Assignee
  select on Time only.
- Under self scope the Time person is always the caller, and no entries request fires
  before the first report lands.
- The "Logged vs estimate" tile is hidden under self scope because `timeLogged` on the
  tasks payload is NOT permission-gated (pre-existing exposure — see `backlog.md`).
- Sparkline draws a flat line for all-zero.
- Charts are hand-rolled SVG, with all math in `statsLogic.ts` (tested). No chart
  library.
- A zero-task project has no overview card (`applyFilters` drops it — consistent with
  People/Tasks).

## Still unverified
A manual browser walkthrough of the Time and Stats tabs was NOT performed — the devtools
tooling could not attach to the owner's running Chrome. What the owner should check:
overview cards/rings/sparklines, a card click setting the Project filter, the "View
tasks" deep link, the KPI row, member bars, all four chart tooltips, Monday labels under
90d/All, Assignee narrowing, the 30/90/All refetch, both themes, and that the Time and
Stats tabs show only Project + Assignee in the filter bar.

The UBS-Doc working tree also carries unrelated uncommitted changes from other work
(`src/components/meetingWorkflow/LiveTranscribeStage.jsx`, `src/styles/portal-compat.css`,
`audioCapture*.js`) that were deliberately left untouched throughout this build.

## Next step
Owner decides on merge/deploy for both `feat/project-stats` branches (CSAAS and UBS-Doc).
Nothing else is pending on this feature; see `backlog.md`'s "Project Stats — deferred
follow-ups" for what was consciously left for later.
