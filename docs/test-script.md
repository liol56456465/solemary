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

Clean up afterwards: unban/unmute the alts, lift test cooldowns/timeouts, end watchlist entries, and void test cases with reason "test"
(`/case remove`) so they do not count on the alts' records.

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
| 3.5 | `/case remove code:<a warn> reason:"mistake"` | Case voided; Alt A DM'd; ladder steps back (check `/background`) |

## 4. Staff watchlist (`/case watch`)

| # | Do | Expected |
|---|---|---|
| 4.1 | `/case watch add member:Alt B reason:"test" days:1` as **Alt A** | Refused (Administrator only) |
| 4.2 | Admin: `/case watch add member:Alt B reason:"test" days:1` | Ephemeral confirmation with the end time; Alt B is **not** told |
| 4.3 | `/case watch add` on yourself or the bot | Refused with a clear message |
| 4.4 | `/case watch list` | Alt B listed with entry number, reason and end time |
| 4.5 | `/background user:Alt B` | Shows "On watchlist since … — test" |
| 4.6 | Alt B leaves and rejoins; wait over a minute, then warn Alt B | One "watch" line in the mod log for the join and one for the new case (alerts are capped at one per member per minute); no pings |
| 4.7 | Dashboard → Keep apart page | Watchlist card lists Alt B; **End** works for Admin (audit log row) |
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

## 9. Polls (`/poll`, as Admin; Alt A votes)

| # | Do | Expected |
|---|---|---|
| 9.1 | `/poll create question:Pizza? option1:Yes option2:No hours:1` | Native Discord poll posted; private reply shows the closing time (date + relative) and a message link |
| 9.2 | Alt A votes | Vote counts; Alt A's name is visible in the voter list (normal for Discord polls) |
| 9.3 | `/poll end message_link:<link from 9.1>`, then the same again | First: "Poll ended…", final results shown. Second: "That poll has already ended." |
| 9.4 | `/poll create` with an option longer than 55 characters | Refused with the 55-character message; nothing posted |
| 9.5 | `/poll create question:Q option1:a option2:b anonymous:true hours:5` | Embed with 1️⃣ 2️⃣ reactions; private reply says hours/multiple were ignored |
| 9.6 | Alt A runs any `/poll` command | "You need the Administrator role…" refusal |

## 10. Rules (dashboard Rules tab + `/rules`)

| # | Do | Expected |
|---|---|---|
| 10.1 | Dashboard → Rules: add 3 rules (one from the library), set colour, intro, footer, banner; Save design | Preview shows the post |
| 10.2 | `/rules preview` | Private copy matching the dashboard preview |
| 10.3 | `/rules post` (put `@everyone` in one rule text) | Rules posted in the saved channel, **no ping**; dashboard shows "Posted in #… (1 message)" |
| 10.4 | Edit rule 2 on the dashboard, then `/rules update` | The same message changes in place, no new message |
| 10.5 | Delete the posted rules message in Discord, then `/rules update` | Refused: "One of the posted rules messages was deleted…"; nothing changed |

## 11. Leveling (dashboard Leveling page; Alt A)

Reward roles A (level 1) and B (level 2) must sit below Mewvo's role.

| # | Do | Expected |
|---|---|---|
| 11.1 | Add channel boost ×2 on #general and role boost ×1.5 on a test role; try 5.5 and 1.25 | Both rows listed; 5.5 and 1.25 refused |
| 11.2 | Give Alt A the test role; Alt A `/rank` in #general, then elsewhere without the role | First: "XP boost x3 (role … x1.5, channel boost x2)". Second: no XP boost field |
| 11.3 | Reward mode "Keep all": `/levelset Alt A 2` | Reply says 2 reward roles given; Alt A has A and B |
| 11.4 | Reward mode "Only the highest": `/levelset Alt A 2` | A removed, B stays |
| 11.5 | Move B above Mewvo's role; `/levelset Alt A 1`, then `2` | Alt A **keeps A** (never left with no reward role); reply mentions roles that couldn't be changed. Move B back |
| 11.6 | Alt A leaves and rejoins | Level unchanged in `/rank`; earned reward role back within seconds. While gone: not on `/leaderboard`, no rank gaps |
| 11.7 | Level-up channel set, card off; Alt A levels up | Text-only post, only Alt A pinged |
| 11.8 | Turn on "Add an image card"; level up again; then nickname 山田太郎 and level up | PNG card with avatar, name, level, bar; with the CJK nickname the card shows the username, **no boxes** |
| 11.9 | Remove Attach Files from Mewvo in the level-up channel; level up | Text line only, no error |
| 11.10 | Alt A `/rank card:True`; `/leaderboard page:50`; website `/leaderboard` paging | Card within a few seconds; "no members on page 50…" without error; website never shows a "Next" to an empty page |

