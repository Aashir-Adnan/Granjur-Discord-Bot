# Rules index

Binding guardrails. Each rule is its own `.md` file and must also be listed under
"Rules" in the root `CLAUDE.md`.

- [tests-never-touch-production.md](tests-never-touch-production.md) — the root `.env`
  points at production; every test must use `db`/`getConfig` seams, with no exception
  for a first "red" run.
