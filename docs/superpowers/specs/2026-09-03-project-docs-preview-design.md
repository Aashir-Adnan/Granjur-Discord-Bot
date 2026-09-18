# Project documentation + preview in the Granjur Discord bot

**Date:** 2026-09-03
**Status:** approved design, not yet implemented
**Scope:** read-only. Writing back to UBS-Doc is explicitly out of scope (see Phase 2).

---

## 1. Goal

Make every document in the `UBS-Doc` repository readable from Discord, organised by
project, with a link out to the published site for anything that does not fit an embed.
Also close the gap that projects and project docs currently have no command that
creates them.

## 2. The source repository

`https://github.com/Aashir-Adnan/UBS-Doc` — public, default branch `main`, already
present in the bot's `repository` table.

It is a Vite + React SPA (not Docusaurus any more; see `docs-engine-diagram.md` in that
repo). Two properties matter here:

- **Every markdown file under `docs/` is routable by URL**, whether or not
  `src/docs/sidebar.ts` lists it. `src/docs/docsIndex.ts` globs
  `['/docs/**/*.md', '/docs/**/*.mdx', '!/docs/superpowers/**']` and derives the route
  id by stripping the `docs/` prefix and the extension. We mirror that rule exactly.
- The glob is `import.meta.glob`, resolved at **build time**. A file only becomes
  reachable after a Vercel rebuild. This does not affect Phase 1 (we never write), but
  it is the reason Phase 2 has to wait for a merge before its link works.

**Deep link:** `https://ubs-doc.vercel.app/docs/<docId>`. For example
`docs/hms-documentation/major-implementations/booking-rules/booking-rules-requirements.md`
becomes
`https://ubs-doc.vercel.app/docs/hms-documentation/major-implementations/booking-rules/booking-rules-requirements`.

**Corpus as of 2026-09-03:** 173 `.md`/`.mdx` files under `docs/` excluding
`docs/superpowers/`, ~2.0 MB total, mean 11.8 KB, largest 104 KB
(`docs/hms-documentation/tenant-creation-flow/04-services.md`). Section spread:
`hms-documentation` 132, `api` 10, `backend` 10, `projects` 6, `frontend` 4,
`database`/`agents`/`intro` 2 each, and 4 loose root files. Also present and skipped:
`_category_.json` files and three `.pdf`.

## 3. Decisions

| Question | Decision |
|---|---|
| Where is a doc read? | Discord embed first; "Read full page" link to the site as fallback |
| Where do Discord-authored docs live? | MySQL only, for now. Committing to UBS-Doc is Phase 2 |
| Where does the bot read from? | MySQL, populated by a sync job. Never GitHub at interaction time |
| What triggers a sync? | 15-minute timer plus a manual manager-only trigger |
| Doc to project mapping | Path prefix: `docs/projects/<slug>/**`, plus per-project extra prefixes |
| `hms-documentation` | Belongs to the existing **Badar HMS** project, via an extra prefix |
| Discord surface | One rebuilt `/docs`; the `bot/docs/` disk browser is retired |

## 4. Existing behaviour this replaces

- `/docs` browses `.md` files on the bot's own disk in `bot/docs/` — six files unrelated
  to any project. The command stops reading that directory; the directory itself is left
  on disk untouched, since nothing else in this design depends on it either way.
- `docTraversal.js` and `edit-docs.js` both read `db.projectSchema`, i.e. the
  `projectschema` table, which has **0 rows**. The live table with data is
  `project_schemas`, an unrelated dump-versioning table (`id, project_id, name,
  latest_dump_id`). Both call sites are dead and get rebuilt against `docpage`.
- `/repos` collects a project name in its modal, shows it in the confirmation embed, and
  then inserts only `{name, url}` — the project name is discarded and `project_repos` is
  never written. Fixed here.
- `db.project.create` exists and is called from nowhere; the 8 project rows were inserted
  by running `bot/scripts/seed-projects.js` by hand. Replaced by `/projects`.

## 5. Data model — migration `012_doc_pages.sql`

Follows the conventions of the existing tables (`VARCHAR(36)` ids from `helpers.id()`,
`guildConfigId` FK to `guildconfig` with `ON DELETE CASCADE`, `DATETIME(3)` timestamps)
and the `information_schema` existence guard used by migrations 010 and 011, so it is
safe to re-run.

### `docpage`

