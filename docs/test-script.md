# Meowist — full-bot test script (test bot, test servers)

Run with the **test bot** only (`npm run start:test`). The live deployment keeps running:
the test bot has its own token and sees only `TEST_GUILD_IDS`.
Tick each line; if a result differs, note the step number and paste the bot's log lines.

## 0. One-time setup: the test bot

1. <https://discord.com/developers/applications> → **New Application** → name it `Meowist Test`.
2. **Bot** tab → **Reset Token** → copy it into `.env.test` as `DISCORD_TOKEN` (never into chat or git).
   Turn on **Server Members Intent** and **Message Content Intent** (Presence is not needed).
3. **General Information** → copy **Application ID** → `.env.test` `CLIENT_ID`.
4. **OAuth2** → copy **Client Secret** → `.env.test` `DISCORD_CLIENT_SECRET`.
   **Redirects** → add both:
   `http://localhost:3100/oauth/callback` (verification) and
   `http://localhost:3100/dashboard/oauth/callback` (dashboard login).
5. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`, permission **Administrator**
   (test servers only) → open the URL → add the bot to your **test main** and **test support** servers.
6. `.env.test`: add the dashboard block from `.env.test.example`; `SESSION_SECRET` = output of `openssl rand -hex 32`.
   Keep `TEST_GUILD_IDS`, `MAIN_GUILD_ID`, `SUPPORT_GUILD_ID` = the test servers.
7. Check: `docker start meowist-test-db` then `npm run test:config` → no errors, `CLIENT_ID` = the test app.
   With the old production values it must refuse: "CLIENT_ID is the production Meowist bot".
8. Start: `npm run start:test` → log shows "Discord login successful", presence "🛠 Maintenance".

Accounts: **Admin** = you (Administrator in the test main server). **Alt A**, **Alt B** = two
non-admin accounts in the test main server (Alt A also joins the test support server when asked).

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

## 4. Appeals (test support server)

| # | Do | Expected |
|---|---|---|
| 4.1 | Admin: `/setappeal` in the test main server | Appeal panels posted (main + support `#appeals`) with **Appeal**, **My appeals**, **My standing** |
| 4.2 | Ban Alt A (permanent, appealable); Alt A joins the support server | Alt A gets the **Banned** role there |
| 4.3 | Alt A: **My standing** | Own warnings, ladder level, next step, appeals (ephemeral) |
| 4.4 | Alt A: **Appeal** → fill the 3 questions | Private channel in the support appeals category with Alt A added |
| 4.5 | Alt A: **My appeals** | Shows the appeal as pending |
| 4.6 | Alt A: Appeal again for the same case | Refused: one pending appeal per case |
| 4.7 | Admin: `/appeals code:… decision:deny note:"no"` | Alt A DM'd; **My appeals** shows denied; a new appeal within 7 days is refused |
| 4.8 | Ban Alt B, appeal, `/appeals … decision:accept` | Alt B unbanned, DM with a fresh invite, Banned role removed in support |
| 4.9 | Mute Alt B, Alt B appeals the mute | Appeal channel opens in the **main** server ticket category |

## 5. Modmail and tickets

| # | Do | Expected |
|---|---|---|
| 5.1 | Alt A DMs the test bot | Bot asks "Send to staff?" with a **Send to staff** button |
| 5.2 | Click it | Private staff channel in the ticket category; the message appears there |
| 5.3 | Staff reply in the channel; then `// internal` | Alt A gets the reply by DM; the `//` note is **not** sent |
| 5.4 | `/modmail close reason:done` | Channel closed; Alt A told |
| 5.5 | `/modmail block user:Alt A`, Alt A DMs again | Not forwarded; `/modmail unblock user:Alt A` restores it |
| 5.6 | `/ticket setup panel_channel:#tickets category:<cat> staff_role:<role>` | Panel posted |
| 5.7 | Alt B opens a ticket from the panel; staff closes it | Private channel created, then moved/closed; DM on close if enabled |

## 6. Staff

| # | Do | Expected |
|---|---|---|
| 6.1 | `/staff stats period:30d` | Per-moderator actions, appeals, voided cases |
| 6.2 | `/staff coverage` | Text heat map of moderation times |

## 7. Dashboard with the bot connected — <http://localhost:3100/dashboard>

| # | Do | Expected |
|---|---|---|
| 7.1 | Open as **Admin** → Log in with Discord | Back on Overview; bot "online", database "connected", your test server's name and icon |
| 7.2 | Log in as **Alt A** (private window) | 403 "Not allowed" page; no dashboard content |
| 7.3 | Visit every sidebar page (Overview, Modules, Moderation, Community and Server groups) | Each loads, no "Something went wrong"; active item purple with a bar on the left |
| 7.4 | Valid save: Tickets & modmail → change "Open tickets per member" → **Save changes** | Section says "Unsaved changes" while editing; then green toast; value kept after reload; Audit log row; one mod-log line in Discord |
| 7.5 | Same field → change it → **Reset** | Old value back, "Unsaved changes" gone, bottom bar gone; nothing saved |
| 7.6 | Invalid save: Giveaways → start one in a **voice** channel | "Not saved: … must be a text channel" inside that form; what you typed is still there; nothing posted |
| 7.7 | Giveaways (or Community → a tag) → **Delete** → dialog | Dialog names the thing; Cancel or Esc closes it and nothing is deleted |
| 7.8 | Members → Alt A → Warn → confirm page → Confirm | Same DM, case and ladder as the panel (step 1.2); Overview "Active bans/mutes" match the cases |
| 7.9 | Cases → a case → edit reason; Appeals → accept/deny a pending one | Same results as steps 3.2 / 4.7; action badges with icons, only Ban is red |
| 7.10 | Modules page | Cards with a state show On / Off and "Needs setup · N to do" in words (Giveaways, Counters… show none); no switches on the cards |
| 7.11 | Theme switch (top bar); DevTools widths 1440 / 820 / 390 | Cycles system → dark → light, kept after reload; 820 = icon rail, menu button opens the full sidebar; 390 = drawer, Esc closes it |
| 7.12 | Stop the bot, set `DASHBOARD_EDIT_ENABLED=false`, start, open a settings page | "Read-only" notice; no Save buttons |
| 7.13 | Log out (user menu) | Logged-out page; `/dashboard/overview` redirects to Discord login |

When done: `Ctrl+C` the test bot. Nothing in the live servers should have changed.
