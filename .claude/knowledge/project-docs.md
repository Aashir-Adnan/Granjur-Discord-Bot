# Project documentation: sync, storage, and browsing

How UBS-Doc's markdown reaches Discord. Read this before touching `/docs`, `/projects`,
`/edit-docs`, the `#documentation` channel, or `bot/src/services/docsSync.js`.

## The shape of it

```
github.com/Aashir-Adnan/UBS-Doc (public, branch main)
        |  every 15 min: 1 API call for the head SHA; on change, 1 tree call
        |  file content from raw.githubusercontent.com (not rate-limited like the API)
        v
MySQL: docpage (one row per markdown file) + docsource (per-guild sync state)
        |  every Discord surface reads ONLY from here. Never GitHub at interaction time.
        v
/docs (browse, search, embed pages)   #documentation channel   /edit-docs (write local pages)
        |
        +--> "Read full page" link to https://ubs-doc.vercel.app/docs/<docId>
```

Writing back to UBS-Doc is **not implemented**. Nothing on this path issues a GitHub write.

## Tables (migration `012_doc_pages.sql`)

`docpage` — `path` (`docs/api/overview.md`), `docId` (`api/overview`, which is also the site
route), `section` (first segment under `docs/`), `projectId`, `title`, `content` (MEDIUMTEXT —
the largest real doc is 104 KB, and TEXT caps at 64 KB), `source`, `blobSha`, `size`.
`UNIQUE (guildConfigId, path)` and `FULLTEXT (title, content)`.

`docsource` — one row per guild: repo owner/name/branch, `siteUrl`, `lastCommitSha`,
`lastSyncedAt`, `lastError`.

**Both tables pin `COLLATE=utf8mb4_general_ci` at table level.** The schema's default is
`utf8mb4_0900_ai_ci` but every existing table is `general_ci`, so a foreign key to
`guildconfig.id` or `project.id` fails with ER_FK_INCOMPATIBLE_COLUMNS without it.
`007_meeting_records.sql` does the same, for the same reason.

## `source`: the two kinds of page

- `'repo'` — mirrored from UBS-Doc. Read-only in Discord; the site is its source of truth.
  Gets a "Read full page" link.
- `'local'` — written from Discord via `/edit-docs`. Lives **only** in MySQL, has no site
  page, and therefore no link.

The two protections run in opposite directions and both matter:
- The sync's delete pass is scoped to `source='repo'`, and it **skips any path held by a
  local row** rather than overwriting it.
- `/edit-docs` refuses to write to a path held by a repo row, and its write uses
  `docPageUpsertLocal`, whose conditional `ON DUPLICATE KEY UPDATE` leaves a `'repo'` row
  byte-identical even if the check is raced by a sync.

## Attribution: which project owns a page

Purely by path prefix, computed in `attributeProject` (`bot/src/utils/docPath.js`):

- `docs/projects/<project.docsSlug>/**`, plus
- every prefix in `project.docsPaths` (a JSON array, relative to `docs/`).

Matching is on whole directory segments, so a project slugged `hms` never captures
`hms-other`. Badar HMS has `docsSlug 'badar-hms'` and `docsPaths ["hms-documentation"]`,
which is what attributes 138 of the 173 pages to it.

**Re-attribution runs on every sync cycle, including the one that short-circuits on an
unchanged head SHA**, and writes only rows whose attribution actually changed. This is
load-bearing: without it, creating a project would never attribute the already-synced corpus,
and `/projects` tells the manager to sync expecting exactly that. `/projects` and `/repos`
also trigger it directly after creating a project.

## Sync safety rules — do not weaken these

The head SHA is recorded only when the mirror is known complete. Recording it early is what
makes damage permanent, because the next cycle then short-circuits and never repairs itself.
Three conditions each suppress **both** the delete pass and the head-SHA write:

1. a truncated tree response from GitHub,
2. an empty document list after filtering,
3. any per-file fetch failure.

Per-file failures are isolated — one bad file no longer abandons the rest of the cycle.

## Discord limits that shape the code

- A select option value, an option label, an autocomplete choice value and a `custom_id` all
  cap at **100 characters**, and the longest `docId` in this corpus is **103**. So components
  address a page by its 25-character row `id`; `docId` is only for display, the site URL, and
  DB lookups.
- An embed description caps at 4096. Pages are rendered and split at 3800 by `paginate`,
  which never splits a code fence — an oversized fenced block becomes several individually
  complete fenced blocks.
- A select menu holds 25 options. `childOptions` pages with a constant stride of 23,
  reserving one slot for the escape row and one for "Next" on every page. The stride must not
  vary with whether the escape row is present, or pages overlap and entries become
  unreachable.
- Every level carries an escape: `back:<parent>` below the scope root, `root:` at it.

## Gotchas that cost time

- `sectionOf('docs/init.md')` returns `'init.md'`, because a loose file at the top of `docs/`
  has no directory. `childOptions` therefore only treats a section name as a path base when
  some row actually lives under `<section>/`. Without that check, the five loose root files
  are invisible to the browser.
- `GITHUB_TOKEN` in `.env` is dead. The sync detects a 401, warns **once per process**, and
  continues unauthenticated — the repository is public and raw content is not on the API
  budget. Only a 401 disables the token; a 403 must not, or a rate limit would silently
  downgrade a good token for the life of the process.
- `db.projectSchema` reads the `projectschema` table, which has **0 rows**. The table with
  data is `project_schemas`, an unrelated dump-versioning table. `/create-task`, `/feature`,
  `/project-db` and `/create-project-categories` still read the empty one — see the backlog.
- `query()` uses `pool.execute`, i.e. prepared statements, where a bound `LIMIT` is sent as a
  string and rejected by MySQL. `docPageSearch` inlines a clamped integer instead.

## Related

[[meeting-audio-recording]], [[schedule-meetings]]
