# Tests must never touch production

The root `.env` in this repo points at the **production** database. There is no
separate test database. Any function under test that queries the database must take a
`db` seam (and, if it needs the guild config, a `getConfig` seam), and every test must
pass fakes for both — never the default `db` export, never the default config lookup.
This applies to every test, including a "red" test written first to demonstrate a bug:
never run a new test against a version of the code that does not honour the `db`/
`getConfig` seams, not even temporarily, not even to prove a failing case before the
fix lands.

On 2026-09-17, during a fix round for `/update-task`, a test run did exactly that — new
execute tests were run against a pre-fix version of `update-task.js` that ignored the
`getConfig` seam and called the real `getOrCreateGuildConfig('guild1')` — and it
inserted a live `guildconfig` row into production (id `b23782a7c09e433bab78d866b`,
`guildId = 'guild1'`, 2026-09-17T10:48:49Z). The row was confirmed read-only (nothing
in any `guildConfigId`-keyed table references it) and left in place pending the owner's
decision rather than deleted unilaterally.