| Column | Type | Notes |
|---|---|---|
| `id` | VARCHAR(36) PK | |
| `guildConfigId` | VARCHAR(36) NOT NULL | FK to `guildconfig(id)` |
| `path` | VARCHAR(512) NOT NULL | `docs/api/overview.md` |
| `docId` | VARCHAR(512) NOT NULL | `api/overview` — the site route id |
| `section` | VARCHAR(128) NOT NULL | first path segment under `docs/` |
| `projectId` | VARCHAR(36) NULL | FK to `project(id)` ON DELETE SET NULL |
| `title` | VARCHAR(512) NOT NULL | |
| `content` | MEDIUMTEXT | `TEXT` caps at 64 KB; one doc is 104 KB |
| `source` | VARCHAR(16) NOT NULL | `'repo'` or `'local'` |
| `blobSha` | VARCHAR(64) NULL | git blob sha; NULL for `'local'` |
| `size` | INT NOT NULL DEFAULT 0 | |
| `createdAt` / `updatedAt` | DATETIME(3) | |

Indexes: `UNIQUE (guildConfigId, path)`, `KEY (guildConfigId, projectId)`,
`KEY (guildConfigId, section)`, `FULLTEXT (title, content)`.

### `docsource`

One row per guild: `id`, `guildConfigId` (UNIQUE), `owner` (`Aashir-Adnan`), `repo`
(`UBS-Doc`), `branch` (`main`), `siteUrl` (`https://ubs-doc.vercel.app`),
`lastCommitSha`, `lastSyncedAt`, `lastError`, timestamps. Seeded from env on first use,
editable via `/setup`.

### `project` — two added columns

- `docsSlug VARCHAR(128) NULL` — the directory under `docs/projects/`. Defaults to the
  slugified name (`Badar HMS` becomes `badar-hms`), which already matches the repo.
- `docsPaths JSON NULL` — extra path prefixes owned by this project, relative to `docs/`.

Badar HMS is seeded with `docsSlug = 'badar-hms'` and `docsPaths = ["hms-documentation"]`
by migration 012 itself, as an `UPDATE ... WHERE name = 'Badar HMS'` guarded so it is a
no-op if the row is absent. That single seeded row is what attributes those 132 files.
Every other project gets `docsSlug` from its slugified name on first sync.

### DB surface

`db.docPage.*` and `db.docSource.*` are added to `bot/src/Database/index.js` next to
`ticketDoc`, written in the same style (hand-rolled SQL, `queryOne` for reads after a
write): `docPage.findMany / findFirst / search / upsert / deleteByPaths / countByProject`,
and `docSource.get / upsert / recordSync / recordError`.

## 6. Sync service — `bot/src/services/docsSync.js`

Started from `bot/src/index.js` alongside `startMeetingReminder` and
`startTicketReminder`, using the same `setInterval` shape as `meetingReminder.js`.
Interval 15 minutes.

Each cycle iterates the guilds in `client.guilds.cache` and syncs each one that has a
`docsource` row, exactly as the reminder loops iterate guilds. In practice that is one
guild; the per-guild shape exists only to match every other table in this schema.

For each such guild:

1. `GET /repos/{owner}/{repo}/commits/{branch}` for the head SHA. **One call.** If it
   equals `docsource.lastCommitSha`, stop. This is the steady-state cost.
2. `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1` returns every path, blob
   SHA and size in one response.
3. Keep entries under `docs/` ending in `.md` or `.mdx`, excluding `docs/superpowers/**`.
4. Diff blob SHAs against the stored `docpage.blobSha`. Fetch only new or changed files
   from `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}` — raw is not
   subject to the API rate limit, so a cold start of 173 files works even with the token
   dead or absent.
5. Delete rows whose path vanished from the tree, **`WHERE source = 'repo'` only**, so a
   locally authored doc can never be removed by a pull.
6. Record the head SHA and `lastSyncedAt`; clear `lastError`.

**Derivations.** `docId` is the path minus `docs/` and the extension. `section` is the
first segment. `projectId` is the project whose `docs/projects/<docsSlug>/` or one of
whose `docsPaths` prefixes the path, otherwise NULL. `title` is the frontmatter `title:`,
else the first `#` heading, else the filename humanized.

**Manual trigger** lives on `/setup`, already the manager-only config command, rather
than a new command.

## 7. Discord surface

### `/docs [query]`

- **With `query`** — the option is autocompleted against the corpus, so typing "tenancy"
  offers up to 25 matching titles and picking one opens that doc directly. This is the
  search feature; there is no separate search subcommand. Autocomplete uses
  `MATCH(title, content) AGAINST (? IN BOOLEAN MODE)` with a trailing `*`, falling back
  to `LIKE` on `title` for queries shorter than InnoDB's minimum token length of 3.
- **Without `query`** — a root select menu offering **Projects** plus the framework
  sections. Projects lists only projects that have at least one doc. From there it is a
  directory walk reusing the existing `dir:` / `file:` / `back:` value scheme in
  `docs.js`, so the `handleDocsBrowse` interaction routing survives. Directories with
  more than 25 entries get a "Next 25" option.
