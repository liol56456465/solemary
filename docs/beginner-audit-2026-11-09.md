# Beginner / public-use audit (2026-11-09) — plan, WAITING FOR OWNER OK

Goal (owner): "good for public use and beginner friendly". Three read-only audits walked the first hour of a
beginner **server owner**, a new **moderator** and a regular **member** in a server that is NOT one of
Mewvo's home servers. Claude re-checked the items marked ✓ in code. Earlier audit (2026-11-05) items are
fixed and not repeated. file:line as of 4e89a2d1 (feature/dashboard-members after the v14 wave).

## Wave 1 — real bugs and unsafe behaviour (fix first)

| # | Problem | Evidence | Fix | Effort |
|---|---|---|---|---|
| 1.1 ✓ | Dashboard "Post the appeal panels" in ANY server runs the home code: reposts Mewvo's own Support #appeals panel and writes supportChannelId | modules/enforcement.js:203 → appealPanelService.js:207-222 (`/setappeal` does it right: setappeal.js:41-52) | `isHomeScope(ctx) ? postAppealPanels : postServerAppealPanel` + non-home wording | S |
| 1.2 | Undoing a mistaken 3rd warn: Unban leaves the member at warning stage 1 → their next warn = 30-day ban; "Remove warn" is gone from the panel | enforcementService.js:587, 667-684; flowBuilder.js:69; correct undo is `/case remove` (caseEditService.js:177-230) | "Mistake? Remove the warn" on a ladder ban + Unban of a ladder ban offers it | M |
| 1.3 | Ban/kick DM is sent before checking Mewvo can ban → member told "you are banned" when nothing happened; raw English "Discord refused the ban: Missing Permissions" | enforcementService.js:400-408 | check Ban/Kick Members + hierarchy before the DM; map 50013 to "give Mewvo X / move its role up" | S |
| 1.4 | Safety limit (mass-action guard) also blocks Unban/Unmute; says "owner was alerted" when nobody was | massActionGuard.js:33, 97-101, 170 | always allow undo actions; correct text; name `/staff restore`; warn at limit−1 | S |
| 1.5 ✓ | Verify button in every server asks Discord for "join servers for you" (`guilds.join`) and says it's "to add you to the Mewvo support server" | oauthVerification.js:36; verification.json:42; privacyNotice.js:33 | other servers: `identify` only (no guilds.join) + honest one-line purpose; home servers unchanged | M |
| 1.6 | Verify result pages (cancelled / expired / try again) are English-only | oauthVerification.js:208, 240-258 | site i18n (state language / cookie) | S |
| 1.7 | Automod warns count on the same 3-warn ladder → 3 automod hits in different rules = automatic 7-day ban in a brand-new server | enforcementService.js:332-371; ladder fixed (settingsRegistry.js:21-22) | OWNER DECISION D4 | M |

## Wave 2 — the first 10 minutes for a new server owner

| # | Problem | Evidence | Fix | Effort |
|---|---|---|---|---|
| 2.1 ✓ | Server language never auto-detected: German server gets English welcome, DMs, level-ups | `preferredLocale` unused; settingsRegistry.js:395-396 | fall back to `guild.preferredLocale` (seed `botLanguage` on join) | S |
| 2.2 ✓ | Turning automod on = enforce at once (scam link → permanent ban); site tells them to start with "Report only" but nothing does | automodSettings.js:28,70; modules/automod.js:586 | first "On" in a non-home server = Report only (monitor) + "switch to On" nudge; refuse/warn when no review channel | S |
| 2.3 ✓ | Appeals default to Mewvo's Support server for every server | settingsRegistry.js:317-320; dmTemplates.js:28-36 | OWNER DECISION D2 + an early wizard step "where do members appeal" | S |
| 2.4 | `/setappeal` (recommended on /admins and /added) fails until a ticket/appeals category exists | appealService.js:170-173 | create an "Appeals" category on first run | S/M |
| 2.5 | Checklist shows 13 equal steps ("0 of 13"), optional features look required | overview.js:137-153 | "Essentials" (permissions + role position, language, mod log, log channel, automod, appeals) vs "Optional" | M |
| 2.6 | No warning that Mewvo's role is too low to moderate most members | botPermissions.js:1-25 | role-position row "drag Mewvo above these roles" + first wizard step | S |
| 2.7 | /help says run /configwizard first and "support us by boosting"; everything else says /setup | bot/en/core.json help.menu.* | one first step everywhere: /setup → dashboard | S |
| 2.8 | Website still says Mewvo isn't public ("Why can't I add it yet?", "runs only on its own server", "Paid plans start when…") | faq.js:18-19; plans.json:94; pricing.json:10-11 | public variants of these texts | S |
| 2.9 | Join welcome: posted for everyone with a Dashboard button members can't use; nothing at all if no channel is writable | joinWelcome.js:92, 135-147 | "Admins: run /setup" line; DM the server owner as fallback | S |
| 2.10 | Leveling + public level-up posts and cat announcements ON by default | leveling.js:283,292 | non-home default: level-up posts off (or mention it in the welcome) — OWNER DECISION D5 | S |
| 2.11 | Install button asks for 22 permissions with no explanation | shell.js:37-41 | one line under the button "no Administrator — why each permission →" | S |
| 2.12 | /added first-steps page never seen (INSTALL_REDIRECT_ENABLED off) | .env.example:164 | owner: add `<PUBLIC_URL>/added` to Portal redirects, then turn on (config, no code) | owner |
| 2.13 | Home-server wording in the dashboard ("one main server and an optional support server", "Administrator in the main server", env var names shown) | dashboard/en/help.json:17; inbox.json:69-70; errors.json:30 | rewrite for any server | S |

