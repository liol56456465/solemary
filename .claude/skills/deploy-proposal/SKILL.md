---
name: deploy-proposal
description: Prepare a Replit deploy proposal for Mewvo (unpushed/undeployed commits, schema version, read-only checks, exact Shell steps, risks, rollback, smoke test). Produces text only; Ramūnas runs every production step himself after his explicit OK.
disable-model-invocation: true
argument-hint: "[target branch, default: current branch]"
---

# Deploy proposal

**Nothing here changes production.** Production = what Replit runs (branch switch, pull, install, migrate,
secrets, Republish). You only write the proposal; Ramūnas decides and runs it. Never open the production URL
or connect to the live DB. Never ask for or paste secret values; refer to secrets by name.

## 1. Gather facts (local, read-only)
- Branch: `$ARGUMENTS` or the current branch. `git status --short`, `git log --oneline origin/<branch>..HEAD`
  (unpushed) — if anything is unpushed, say a push is needed first and wait for "push" (gitleaks pre-push must pass).
- What Replit runs now: unknown until Ramūnas pastes it. Check `plan.md` (newest "RESUME HERE") and memory for the
  last confirmed live commit and live schema version; mark anything unconfirmed as `[I#]`.
- Commits the pull would bring in: `git log --oneline <live>..origin/<branch>`; group them by feature in plain words.
- Schema: expected version in `src/config/database/schemaVersion.js`; `git diff <live>..origin/<branch> --stat -- src/utils/database/schema.js`
  and check the diff is additive only (no DROP/RENAME/ALTER TYPE). Anything else → flag and ask.
- New env variables: `git diff <live>..origin/<branch> -- .env.example` (names only).
- Tests: run `npm test` and (if schema changed) `SCHEMA_VERSION=<n> npm run test:db`; report the counts you saw.

## 2. Write the proposal (this order)
A. **Read-only checks** for the Replit Shell, to paste back: `git log --oneline -3`, `git status --short`,
   `SCHEMA_VERSION=<n> npm run migrate:check`, `npm run db:check` (prints the DB host only).
B. **What changes** for users, in plain words, plus risks (Discord-visible behaviour, permissions, cron, DMs).
C. **Secrets** to add/change in Deployments → Secrets (names and non-secret values only, e.g. `SCHEMA_VERSION=<n>`).
   Production must keep `NODE_ENV=production`, `LOG_LEVEL=info`; never `ALLOW_MEMORY_DB` / `ALLOW_WORKSPACE_BOT`.
D. **Shell steps**: `git pull --no-rebase --no-edit origin <branch>` → `npm install` → `npm run migrate` (only if
   the schema changed) → `npm run migrate:check` (expect "passed (v<n>)") → Republish.
E. **Smoke test** after Republish: `/health` shows postgresql, then short steps with the expected result each.
F. **Rollback**: Deployments → previous deployment → Redeploy; set `SCHEMA_VERSION` back if needed. Additive schema
   means rolling back the code is enough.

## 3. Stop
End with: "Nothing has been changed on Replit. Reply OK to proceed, or tell me what to change." Then wait.
After he reports the result, update `plan.md` (live commit, schema version, date).
