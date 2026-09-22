# Project Stats tab, and the Time tab under the shared filters — design

**Date:** 2026-09-23
**Repos:** UBS-Doc (site), CSAAS_Backend (API). No bot changes.
**Status:** approved in brainstorming; this is the written spec.

## 1. Why

Two asks from the owner after the time-reporting work shipped:

1. The Time tab in Team has its own filtering (a week stepper and a local "Person"
   select) while every other Team tab is driven by the shared filter bar. It should
   follow the same bar.
2. A Project Stats page in Team: every project's members, task-completion percentage,
   and activity graphs, with good UI.

Four add-ons were offered and accepted: estimate vs logged, stale tasks, average cycle
time, and a card-to-Tasks deep link.

## 2. Decisions already made

| Decision | Choice |
|---|---|
| Where Stats lives | A new `Stats` tab in Team, driven by the shared Project filter. No project selected shows an overview grid; a selected project shows its full stats. |
| Graphs | All four: time logged per day stacked by member; tasks created vs completed (cumulative); task events per day; per-member open / in progress / done bars. |
| Range for the time series | Selectable 30 / 90 days / all time, default 30. Day buckets at 30, week buckets otherwise. |
| Data source | Hybrid. Snapshot data (members, roles, per-person counts, completion, estimate vs logged) comes from the tasks payload the Team shell already holds. Time series, stale tasks and cycle time come from one new CSAAS endpoint. |
| Charts | Hand-rolled SVG, no chart library. Layout math in a pure, tested logic module. |
| Time tab filters | Project and Assignee apply. Status, Blocked-only and search are hidden on Time and Stats. The local Person select is removed. Assignee options come from the roster on every tab. |

## 3. Time tab under the shared filters (site)

### 3.1 `TeamLayout.tsx`

- The filter bar renders on every tab. Which controls show depends on the tab:
  - `tasks`: Status, Project, Assignee, Blocked-only, search (unchanged).
  - `people`, `board`: Project, Assignee, Blocked-only, search (unchanged).
  - `time`, `stats`: Project, Assignee only. The search box and the Blocked-only
    checkbox are not rendered on these two tabs.
- The Assignee select's options are the roster: `payload.members`, sorted by name,
  on every tab. `assigneeOptions(projects)` (people who are assigned to at least one
  task) is no longer used for the select. Reason: people log time on general work and
  on tasks they are not assigned to, so a Time/Stats person filter built from
  assignees would be missing people who have data. Picking a roster member with no
  tasks on the Tasks tab shows an empty list, which is correct.
- The section's error banner ("Could not load tasks") stays hidden on Time, as today;
  it is also hidden on Stats. Both tabs own their own fetch and their own banner.
- `TeamContext.people` keeps its name but now carries the roster.

### 3.2 `TimeTab.tsx`

- The local `personId` state and the `FilterSelect` for "Person" are removed. The
  per-person section (By task, Entries, Download CSV) is driven by
  `filters.assigneeId` from `useTeam()`.
- `filters.projectSlug` is passed to both `fetchTimeReport` and `fetchTimeEntries`.
  Both effects add it to their dependency lists.
- The week stepper, the "By person" / "By project" cards, the dim-on-refetch
  behaviour, the `shown` guard and the CSV export are unchanged, except that `shown`
  also requires the response's echoed `project` to equal the current filter (see 3.4).
- Self-scoped callers (`data.scope === 'self'`): the Assignee select is not rendered
  on the Time tab, and the per-person section shows the caller's own data regardless
  of `filters.assigneeId`. The existing note ("Showing your own time…") stays.
- To let TeamLayout hide the select, `TeamContext` gains
  `timeSelfScoped: boolean` and `setTimeSelfScoped(v: boolean)`. TimeTab sets it
  after each report fetch; Stats sets it from its own response's `timeScope`. This is
  the one piece of tab-to-shell state; it exists only to hide a control whose every
  choice but one would 403.

### 3.3 `api.ts`

- `fetchTimeReport(since, until, projectSlug?)` and
  `fetchTimeEntries(discordId, since, until, projectSlug?)` append `project=<slug>`
  when set.
- New `fetchProjectStats(since: Date | null, until: Date, projectSlug?: string)` →
  `ProjectStatsPayload` (see §4). Uses the `ApiError` pattern the entries fetch uses.

