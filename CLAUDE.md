# CLAUDE.md — Mewvo Discord bot

Owner: Ramūnas. Bot name: **Mewvo**. Fork of TitanBot v2.1.0, now heavily customized.
Read this file first. Task list and resume notes: `plan.md` (repo root, not committed).

## Hard rules (never break)

- **No production changes without explicit OK from Ramūnas.** Production = what Replit runs:
  branch switch, pull, republish, deployment secrets. Propose, explain why, wait.
- Never commit to `main` directly. Work on feature branches; one commit per phase/fix.
- The repo is **public** (github.com/liol56456465/solemary): anything committed or pushed is world-readable.
- Never print, log, commit or paste secrets (`DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`,
  `OAUTH_TOKEN_KEY`, `SESSION_SECRET`, DB URLs with passwords). Local secrets live outside the repo in
  `~/.config/mewvo/` (`env.test`, `env.prod`); Claude must not read them (deny rule + `.claude/hooks/no-env-secrets.mjs`).
  `.env.example` contains placeholders only. The leak check (gitleaks) must pass before any push:
  pre-push hook `scripts/git-hooks/pre-push` (install: copy to `.git/hooks/`) + CI `.github/workflows/gitleaks.yml`.
  Old, already reset tokens are listed in `.gitleaksignore`; add to it only for verified-dead findings.
- Never boot the bot locally against the real servers (there is no local dev environment; see "Testing").
- Ask before any migration that drops or rewrites existing data.
- Don't rewrite git history (old token leak was handled by resetting the token, not by force-push).
- Don't "fix" things listed as "done well" in the audit.
- Browser tools (playwright, chrome-devtools MCP): **localhost / 127.0.0.1 only**. Never open
  `meowist--sxexx.replit.app` or any other non-local URL. Enforced by `.claude/hooks/local-browser-only.mjs`.
- context7 lookups: never put secrets, tokens, real user data or env values in a query.

## How to work with Ramūnas

- Plan first for anything non-trivial; wait for OK before writing code.
- Report clearly: what changed, what was **verified by actually running it**, what was NOT tested,
  and every decision you made that he didn't specify.
- Mark unverified assumptions as `[I#]` and verify or refute them with `file:line`. Never present guesses as facts.
- When you need output from Replit or Discord, give exact read-only commands for him to run and paste back.
- He tests in real Discord himself; give him short test scripts with the expected result per step.
- At the end of each task, propose CLAUDE.md updates as a diff for his review (keep the file under 200 lines).

## Stack

- Node >= 22.12 (LTS; 20 is EOL), ESM (`"type": "module"`), discord.js v14, Express v5, PostgreSQL via `pg`, node-cron, Winston.
- Music was removed (no Riffy/Lavalink). Web dashboard: same Express server, `/dashboard` (`src/services/dashboard/`).
- Entry: `src/app.js` (`npm start`; `index.js` only imports it). Data flow: `commands → handlers → services → utils`.

## Commands

- `npm start` — production start. `npm run start:test` — test mode (`NODE_ENV=test`; see "Testing").
- `npm test` — unit tests. `npm run test:db` — DB failure-injection tests (refuses non-local DBs). Run on Node 22
  (`nvm use` reads `.nvmrc`; the shell default is 20, where the test globs find nothing). Don't change nvm's default.
- `npm run migrate` / `migrate:check` / `migrate:status`.
- `npm run restore:db` / `backup:drill`: a non-local target needs `--confirm-host=<host>` (protects the live DB).
- Syntax check changed files: `node --check <file>` (runs automatically after Claude edits: `.claude/hooks/node-check.mjs`).
- Claude Code: `/schema-change` for any DB schema change, `/deploy-proposal` (Ramūnas runs it) before a deploy,
  `discord-reviewer` agent before committing bot code. Use the npm scripts, never a direct `--env-file`.

## Structure (key places)

- `src/commands/<Category>/` — slash commands. `src/events/` — gateway events.
- `src/interactions/{buttons,selectMenus,modals}/` — handlers, routed by `customId.split(':')[0]`.
- `src/services/enforcement/` — cases, ladder, mutes, DM templates (`db.js` uses Postgres directly, no memory fallback).
- `src/utils/commandGate.js` — access rules. `src/config/` — bot config, reasons list, test mode.
- `src/utils/database/schema.js` — tables (`CREATE … IF NOT EXISTS`); new tables must also be added to the
  allowlist in `src/config/database/postgres.js`. Bump `SCHEMA_VERSION` in `.env.example` and both workflows.
