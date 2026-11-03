# Mewvo — full-bot test script

There is no local dev environment and no separate test bot (owner decision, 2026-11-03).

- **Locally:** only the automated tests in section 0. They never start the bot or touch Discord.
- **In Discord:** the bot runs on Replit and Ramūnas tests in the real servers with alt accounts.
  Getting a branch onto Replit (branch switch, pull, republish, secrets) is a production change:
  only Ramūnas does it, and only after he has OKed it.

Tick each line. If a result differs, note the step number and paste the bot's log lines from the Replit console.

## 0. Local checks (before anything goes to Replit)

Run these on Node 22 (`nvm use` reads `.nvmrc`; on the shell default of Node 20 the test globs find nothing).

1. `npm test`: all unit tests pass.
2. Start your local Postgres (for example `docker start mewvo-test-db`), then `npm run test:db`: all DB tests pass.
   These tests skip themselves unless `POSTGRES_URL` points at localhost, so they can never hit the live database.
   The env file they load lives outside the repo in `~/.config/mewvo/` and holds local values only.
3. If you changed the schema: `npm run migrate:check` against the local DB.

Do not use `npm run start:test` to log in with the real bot: test mode refuses the production bot by design
(`src/config/testMode.js`).

## Before testing in Discord

The tests below create real cases, DMs and mod-log lines in the live servers. Use only alt accounts as targets,
and say in the mod-log channel or staff chat that a test run is going on.

Accounts: **Admin** = you (Administrator in the main server). **Alt A**, **Alt B** = two non-admin accounts in the
main server (Alt A also joins the support server when asked).

Clean up afterwards: unban/unmute the alts, end watchlist entries, and void test cases with reason "test"
(`/case void`) so they do not count on the alts' records.

## 1. Enforcement panel (`/enforcements user:<Alt A>`, as Admin)

| # | Do | Expected |
|---|---|---|
| 1.1 | `/enforcements` as **Alt A** | Refused: "You need the Administrator role… Request a mod/admin role here: #…" |
| 1.2 | Admin: Warn → prebuilt reason → confirm | Alt A DM "Warning 1 of 3" with case code; mod-log line; case in `/background user:Alt A` |
| 1.3 | Warn again | DM "Warning 2 of 3" |
| 1.4 | Warn a 3rd time | Automatic **7-day ban** (ladder level 1): Alt A DM with end time `<t:…>` + appeal link, then banned |
| 1.5 | Unban Alt A (panel → Unban) | Unbanned; the ban case shows as lifted in `/background` |
| 1.6 | Alt A rejoins (send a normal invite); Warn once | Next warn after level 1 → **30-day ban** (level 2). Unban again afterwards |
| 1.7 | Mute Alt B, 10 min | Alt B gets the Muted role, cannot write anywhere (also in a channel created now); DM with end time |
| 1.8 | Alt B leaves and rejoins | Muted role re-applied |
| 1.9 | Unmute Alt B | Role removed, Alt B can write; DM |
| 1.10 | Kick Alt B | DM **before** the kick with a one-time invite (7 days); Alt B removed |
| 1.11 | Remove warn on Alt A | Counted warns go down by 1 (check `/background`) |
| 1.12 | Try to act on yourself / the bot / a higher role | Refused with a clear message |
| 1.13 | Open a panel, wait > panel lifetime, click | "This panel expired, run /enforcements again" |
| 1.14 | Right-click Alt A's message → **Apps → Warn for this message** | Warn flow with the message quoted; case created |

## 2. `/test` (nothing is executed)

| # | Do | Expected |
|---|---|---|
| 2.1 | `/test action:ban user:Alt A reason:… duration:7d` | **You** get the exact DM preview, footer "Simulation — no action taken"; Alt A gets nothing, no case |

## 3. Cases

| # | Do | Expected |
|---|---|---|
| 3.1 | `/case search member:Alt A` | Alt A's cases with paging |
| 3.2 | `/case edit code:<warn code> reason:"edited"` | Saved; `/case history code:…` shows old → new |
| 3.3 | `/case evidence add code:… link:https://example.com note:test` then `… image:<png>` | Both listed by `/case evidence list`; image visible |
| 3.4 | `/case evidence remove code:… id:<id>` | Removed from the list |
| 3.5 | `/case void code:<a warn> reason:"mistake"` | Case voided; Alt A DM'd; ladder steps back (check `/background`) |

## 4. Staff watchlist (`/case watch`)

| # | Do | Expected |
|---|---|---|
| 4.1 | `/case watch add member:Alt B reason:"test" days:1` as **Alt A** | Refused (Administrator only) |
| 4.2 | Admin: `/case watch add member:Alt B reason:"test" days:1` | Ephemeral confirmation with the end time; Alt B is **not** told |
| 4.3 | `/case watch add` on yourself or the bot | Refused with a clear message |
| 4.4 | `/case watch list` | Alt B listed with entry number, reason and end time |
| 4.5 | `/background user:Alt B` | Shows "On watchlist since … — test" |
| 4.6 | Alt B leaves and rejoins; wait over a minute, then warn Alt B | One "watch" line in the mod log for the join and one for the new case (alerts are capped at one per member per minute); no pings |
| 4.7 | Dashboard → No-contact page | Watchlist card lists Alt B; **End** works for Admin (audit log row) |
| 4.8 | `/case watch end id:<n>` (or after 4.7) | "Watchlist entry #n ended"; Alt B rejoining no longer posts a watch line |