### 3.4 CSAAS: `project` on the report and entries endpoints

- `discordTimeReport.js` and `discordTimeEntries.js` accept an optional `project`
  query parameter: a `granjur.project.docsSlug`.
- When present, the SQL gains `AND t.projectId IN (SELECT id FROM granjur.project
  WHERE guildConfigId IN (…) AND docsSlug = ?)`. This is a WHERE clause, never a JS
  post-filter, for the same reason the self-scope filter is.
- An unknown slug returns an empty result with the normal 200 shape, not an error.
- Both responses echo `project: <slug> | null` so the client can tell a stale response
  from a current one, the same way `since` is echoed today.
- Entries whose task has no project never match a `project` filter (general work is
  not in any project).

## 4. Stats endpoint (CSAAS)

`GET /api/discord/projects/stats` — `Src/Apis/ProjectSpecificApis/DiscordTasks/discordProjectStats.js`.

Registration mirrors `discordTimeEntries.js`: `accessToken: true`, no encryption,
`permission: null` (the handler decides time scope itself), `bindActorToToken: true`,
parameters `since`, `until`, `project` from `req.query`, all optional.

### 4.1 Request

- `since`: ISO instant, optional. Omitted means all time.
- `until`: ISO instant, optional. Defaults to now.
- `project`: docsSlug, optional. Omitted means every project in the caller's guilds.

### 4.2 Response

```
{
  since: string | null,        // echoed; null when all time
  until: string,
  project: string | null,      // echoed slug
  timeScope: 'all' | 'self',   // same meaning as the time report's `scope`
  approximateCompletion: boolean, // true if any completion was dated by updatedAt
  projects: [{
    id: string, name: string, docsSlug: string | null,
    created:   [{ day: 'YYYY-MM-DD', n: number }],
    completed: [{ day: 'YYYY-MM-DD', n: number }],
    events:    [{ day: 'YYYY-MM-DD', n: number }],
    time:      [{ day: 'YYYY-MM-DD', discordId: string, minutes: number }],
    stale:     [{ taskId: string, title: string, lastActivityAt: string | null }],
    cycleMinutes: number | null
  }]
}
```

- Every series is sparse: only days with data are present, sorted ascending. The
  client fills gaps.
- Buckets are always days. Rolling up to weeks is the client's job.
- Projects with no data in the range are still listed (with empty series), so the
  overview grid can show every project.

### 4.3 Queries (all against `granjur.*`, guild-scoped by `guildConfigId IN (…)`)

- `created`: `SELECT projectId, DATE(createdAt) AS day, COUNT(*) FROM granjur.task
  … GROUP BY projectId, day`.
- `events`: `SELECT t.projectId, DATE(a.createdAt) AS day, COUNT(*) FROM
  granjur.taskactivity a JOIN granjur.task t ON t.id = a.taskId … GROUP BY …`.
- `completed`: `SELECT a.taskId, t.projectId, a.createdAt, a.changes FROM
  granjur.taskactivity a JOIN granjur.task t … WHERE JSON_SEARCH(a.changes, 'one',
  'status', NULL, '$[*].field') IS NOT NULL`, reduced in JS: a row counts when any
  change has `field === 'status'` and `to` in `closed | done | resolved`. One task can
  complete more than once (reopened and closed again); each counts, which is what a
  throughput chart wants.
  - Fallback: a task whose status is terminal but which has **no** status-to-terminal
    activity row at all (finished before migration 021) counts once, dated by
    `task.updatedAt`. When this fallback contributes at least one point,
    `approximateCompletion` is `true` and the client shows a one-line note under the
    chart.
- `time`: `SELECT t.projectId, DATE(c.clockInAt) AS day, c.discordId, SUM(c.minutes)
  FROM granjur.clockentry c JOIN granjur.task t ON t.id = c.taskId … WHERE c.minutes
  IS NOT NULL GROUP BY …`. General work (`taskId IS NULL`) belongs to no project and
  is not in any project's series. Under `timeScope === 'self'` the query adds
  `AND c.discordId = ?` (the caller), as the report does.
  - `DATE(clockInAt)` is the date of the stored digits. The bot writes `clockInAt` in
    its host's local wall clock (see `bot/src/Database/connection.js` and the
    incident note at `bot/src/Database/index.js:1908`), so this is the correct local
    day when the VM's timezone matches the guild's. This is stated in a comment in
    the handler, not silently assumed.