## Wave 3 — safety rails for new moderators

| # | Problem | Fix | Effort |
|---|---|---|---|
| 3.1 | Moderators must have full Administrator to warn anyone | OWNER DECISION D1 | M |
| 3.2 | No "next warn = 7-day ban" reminder after warn 2 (panel or member DM) | next-step line from `previewWarn` on the result card + ban length in `dm.warn.limit` | S |
| 3.3 | No undo on the result card | "Undo (mistake)" → `voidCase` (lifts, steps the ladder back, DMs the member) | M |
| 3.4 | Permanent + unappealable ban in 3 clicks (blank duration = permanent; severe reasons pre-tick "cannot appeal"); every Confirm is the same red | explicit "Permanent" choice + second confirm for permanent/unappealable; danger colour only for ban/kick | S |
| 3.5 | Role-hierarchy refusal only after the whole form (typed reason lost) | early check like moderateuser.js:30-38 | S |
| 3.6 | A warn needs Ban, Kick, Manage Roles, Manage Channels and Create Invite | check permissions per action | S |
| 3.7 | Panel wording: two different "of 3" side by side; "No similar cases yet" noise; scary generic error | plain wording; say whether anything happened | S |
| 3.8 | /purge: no preview, silently skips >14-day messages; /lock: no duration | preview count + "older than 14 days can't be bulk-deleted"; optional auto-unlock | S/M |
| 3.9 | Modmail: everything typed is sent to the member unless `//` — one hint only | pinned reminder + relay ✓ reaction | S |
| 3.10 | English-only moderator texts (userErrors, hierarchy, result notes, "main server" wording) | translation keys | M |

## Wave 4 — member side

| # | Problem | Fix | Effort |
|---|---|---|---|
| 4.1 | Punishment DMs: "Appeal here" is the first line (before the title); up to 11 lines; case code unexplained | title first; shorter; "(you need this to appeal)" | S |
| 4.2 | Warn DM threatening and unexplained ("At 3 warnings you will be banned"; no length; warns never expire; no next step) | plain "what happens next" with the real consequence | S |
| 4.3 | English-only member flows: appeal modal + My record/My appeals, modmail prompts, automod "Contest this", keep-apart DMs | translate | M |
| 4.4 | Admin refusal says "Administrator role" (it's a permission) | "Only server admins can use this." | S |
| 4.5 | Ticket DMs don't name the server; up to 3 separate DMs | server name + one combined DM | S |
| 4.6 | DM language ignores the member; `/language` is a dead end when the server has no language roles | personal language setting without a role (KV, no schema) | M |
| 4.7 | "Already in this giveaway" shown as a red error; no way to leave; winners get no DM | info reply, Leave button, winner DM | S |
| 4.8 | /help category names are English folder names; mentions modmail when the server has none | translated names; only mention what's on | S |
| 4.9 | Jargon: "Level" for warnings (vs XP level), /wipedata wording | "warning stage"; plain /wipedata text | S |
| 4.10 | Privacy/Terms English-only | translate at least "In short" | M |
| 4.11 | Website /commands shows all 175 entries by default | default filter "everyone" | S |

## Owner decisions (D = recommended default)
- **D1 Moderators without Administrator.** Today everything that moderates is Administrator-only (CLAUDE.md
  access model, your rule). In public servers that forces owners to hand out full Administrator just to let
  someone warn. (D) Other servers: a "Moderator role" (already on the dashboard, staffRole) may open the
  enforcement panel for Warn / Mute / Kick / Unmute / Remove warn; Ban, settings and safety stay
  Administrator. Home servers unchanged.
- **D2 Where members appeal by default in other servers.** (D) their own server (`own`) with the web appeal
  page; "Mewvo support" only if they pick it.
- **D3 Verification in other servers.** (D) `identify` only, no `guilds.join` (no "join servers for you"
  screen); the member re-add backup stays a home-server feature.
- **D4 Automod and the warn ladder.** (D) automod warns are shown and counted in the record but do NOT move
  the 3-warn ladder in other servers (setting to include them); plus a per-server "warn ladder on/off".
- **D5 Level-up posts in new servers.** (D) off until an admin turns them on (or picks a channel).

## Build plan (after OK)
Wave 1 (5 parallel agents, worktrees) → Wave 2 → Wave 3 → Wave 4; each: tests on Node 22, discord-reviewer +
pr-review-toolkit silent-failure pass, one commit per agent, merge, full tests, owner test script.
No schema change expected (D4 / 4.6 settings go in guild_settings / KV).