## 5. Appeals (support server)

| # | Do | Expected |
|---|---|---|
| 5.1 | Admin: `/setappeal` in the main server | Appeal panels posted (main + support `#appeals`) with **Appeal**, **My appeals**, **My standing**; old panels replaced |
| 5.2 | Ban Alt A (permanent, appealable); Alt A joins the support server | Alt A gets the **Banned** role there |
| 5.3 | Alt A: **My standing** | Own warnings, ladder level, next step, appeals (ephemeral) |
| 5.4 | Alt A: **Appeal** → fill the 3 questions | Private channel in the support appeals category with Alt A added |
| 5.5 | Alt A: **My appeals** | Shows the appeal as pending |
| 5.6 | Alt A: Appeal again for the same case | Refused: one pending appeal per case |
| 5.7 | Admin: `/appeals code:… decision:deny note:"no"` | Alt A DM'd; **My appeals** shows denied; a new appeal within 7 days is refused |
| 5.8 | Ban Alt B, appeal, `/appeals … decision:accept` | Alt B unbanned, DM with a fresh invite, Banned role removed in support |
| 5.9 | Mute Alt B, Alt B appeals the mute | Appeal channel opens in the **main** server, staff-only |

## 6. Modmail and tickets

| # | Do | Expected |
|---|---|---|
| 6.1 | Alt A DMs the bot | Bot asks "Send to staff?" with a **Send to staff** button |
| 6.2 | Click it | Private staff channel in the modmail category; the message appears there |
| 6.3 | Staff reply in the channel; then `// internal` | Alt A gets the reply by DM; the `//` note is **not** sent |
| 6.4 | `/modmail close reason:done` | Channel closed; Alt A told |
| 6.5 | `/modmail block user:Alt A`, Alt A DMs again | Not forwarded; `/modmail unblock user:Alt A` restores it |
| 6.6 | `/ticket setup panel_channel:#tickets category:<cat> staff_role:<role>` | Panel posted |
| 6.7 | Alt B opens a ticket from the panel; staff closes it | Private channel created, then moved/closed; DM on close if enabled |

## 7. Staff

| # | Do | Expected |
|---|---|---|
| 7.1 | `/staff stats period:30d` | Per-moderator actions, appeals, voided cases |
| 7.2 | `/staff coverage` | Text heat map of moderation times |

## 8. Dashboard (`/dashboard` on the Replit URL)

| # | Do | Expected |
|---|---|---|
| 8.1 | Open as **Admin** → Log in with Discord | Back on Overview; bot "online", database "connected", the server's name and icon |
| 8.2 | Log in as **Alt A** (private window) | 403 "Not allowed" page; no dashboard content |
| 8.3 | Visit every sidebar page (Moderate, Community, Server setup and Bot groups) | Each loads, no "Something went wrong"; active item highlighted with a bar on the left |
| 8.4 | Valid save: Tickets & modmail → change "Open tickets per member" → **Save changes** | Section says "Unsaved changes" while editing; then green toast; value kept after reload; Audit log row; one mod-log line in Discord |
| 8.5 | Same field → change it → **Reset** | Old value back, "Unsaved changes" gone, bottom bar gone; nothing saved |
| 8.6 | Invalid save: Giveaways → start one in a **voice** channel | "Not saved: … must be a text channel" inside that form; what you typed is still there; nothing posted |
| 8.7 | Giveaways (or Community → a tag) → **Delete** → dialog | Dialog names the thing; Cancel or Esc closes it and nothing is deleted |
| 8.8 | Members → Alt A → Warn → confirm page → Confirm | Same DM, case and ladder as the panel (step 1.2); Overview "Active bans/mutes" match the cases |
| 8.9 | Cases → a case → edit reason; Appeals → accept/deny a pending one | Same results as steps 3.2 / 5.7; action badges with icons, only Ban is red |
| 8.10 | Modules page | Cards with a state show On / Off and "Needs setup · N to do" in words (Giveaways, Counters… show none); no switches on the cards |
| 8.11 | Theme switch (top bar); browser widths 1440 / 820 / 390 | Cycles system → dark → light, kept after reload; 820 = icon rail, menu button opens the full sidebar; 390 = drawer, Esc closes it |
| 8.12 | Log out (user menu) | Logged-out page; `/dashboard/overview` redirects to Discord login |

Optional, only if Ramūnas decides to change a deployment secret: with `DASHBOARD_EDIT_ENABLED=false` and a
republish, settings pages show a "Read-only" notice and no Save buttons. Set it back afterwards.

When done: run the clean-up from "Before testing in Discord".