- `stale`: open tasks (status not terminal) in the project whose latest
  `taskactivity.createdAt` — or `task.updatedAt` when there is none — is more than 14
  days before `until`. Capped at 50 per project, oldest first.
- `cycleMinutes`: over tasks that completed in the range (per the `completed`
  rule, first completion per task), the mean of `completedAt − task.createdAt` in
  minutes. `null` when no task completed.
- Range bounds bind through `toMysqlUtc` (imported from `discordTimeReport.js`,
  never copied). `since` omitted drops the lower bound.

### 4.4 Shared time-scope helper

The permission → 403-downgrade → bound-identity resolution is inlined in
`discordTimeReport.js` and repeated in `discordTimeEntries.js`. This endpoint would be
a third copy. It is extracted once into
`Src/Apis/ProjectSpecificApis/DiscordTasks/timeScope.js`:

```
resolveTimeScope({ req, decryptedPayload, hooks }) -> { scope: 'all' | 'self', discordId: string | null }
```

All three endpoints import it. Behaviour is unchanged: only a 403 from the
permission check downgrades to `self`; any other failure is a real error and is
thrown; only the token-bound identity may drive the self lookup. The existing report
and entries tests must still pass after the extraction.

## 5. Stats tab (site)

### 5.1 Navigation

- `teamNav.ts`: `TeamTabKey` gains `'stats'`; `TEAM_TABS` gains `{ key: 'stats',
  label: 'Stats', path: '/tools/team/stats' }` after Time; `activeTab` recognises
  `/stats`.
- `routes.tsx`: `<Route path="stats" element={<Stats />} />` under the Team layout.
- Page width: 1240px like every tab but Board.

### 5.2 Data

- Snapshot: `applyFilters(projects, { ...DEFAULT_FILTERS, projectSlug:
  filters.projectSlug })` — the Project filter only, exactly as People does, so counts
  agree with the Tasks tab. `filters.assigneeId` narrows the per-member sections and
  the stacked time series only; it never changes the project-level completion or
  counts.
- Series: `fetchProjectStats(since, until, filters.projectSlug)` in the tab's own
  effect, keyed by `[range, filters.projectSlug, payload]` (refetches on the shell's
  Refresh like Time does). Own `loading` / `error` state; dims in place on refetch.
- Range state: `'30d' | '90d' | 'all'`, default `'30d'`. `since` = `until − N days`
  at local midnight, or `null` for all. Bucketing: `'30d'` days, otherwise weeks
  (Monday-start, via `weekRange` in `timeLogic.ts`).

### 5.3 No project selected — overview grid

A card per project (`sm:grid-cols-2 xl:grid-cols-3`, the People grid):

- Project name; the lead's name if a member has role `lead`.
- Avatar stack of members (first 5 + "+N").
- Completion ring: `done / total` of the project's tasks, as a percent. `total = 0`
  shows "No tasks".
- Open and blocked counts.
- Time logged in range (when the series include time for anyone), formatted with
  `formatDuration`.
- A sparkline of `events` over the range.
- Clicking the card calls `setFilter({ projectSlug })` and stays on Stats. A
  secondary "View tasks" link goes to `/tools/team/tasks?project=<slug>`.
- Projects with `docsSlug === null` are shown but not clickable (the filter is
  slug-keyed, the same limitation the Project select has); their "View tasks" link
  is omitted.

### 5.4 Project selected — detail

Top to bottom:

1. **KPI row** (tiles): Completion %, Open, In progress, Blocked, Done, Estimate vs
   logged (`logged / estimate` over tasks that have an estimate; "No estimates" when
   none), Avg cycle time (`cycleMinutes` as `formatDuration`; "—" when null).
2. **Members**: one row per project member (explicit and inferred, as the payload
   lists them): avatar, name, role label, a three-segment bar of open / in progress
   / done for that person's tasks in this project, and their time in range. Sorted
   by open desc, then name. With an Assignee filter, only that person is shown.
3. **Graphs**, with the 30 / 90 / all toggle above them:
   - Created vs completed, cumulative, two lines.
   - Task events per bucket, bars.
   - Time logged per bucket, stacked by member, with a legend. Under `self`
     scope this is one series (the caller). With an Assignee filter it is that
     person's series only.
   - Per-member open / in progress / done, horizontal grouped bars (a chart
     view of the Members table; kept because the owner asked for it as a graph).