- Logging: use `loggingService.logEvent({client, guildId, eventType, data})`, not `logModerationAction`.

## Servers and IDs (not secrets)

- Main Mewvo server: `1527697154926182492`. Support server: `1564312871976829009`.
- Admin-request channel: `1527697155643408442`. Banned role (support server): `1564363121685176320`.
- Client ID: `1531096173786566697`. Support invite: `https://discord.gg/7Ckv9Bt577` (permanent).
- Production URL: `https://meowist--sxexx.replit.app` (port 5000).

## Access model

- Harmless/personal commands (help, rank, level, leaderboard, fun, todo, report…) are open to everyone.
- Everything that moderates, changes config, posts as the bot, affects other members or moves currency
  is Administrator-only. **New or unlisted commands default to Administrator-only.**
- Non-admins get: "You need the Administrator role… Request a mod/admin role here: <#1527697155643408442>".
- Commands stay visible (no `default_member_permissions`); the check runs in the dispatcher.
- `OWNER_IDS` = emergency override; keep it set in production.
- All commands register in the main server only (61 slash + 3 menus at last boot; limit 100). Prefer subcommands.
- `RETIRE_ADMIN_COMMANDS=true` (off by default): only everyone-commands + owner-only kit (/enforcements, /automod
  panic|lockdown-end, /staff restore, /backup) are registered; other keys answer with their dashboard page
  (`config/commands/retirement.js`). The Commands page lists all 175 entries and where each lives.

## Enforcement system

- `/enforcements user|user_id` → ephemeral panel: Ban, Kick, Mute, Warn, Unban, Unmute, Remove warn.
  Flow: action → reason (prebuilt with `severe` flag, or custom) → duration/name/unappealable → confirm.
- Custom IDs: `enf:<step>:<modId>:<targetId>:<nonce>`. Re-check the moderator + Administrator on every interaction.
  Defer within 3 s. Panel state is a bounded TTL map; on expiry reply "This panel expired, run /enforcements again".
- Hierarchy: refuse owner, bot, self, equal/higher roles.
- **DM before kick/ban executes**; if the DM fails, still act and tell the moderator (`dm_delivered=false`).
  DMs show `<t:UNIX:F>` + `<t:UNIX:R>`, case code, appeal link (or "cannot be appealed").
- Kick and accepted appeals include a fresh one-time invite (maxUses 1, 7 days).
- Mute = managed "Muted" role (not timeout): deny overwrites on all channels, also on `channelCreate`,
  re-applied on rejoin, voice disconnect.
- Case codes: 5–7 chars, lowercase alphanumerics without look-alikes (0 o 1 l i), globally unique (DB constraint).
- Tables: `mod_cases`, `mod_ladder` (row-locked with `SELECT … FOR UPDATE`), `mod_appeals`, `mod_case_edits`,
  `mod_case_evidence`. OAuth tokens/state live in the key-value store (`setInDb`), not their own tables.
- Expiry cron (once a minute, with overlap guard) handles unban/unmute/6-month appeal deadline; also runs at startup.
- Mass-action guard: >5 bans/kicks in 10 min per moderator → blocked 60 min, OWNER_IDS DM'd
  (`MASS_ACTION_*` env); mutes count separately (`MASS_MUTE_LIMIT` 10). `/staff restore` lifts it. OWNER_IDS are
  never blocked; their actions without Administrator are logged as "owner override" (bot log + mod log).
- `/background` — case history per user (with `name` autocomplete). `/test action user` — sends the exact
  DM preview **to the invoker**, executes nothing, footer "Simulation — no action taken".
- Watchlist (`mod_watchlist`, v9): `/case watch add|list|end`, mod-log alerts, `/background` line, dashboard card.

## Warn ladder (per guild + user, never resets)

- Warns 1–2: DM "Warning X of 3". Warn 3 → automatic 7-day ban (level 1).
- First warn after returning from level 1 → 30-day ban (level 2). Next → permanent ban (level 3),
  appealable for 6 months; after that or after a denied appeal → unappealable.
- Manual bans don't move the ladder. Remove warn lowers the count. Accepted ladder-ban appeal: level −1 (not below 0).
- Imported legacy warns are history only (`is_imported`), not counted.

## Appeals and reports

- `/setappeal [channel]` posts appeal panels (main + Support `#appeals`); re-running replaces old panels.
- Appeal form: why punished / why lift / did you do it (Yes/Partly/No). Case code optional (latest appealable case).
- Ban/kick appeals → conversation channel in Support (`APPEALS_CATEGORY_ID`), appellant added, safe summary only;
  dossier + Accept/Deny in an admin-only main-server staff channel (no threads). Mute/warn → main, staff-only. Appeals, reports, modmail have their own categories; open reports + modmail capped (`OPEN_CHANNEL_CAP` 20),
  appeals never capped. One pending appeal per case; 7-day cooldown after a denial.