## 12. Automod test run and raid timeline (dashboard)

| # | Do | Expected |
|---|---|---|
| 12.1 | Automod → Results → Test run: 1 channel, "Last day", Start; start a second run in another tab | "Test run started", then a result; second tab: "A test run is already running…" |
| 12.2 | Pick a channel where Mewvo lacks Read Message History | Error naming the channel and the missing permission |
| 12.3 | Post `THIS IS A VERY LOUD MESSAGE FOR EVERYONE`; run again | Excessive caps counted; example has an "Open" jump link |
| 12.4 | Language rule off; post a caps message with a slur spelled with spaces; run | That example reads "hidden (the match could not be masked safely)"; the slur appears nowhere on the page |
| 12.5 | Post `mail me at test@example.com` and `+４４ ２０ ７９４６ ０９５８`; run | `[e-mail]` and `+## ## …`; no real digits |
| 12.6 | Draft words `hello` → run → "Add this rule"; on a result row "Set to watch only" (then set back) | Custom rule created + Audit log row; Rule modes shows watch only + audit row `ruleModes.<rule>` |
| 12.7 | Check Discord after the runs | No deletions, DMs or mod-log posts from test runs |
| 12.8 | During a join raid (alts joining fast): Moderate → Raid timeline; end the lockdown; open it again | Listed as "Still running"; after the end: start, joins, cases and end minute by minute (UTC), "Ended by" you |
| 12.9 | A moderator without Administrator opens `/dashboard/incidents` | 403 |
| 12.10 | Open a ticket; start a giveaway whose prize contains `<@&role>`, end it | Staff role pinged on the ticket; the giveaway prize does **not** ping the role; winners pinged once, not re-announced next minute |

## 13. Rules quiz at verification (Alt B, not verified)

Setup: verification panel on. Dashboard → Verification → Rules quiz: Q1 "Is spam allowed?" (No / Yes, correct =
answer 1), Q2 with 3 answers; wait 1 minute; save; turn the quiz on.

| # | Do | Expected |
|---|---|---|
| 13.1 | Alt B presses Verify; presses Verify again; clicks a button on the first message | "Rules quiz: question 1 of 2"; then a new question 1; old message: "This quiz expired, click Verify again." |
| 13.2 | Answer Q1 wrong, Q2 right; press Verify at once | "Not quite — read the rules in #… and try again in 1 minute", no hint which was right; then "try again in 1 minute" |
| 13.3 | After 1 minute: Verify, answer both right | Normal verification step ("Verify with Discord" link, or the role) |
| 13.4 | Don't finish the Discord link; press Verify again | Straight to the link, no quiz |
| 13.5 | Edit Q1's text on the dashboard; Alt B presses Verify | Quiz asked again |
| 13.6 | "Suggest questions from my rules"; reload without saving | Up to 3 drafts with "Nothing is saved yet"; gone after reload |
| 13.7 | Remove every question (quiz on); Alt B Verify; then turn the quiz off | Warning "treated as off"; normal verification; off = exactly as before |

## 14. Self-cooldown (`/cooldown`, Alt A)

| # | Do | Expected |
|---|---|---|
| 14.1 | `/cooldown duration:1 hour reason:test` → Cancel | Private "Start a cooldown?" with end time and "can't end it early"; Cancel: "No cooldown was started", alt can chat |
| 14.2 | `/cooldown duration:1 hour`, wait over 5 minutes, click Start | "This expired, run /cooldown again." No timeout |
| 14.3 | `/cooldown duration:1 hour` → Start cooldown | "Cooldown started … ends on its own <time>"; can't send, react or join voice; timeout icon shown |
| 14.4 | Admin checks the log channel, Discord audit log, `/background Alt A` | "Self-cooldown started" embed ("Not a moderation case"); audit reason "Self-cooldown via /cooldown"; no new case |
| 14.5 | Alt A (still timed out) runs `/cooldown duration:1 day` | "You are already in a timeout until <time>", no buttons |
| 14.6 | Admin lifts the timeout; repeat until 3 cooldowns started; run a 4th | "You have started 3 cooldowns in the last 24 hours…" |
| 14.7 | Admin runs `/cooldown` | "You have the Administrator permission… can't put a cooldown on you"; nothing applied |