- **Reading** — an embed with title and breadcrumb, content paged at roughly 3800
  characters on paragraph boundaries, previous/next buttons, `page 2/9` in the footer,
  and a link button **"Read full page"** pointing at `<siteUrl>/docs/<docId>`. Local docs
  (`source='local'`) are tagged and have no link button, because they are not on the site.

### `/projects`

Manager-only. Lists projects with their doc counts, plus:

- **Add project** — a modal taking name, docs slug (prefilled from the slugified name),
  and extra doc paths (comma separated). Writes a `project` row through the existing
  unused `db.project.create`, extended for the two new columns.
- **Link repo** — select a repo and a project, writing the `project_repos` row that
  `/repos` currently drops.

`/repos` is also fixed at its source: its confirm handler creates or finds the named
project and writes the join row.

### `/edit-docs`

Repurposed from its dead `projectSchema` path: pick a project, then either a new doc or
an existing local one, then provide content either through a modal (Discord caps a modal
input at 4000 characters) or by attaching a `.md` file, reusing the attachment pattern
already in `resolve-bug.js`. Saves a `docpage` row with `source='local'`, a `path` of
`docs/projects/<docsSlug>/<slug>.md`, and no `blobSha`.

Docs with `source='repo'` are **read-only in Phase 1** and are not offered for editing.
UBS-Doc is their source of truth, so an edit made here would be silently reverted by the
next sync. Editing them becomes possible only when Phase 2 can push the change back.

### `#documentation` channel

`docTraversal.js` is rebuilt to source its project list from `docpage` rather than the
empty `projectschema` table.

## 8. Rendering markdown into an embed

Mirrors what the site does, so both surfaces agree:

- Strip YAML frontmatter.
- Turn `:::note[Title]`, `tip`, `warning` and `danger` admonitions into a bold title line
  plus a blockquote (the site equivalent is `remarkAdmonitions.ts`).
- Drop MDX `import`/`export` lines and bare JSX tags.
- Rewrite relative `./other.md` links to `<siteUrl>/docs/<docId>` (the site equivalent is
  `remarkDocLinks.ts`).
- Keep fenced code blocks intact and never split a page mid-fence.
- Tables and images survive as raw markdown text — Discord will not render them, which is
  precisely what the "Read full page" button is for.

## 9. Error handling

Sync failures write `docsource.lastError` and log; they never propagate into an
interaction. Browsing always serves whatever MySQL holds, so a GitHub outage, a dead
token, or a rate limit degrades to stale content rather than a broken command. A `docId`
that no longer exists renders "not found — docs may be out of date" together with
`lastSyncedAt`. Interaction handlers keep the existing `.catch(() => {})` convention on
`editReply`.

## 10. Testing

The repo currently has no test framework, no `test` script, and no test files. This adds
`node:test` (built into Node 24, zero dependencies), an `npm test` script running
`node --test bot/test/`, and tests under `bot/test/`.

Unit tested, all pure functions with no network and no database:

- path to `docId` and `section`, and the include/exclude filter
- path to project attribution, including the `docsPaths` prefix case
- title extraction: frontmatter, `#` heading, filename fallback
- the markdown to Discord transformation
- the pager: boundaries, never splitting a code fence, correct `page n/N`

Sync logic is tested against a captured tree fixture so it runs offline: an unchanged
head SHA short-circuits, a changed blob re-fetches, a vanished path deletes, and a
vanished path with `source='local'` does **not** delete.

Live verification in Discord happens after stopping the VM instance
(`pm2 stop granjur-bot`), because the deployed bot shares this token and database.

## 11. Configuration

New environment variables, each with a default so nothing breaks if unset:
`DOCS_REPO_OWNER=Aashir-Adnan`, `DOCS_REPO_NAME=UBS-Doc`, `DOCS_REPO_BRANCH=main`,
`DOCS_SITE_URL=https://ubs-doc.vercel.app`, `DOCS_SYNC_INTERVAL_MS=900000`.

`GITHUB_TOKEN` in `.env` is currently invalid — GitHub returns `401 Bad credentials`.
Phase 1 works without it because content comes from `raw.githubusercontent.com` and the
repository is public; a valid token only raises the API budget from 60/hr to 5000/hr for
the two metadata calls per cycle.

## 12. Out of scope (Phase 2)

Committing Discord-authored docs back to UBS-Doc as a PR per doc, merged by a human.
Phase 1 is deliberately shaped so this is additive: the `source` column already
distinguishes local docs, and Phase 2 becomes "commit the `'local'` rows, flip them to
`'repo'` on merge". It needs a GitHub PAT with Contents: write and Pull requests: write
on `Aashir-Adnan/UBS-Doc`, and a doc's site link stays dead until the merge triggers a
Vercel rebuild.

Also out of scope: editing `src/docs/sidebar.ts` so new docs appear in the site's
navigation tree, and any change to UBS-Doc's hosting.