4. **Stale tasks**: list of `stale` rows, each linking to
   `/tools/team/tasks/<id>`, "No stale tasks" when empty.

### 5.5 Empty and loading

- First load with no payload: the same centred "Loading…" card every tab uses.
- Series loading with a previous result: dim the graphs section only.
- Series error: a red banner above the graphs; the snapshot sections still render.
- A chart with no data in range renders its axes and "Nothing in this range".

## 6. Charts

Directory `src/screens/team/charts/`:

- `StackedBars.tsx` — buckets × series, stacked; legend; hover tooltip per bar.
- `CumulativeLines.tsx` — two series as paths; hover shows both values.
- `Bars.tsx` — single series, vertical; also used horizontally for per-member.
- `Sparkline.tsx` — a bare path, no axes, for the overview cards.

All four take already-scaled data from `statsLogic.ts` and only draw. `statsLogic.ts`
exports, all pure and tested:

- `rangeBounds(kind, now)` → `{ since: Date | null, until: Date }`
- `bucketKeys(since, until, bucket)` → ordered list of day or week keys
- `fillSeries(points, keys)` → dense series (gaps as 0)
- `rollupWeeks(points)` → week-keyed points
- `cumulative(points)`
- `stackByMember(timePoints, keys)` → `{ members: [...], rows: [...] }`
- `completionPercent(tasks)` → `number | null`
- `memberBreakdown(member, tasks)` → `{ open, inProgress, done }`
- `estimateSummary(tasks)` → `{ logged, estimate } | null`
- `xScale` / `yScale` helpers and `linePath(points)` used by the components

Colours: the theme's indigo/mint/amber/red tokens for status; a fixed 8-colour
categorical ramp for members, assigned in roster order; grid lines and text from
`muted(theme)`. Dark and light both verified.

## 7. Permissions

- Task-derived data is visible to any signed-in caller, as the Team section already
  is.
- Time-derived data (time series, time-in-range on cards and members, estimate vs
  logged) follows `timeScope`: `'all'` shows everyone; `'self'` shows only the
  caller's own minutes, with the Time tab's note. No new permission is introduced.
- `timeSelfScoped` in the shell context hides the Assignee select on Time. On Stats
  the select stays (it also narrows task-side sections), but time sections under
  `self` ignore it.

## 8. Error handling

- Site: every fetch has its own `cancelled` flag and its own loading/error, as
  TimeTab does today. A stale response (wrong project or range) is ignored by
  comparing the echoed `project` / `since` to the current selection.
- CSAAS: a failing sub-query fails the request (500 via the framework), except the
  `taskactivity` and `clockentry` reads which `.catch(() => [])` like
  `discordTasks.js` does, so an older bot schema degrades to empty series rather than
  a broken page.

## 9. Testing

- Site (vitest): `statsLogic.test.ts` for every export in §6; `timeLogic.test.ts`
  unchanged plus any helper moved; `teamNav.test.ts` for the new tab. No component
  tests are added (none exist in the section). `tsc` clean.
- CSAAS (`node <file>.test.js`, assert-based, fake `q` and hooks): `timeScope.test.js`
  (403 → self, other errors thrown, identity only from the bound token);
  `discordProjectStats.test.js` (project param bound as a slug, terminal-status
  reduction including the `updatedAt` fallback and the `approximateCompletion` flag,
  self-scope adds the discordId bind, stale cut-off, cycle time mean); existing
  report/entries tests extended with the `project` param.
- No bot changes, so nothing here can touch the production seam rule; CSAAS tests
  never open a real pool.

## 10. Rollout

1. CSAAS first: `timeScope.js` extraction, `project` param, stats endpoint. Backward
   compatible — every new parameter is optional.
2. Site second: shell filter changes, Time tab, Stats tab, charts.
3. Deploy CSAAS before the site. If the site lands first, the Stats tab shows its
   series error banner and the Time tab's project filter is ignored by the server.

## 11. Out of scope

- A per-project page under `/tools/projects`.
- Any bot-side change or new Discord command.
- Exporting stats (the Time tab's CSV covers time; task exports were not asked for).
- Bucketing by the guild's timezone from CSAAS (see §4.3 for why day-of-stored-digits
  is used).