## 15. New domain (only after Ramūnas switches it; see `docs/domain-switch.md`)

| # | Do | Expected |
|---|---|---|
| 15.1 | Open `https://mewvo.com/health` and the old Replit `/health` | Both answer JSON; the old one is **not** redirected |
| 15.2 | Log in to the dashboard on the new host | Discord login works; you land on the overview |
| 15.3 | With `CANONICAL_REDIRECT=true`: open an old Replit page link (e.g. `/leaderboard?page=2`) | Lands on the same page on `mewvo.com`; `https://www.mewvo.com/` lands on `https://mewvo.com/` |
| 15.4 | Verify with Discord as Alt B on the new host | OAuth completes, role given |

## 16. Channel permissions (dashboard; test channel `#t`)

| # | Do | Expected |
|---|---|---|
| 16.1 | In Discord deny Send Messages for Mewvo's role in `#t`; open Dashboard → Messages | `#t (Mewvo lacks: Send Messages)` in the channel list, hint under the picker |
| 16.2 | Post plain text (no box) where Mewvo lacks only Embed Links; then the same with a box title | Plain text posts; the box post is refused with "I am missing Embed Links…" and a **Fix permissions** link |
| 16.3 | Click Fix permissions → "Give Mewvo these permissions" | Back on Messages: "Mewvo now has … in #…"; a Mewvo member entry in the channel's permissions; "Channel Permissions Fixed" in the mod log; a row in Dashboard → Audit |
| 16.4 | Open the Fix link for a channel Mewvo can't see | No button; "Mewvo cannot see #…" plus the Discord steps |
| 16.5 | Owner → Announce: pick another channel for the main server → Preview → Send | Posts there; empty picker = old default channel |
| 16.6 | `/logging channel` with an announcement channel; `/welcome setup`, `/level setup` | Announcement channels offered and saved; logs arrive there (needs command re-register) |

## 17. Confirm / Cancel (dashboard + `/ticket dashboard`)

| # | Do | Expected |
|---|---|---|
| 17.1 | Cases → an active ban → reason → **Remove case…** | Confirm page: case, member, reason, effect ("The member is unbanned…"); nothing changed yet |
| 17.2 | Cancel; then repeat and press Remove case | Cancel: still active. Confirm: removed, member DM'd |
| 17.3 | Browser Back → press Remove case again | "expired or was already used. Nothing was done" |
| 17.4 | Cases list: tick 2 cases (one already removed) → remove + reason → Apply → confirm | One listed, one "Skipped, already removed"; flash "Removed: …" |
| 17.5 | Channel tools → Purge 3 messages; Applications → delete a test application | Confirm pages ("deleted for good" / number of submissions); Cancel deletes nothing; Confirm deletes |
| 17.6 | Members → tick an alt → Ban → Preview | One page listing who will be banned, no extra pop-up |
| 17.7 | `/ticket dashboard` → Delete system → Cancel; again and wait 60 s; again → Delete ticket system | "Cancelled. Nothing was deleted." / "Confirmation expired" / "Ticket system deleted" (then `/ticket setup` again) |

## 18. First setup (dashboard Overview + Setup)

| # | Do | Expected |
|---|---|---|
| 18.1 | Remove Ban Members from Mewvo's role → Overview | Permissions card on top: "Ban Members missing" + fix line; turn it back on → "Mewvo has every permission it needs." |
| 18.2 | Drag the Muted role above Mewvo's role → reload | "Move Mewvo's role above @Muted"; put it back |
| 18.3 | Deny Send Messages for Mewvo in #mod-log; warn Alt A | Overview: "Mewvo couldn't post to #mod-log: missing Send Messages · 1 time today" + Fix it; allow + warn again → line gone |
| 18.4 | Setup step by step: save a main log channel on its step | Back on the same step, "Log channels saved."; other log channels unchanged |
| 18.5 | Support server: non-admin runs an admin-only command | "…Ask an admin of this server if you need access." (main server: unchanged, with the channel link) |

## 19. No typed IDs or links

| # | Do | Expected |
|---|---|---|
| 19.1 | Keep apart: type "al" in First member | Matching members listed; picking fills the ID |
| 19.2 | JS off: "Find a member by name" → Use (both members) | ID filled, "Picked: …" shown; first pick kept |
| 19.3 | Paste `<@ID>` in a member field | Accepted |
| 19.4 | Tickets → block, Purge "only from", Logging → ignore: search | Works; ticket block and purge also list banned users |
| 19.5 | Messages: post a poll, reload → End poll → confirm | Listed under End a poll; closes in Discord, leaves the list |
| 19.6 | `/jointocreate config` → Change user limit → 150, then 5 | Modal prefilled; 150 refused; 5 saved |
| 19.7 | `/configwizard` → Skip, then Stop setup | "Skipped" / "Setup cancelled"; buttons grey out |