- `/appeals code decision:accept|deny note` (main server). Accept lifts what's active and DMs an invite.
- Staff reports: one open per person, max three per day.
- Banned role in Support: added on join/ban while a ban is active, removed when it ends/is lifted; reconciled at startup.
- Modmail: DM the bot → "Send to staff" → staff channel; channel↔member link in `modmail_links` only (topic ignored);
  `//` = internal note; `/modmail close|block|unblock`.

## OAuth verification

- Scopes `identify guilds.join` only (no email). Redirect `${PUBLIC_URL}/oauth/callback`; `state` checked;
  links are single-use, 10 min, bound to the clicking user. Tokens encrypted with `OAUTH_TOKEN_KEY` (AES-256-GCM).
- Bots can't DM users without a mutual server; `guilds.join` adds verified users to Support so DMs keep working.

## Data layer rules

- Reads: a DB error throws ("database not responding, nothing was changed"). Never return defaults on error.
  Empty data may return defaults.
- Writes succeed or throw; a pg `false` return is an error. Never show success after a failed write.
- Collections: per-row upsert/delete inside one transaction. Config updates: row-locked or atomic SQL.
- Pool error clears `isConnected`; recover via a lazy health check with backoff. Remote DB hosts: TLS + cert verification.
- Production refuses to start without PostgreSQL (`DATABASE_REQUIRED`) unless `ALLOW_MEMORY_DB=true`.

## Environments

- **Production:** Replit deployment, currently on branch `feature/enforcements`. Must run `NODE_ENV=production`
  (`.replit` sets `development` for the workspace; keep the workspace from acting as production).
  `LOG_LEVEL=info` (debug logs message content).
- **Database:** live DB is the owner's Neon project (PostgreSQL 18), secret `POSTGRES_URL`, the only one the bot reads
  (Replit's `DATABASE_URL` is ignored with a warning). Planned move: Supabase free tier (details in plan.md).
- **Testing (owner, 2026-11-03):** no dev environment or test bot; Discord testing happens on Replit
  (`docs/test-script.md`). Locally only `npm test` and `npm run test:db` (local DB). Test mode (`src/config/testMode.js`)
  refuses the production bot, real server IDs and non-local DBs; crons off unless `TEST_ENABLE_CRON=true`.

## Discord gotchas

- Always set `allowedMentions` (no @everyone/@here/role pings from user-supplied text).
- `permissions.has([...])` requires ALL bits; use `.any()` for "any of".
- Embed limits: field 1024, description 4096, total 6000. Ack interactions within 3 s.
- Discord timeouts max out at 28 days (one reason mutes use a role). Global command changes can take an hour to show.

## Status and roadmap

- **Go-live postponed (owner, 2026-10-28): "don't go live yet".** Feature list, history and go-live plan: plan.md.
- **Go-live checklist (in order):** Supabase DB live → final deployment secrets (`NODE_ENV=production`,
  `LOG_LEVEL=info`, `POSTGRES_URL`, OAuth values, `APPEALS_CATEGORY_ID` (seeded once into `guild_settings`),
  `OWNER_IDS`, `BANNED_ROLE_ID`; remove `LOG_STREAM_TOKEN`) → OAuth redirect in the Developer Portal →
  pull/install/republish → `/setappeal` → live smoke test on an alt account → merge into `main`, switch Replit to `main`.
  The one-time proxy IP log line goes in the first deploy and is removed in the next.
- **Branches:** work happens on `feature/dashboard-members` (contains `feature/enforcements`); nothing built since the
  live deploy is deployed yet. Schema is **v9** (`src/config/database/schemaVersion.js`).
- **Web dashboard** (our server only): server-rendered, plain CSS + one static script, strict CSP, no SPA. Discord
  login (`identify`); Administrator re-checked per request (`OWNER_IDS` without it: view + settings only); CSRF +
  Origin check; audit log; settings in `guild_settings`; same services as the commands. Env: `DASHBOARD_ENABLED`,
  `DASHBOARD_EDIT_ENABLED`, `SESSION_SECRET`; redirect `${PUBLIC_URL}/dashboard/oauth/callback`. Design v5 (10 palette
  themes, AA contrast test, no AI-startup look). Public release, multi-server support and premium only after go-live.
