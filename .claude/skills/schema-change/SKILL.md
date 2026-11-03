---
name: schema-change
description: Checklist for adding or changing a PostgreSQL table/column/index in Mewvo (schema.js, table allowlist, SCHEMA_VERSION bump in .env.example and both workflows, migrate + test:db). Use for any database schema change.
disable-model-invocation: true
argument-hint: "<what changes, e.g. new table mod_watchlist>"
---

# Schema change: $ARGUMENTS

Mewvo has no migration files: `npm run migrate` runs the `CREATE … IF NOT EXISTS` statements in
`src/utils/database/schema.js` and records the expected version. A schema change touches several places
that are easy to forget. Plan first and wait for Ramūnas's OK (CLAUDE.md), then work through every step.

## 0. Decide the version
- Current expected version: `SCHEMA_VERSION` default in `src/config/database/schemaVersion.js` and in `.env.example`.
- Ask whether the live DB is already at that version (Ramūnas runs `SCHEMA_VERSION=<n> npm run migrate:check`
  in the Replit Shell and pastes the output). If live is behind and the current version is not deployed yet, the
  change can fold into it; otherwise bump to n+1.
- **Ask before anything that drops, renames or rewrites existing data.** Additive only by default
  (new tables, new nullable columns, new indexes), so older code keeps working and a rollback stays code-only.

## 1. Code
- [ ] `src/config/database/postgres.js`: add the logical → physical name to `configuredTables` **and** the name to
      `allowedTableIdentifiers` (unlisted names are refused at startup).
- [ ] `src/utils/database/schema.js`: `CREATE TABLE IF NOT EXISTS ${t.<name>} (…)` in `tableStatements`;
      indexes in `indexStatements`; `updated_at` trigger in `triggerDefinitions` if the table has one.
      New columns on existing tables: `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
- [ ] Unique constraints the feature relies on live in the DB, not only in code (e.g. case codes).
- [ ] Data-layer rules (CLAUDE.md): reads throw on DB error, writes succeed or throw, collections in one
      transaction, config updates row-locked (`SELECT … FOR UPDATE`) or atomic SQL.

## 2. Version bump (all four, same number)
- [ ] `src/config/database/schemaVersion.js` default (`process.env.SCHEMA_VERSION || '<n>'`).
- [ ] `.env.example`: `SCHEMA_VERSION=<n>` and `SCHEMA_VERSION_LABEL=baseline-v<n>`.
- [ ] `.github/workflows/migration-version-check.yml`: `SCHEMA_VERSION` + `SCHEMA_VERSION_LABEL`.
- [ ] `.github/workflows/restore-drill.yml`: `SCHEMA_VERSION` + `SCHEMA_VERSION_LABEL`.
- [ ] Find leftovers: `grep -rn "baseline-v<old>\|SCHEMA_VERSION.*<old>" --exclude-dir=node_modules .`

## 3. Verify locally (test DB only, never a remote host)
- [ ] `docker ps` shows `mewvo-test-db` running.
- [ ] `npm run migrate:test`, then `SCHEMA_VERSION=<n> npm run test:db` (refuses non-local DBs) and `npm test`.
- [ ] Add a `tests/db/` test that exercises the new table, including a failure path (DB error → throws).
- [ ] `node --check` on every changed file (the PostToolUse hook does this on edit).

## 4. Report and hand over
- [ ] Report: files changed, test counts actually seen, what was not tested, decisions you made.
- [ ] Deploy needs (for the deploy proposal, owner OK required): `npm run migrate`, `migrate:check` expecting
      v<n>, Replit secret `SCHEMA_VERSION=<n>` (+ label), and whether the change is additive (rollback = code only).
- [ ] Note the new version in `plan.md` and propose the CLAUDE.md line ("Needs SCHEMA_VERSION=<n> …") as a diff.