## 20. Plain words and automod

| # | Do | Expected |
|---|---|---|
| 20.1 | `/enforcements user:Alt A` | "Warning stage: 0 of 3 (no warning ban yet)" |
| 20.2 | Warn Alt A 3 times | Last reply: "Now at warning stage 1 of 3 (7-day ban)." |
| 20.3 | Appeal panel → **My record** | Embed "My record in Mewvo" with "Warning stage …" |
| 20.4 | Dashboard → Automod | "Report only (don't delete)", "Warn privately first (2 min to fix)", "Friendly notice…", "Extra-watch period after a ban" |
| 20.5 | Sidebar "Keep apart"; start an order | DM "Keep apart: an order in Mewvo" |
| 20.6 | Dashboard → Words explained | All 13 new terms listed |
| 20.7 | Alt A sends `f.u.c.k`, `ｎｉｇｇｅｒ`, `n i g g e r` (blocked list on) | Each caught; `class`, `cocktail`, `Dickens`, `Maine coon` are not |
| 20.8 | Dashboard → change extra blocked words, then send one | Applies without a restart |
| 20.9 | Website on a phone: sign-up / redeem fields, menu, pricing table sideways | No zoom on tap; table scrolls with the feature column fixed |


## 21. Plain command names (after the commands are re-registered)

| # | Do | Expected |
|---|---|---|
| 21.1 | Type `/case` and look at the list | `remove` and `keepapart add/list/end` are there; `void` and `nocontact` are gone |
| 21.2 | `/case keepapart add user_a:Alt A user_b:Alt B days:1 reason:test`, then `/case keepapart list`, then `end` | Order started (both DM'd), listed, ended; the hints in the replies say `/case keepapart …` |
| 21.3 | `/automod extrawatch user:Alt A` and `/automod friendlynotice enabled:true` | Extra-watch status shown; friendly notice turned on. `probation` and `secondchance` are gone |
| 21.4 | Owner: `/backup snapshots`, then `/backup changes` | The list's hint says `/backup changes`; changes since the latest snapshot shown. `diff` is gone |
| 21.5 | `/test action:ban user:Alt A no_appeal:true` | DM preview to you says the ban cannot be appealed; no `unappealable` option |


## 22. `/database` (owner only, in the owner's server `1564332751170044186`)

Needs the bot in that server (invite it there with the `applications.commands` scope) and a restart, so the command is registered there.

| # | Do | Expected |
|---|---|---|
| 22.1 | In the main server and in Support, type `/database` | Not in the command list (startup log: `Registering 1 owner-tools-guild commands`, main-server count unchanged) |
| 22.2 | Owner, owner's server: `/database stats` | Ephemeral: rows per table, schema version 11, database size, oldest/newest rows. Footer "read-only · secrets are hidden" |
| 22.3 | `/database user user:<Alt A's ID>` | Every section with a count (cases, ladder, appeals, watchlist, keep-apart, levels, modmail, verification, tickets, birthdays, website account, premium, …); most recent rows only. OAuth link shows `status: stored`, never a token |
| 22.4 | `/database user user:<@Alt A>` | Same result as 22.3 |
| 22.5 | `/database case code:<a real case code>` | The case, its edits, evidence (no image URL), staff notes and appeals; `reason_key` / `import_key` show `(hidden)` |
| 22.6 | `/database server server_id:1527697154926182492` | Config fields, settings that are set (secret-named ones `(hidden)`), module states, non-empty table counts, open appeals |
| 22.7 | `/database search text:%%` and `text:__` | Only rows that really contain `%%` / `__` (the wildcards are escaped), not everything |
| 22.8 | A result with more than one page: Next, Previous | Pages change; Previous is disabled on page 1, Next on the last |
| 22.9 | Alt A (or any non-owner) in the owner's server: `/database stats` | "This command is only for the bot owner." (ephemeral), nothing queried |
| 22.10 | Wait 15 minutes, press Next | "This result expired, run /database again." |
| 22.11 | Bot log (Replit console): find the lines for 22.2–22.7 | `Owner /database <subcommand> by <your ID>` with the query; no result rows in the log |

When done: run the clean-up from "Before testing in Discord".
