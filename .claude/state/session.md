# Current Session

**Date:** 2026-09-25

## Goal
Per-project status buckets for ticket channels: every project's ticket channels group by
status (Open / In progress / Done) into three sibling categories under the project's
section, moving between them on any status write, with a 14-day locked retention for
Done instead of `/close-feature`/`/resolve-bug`'s old five-minute delete.

## Outcome — BUILT, AWAITING MERGE
Brainstorm → spec → plan → 9 implementation tasks (each with a fresh implementer and
reviewer) → this documentation task (Task 10). Commits `d635188..e691909` on
`feat/status-buckets` (base `56f4e56`), plus this task's docs commit. Not yet merged to
`main`, not yet deployed.

Knowledge in use: `.claude/knowledge/status-buckets.md` (new this session),
`.claude/knowledge/project-sections.md` (updated — the bucket feature sits inside the
section it describes). Rule in force: `.claude/rules/tests-never-touch-production.md`.

## What Task 10 did
Wrote `.claude/knowledge/status-buckets.md` (bucket table and leaf placement, where ids
are stored and what that buys, creation placement order and `fellBack`/`placed`, the
mover, the Done transition, `/project-setup`'s bucket steps, `/close-feature`/
`/resolve-bug`, what clients see, known limitations, rollout). Updated
`project-sections.md` (task channels now point at the new file; `/cleanup`'s `categoryIds`
note; the section-channel room note) and `README.md`. Appended a dated Corrections
section (§15) to `docs/superpowers/specs/2026-09-24-status-buckets-design.md` recording
five deviations ruled during the build. Updated the three state files.

## Branch fix round 1 (2026-09-25, after the whole-branch review)
Five confirmed findings on tasks 8/9, all fixed in one commit on `feat/status-buckets`:
F1 bucket position edits mixed `rawPosition` (raw gateway value) with `edit({ position })`
(sorted index) — both sides now use the `position` getter; F2 step 2b assigned the bucket
ids AFTER the repair edit, so a refused repair un-filed every ticket bound for that bucket
and called it "could not be created" — the ids are now bound before the edit; F3
`projectFromChannel` ignored bucket ids, so no command run inside a ticket channel could
infer its project — it now matches `bucketIdsOf(p)` too, duplicate-id rule across the whole
set; F4 `renderResult`'s bucket line double-counted creates already in `result.created` —
reworded to "N of those created"; F5 `intoBuckets` hardcoded the bucket keys — now
`BUCKETS.map((b) => b.key)`. Three new tests, two existing expectations updated
(`rawPosition` → `position`, the bucket reply wording). Full suite 1172 pass / 0 fail.
Report: `.superpowers/sdd/2026-09-24-status-buckets/task-8-report.md` → "Branch fix round 1".

## Open items before merge
See `backlog.md` → "Status buckets — deferred follow-ups" for every parked minor from the
build's reviews (none blocks merge). Beyond that:
- No live acceptance run yet — the rollout procedure (`/project-setup project:<X>
  preview:true` then for real, per project) has not been exercised against the real guild.
- Decide when to merge and deploy; migration `026_task_channel_retire.sql` runs on the VM
  at deploy time.

## Next session
If nothing else is queued, either merge `feat/status-buckets` to `main` and run the
rollout per project, or pick up the next item at the top of `backlog.md`.
