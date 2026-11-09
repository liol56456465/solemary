# Features for v14 — voice XP, invite tracking, ticket ratings, command explorer

Plan (2026-11-09), WAITING FOR OWNER OK, no code yet. Written from 4 read-only Plan agents; the key
claims were re-checked by Claude (marked ✓). File:line references are as of 8e6c65ef.
One shared schema bump **v13 → v14**, additive only (run /schema-change once, for all three tables).

---

## 1. Voice XP

Members earn XP for time in voice, through the existing leveling (`addXp`, xpSystem.js:18: level roles,
role rules, announcements all reused). The `GuildVoiceStates` intent is already requested ✓ (intents.js:33).

- **Bug to fix first ✓:** `addXp` sets `lastMessage` (xpSystem.js:38); the message cooldown reads it
  (messageCreate.js:287-295) → voice XP would block chat XP. Fix: `addXp(..., { source: 'voice' })`.
- **Tracking:** a 60 s tick over `guild.voiceStates.cache` (cron with the `exclusive()` guard, app.js:352-380).
  A minute counts only if the member was eligible on this AND the previous tick. A restart loses at most
  ~1–2 min and can never double-count. No stored sessions. Ticks are skipped while the gateway is reconnecting.
- **Who counts:** not a bot, not deafened (self or server), not server-muted, not in the AFK channel, not
  in an excluded or ignored channel, not an ignored role, not blacklisted, and **at least 2 such humans in
  the channel** (stops solo AFK farming). Self-muted listeners count (optional switch).
- **Rate:** random 3–7 XP per minute × the existing channel/role boosts (levelBoosts.js:40); daily cap
  120 counted minutes per member per server.
- **Shown in:** /rank and /profile ("Voice time"), `/leaderboard type:voice`, a dashboard Leveling →
  "Voice XP" section (on/off, rate, cap, min people, excluded channels).
- **Data:** new table `voice_activity` (guild, user, voice_seconds, voice_xp, day, day_minutes; PK
  guild+user; cascade like user_levels). Settings in the existing leveling config JSON (no column).
  Only minutes per day are stored: never who you talked with, no audio.
- **Privacy:** data export, /wipedata ("Levels, XP and voice time"), server data deletion, privacy page row.
- **Performance:** servers with fewer than 2 people in voice are skipped before any DB read; no member
  fetches; ~2–3 queries per voice user per minute [I: not measured at scale].

Decisions (D = default): 1 off for existing servers (D) · 2 random 3–7/min (D) · 3 cap 120 min/day (D,
configurable 0–1440) · 4 self-muted counts (D) · 5 server-muted doesn't (D) · 6 no account-age gate (D) ·
7 voice level-ups announced like chat ones (D) · 8 `/level reset` also clears voice time (D).

---

## 2. Invite tracking

"Joined via X's invite", counts per inviter, leaderboard, milestone roles, `{inviter}` in welcome messages.

- **Intent ✓:** `GuildInvites` is NOT requested today (intents.js:28-37) → add it (not privileged).
- **Existing table ✓:** `invite_tracking` exists (schema.js:141-151), but nothing writes to it; it is
  already in the allowlist, the data export and server deletion, and the privacy page already mentions invites.
- **How:** each server keeps an in-memory cache of invite uses (from `guild.invites.fetch()` + vanity,
  which needs Manage Server), updated on inviteCreate/Delete. On join, Mewvo re-fetches and sees which code
  went up. Joins are serialized per server and batched in a ~1 s window, so a raid of 50 joins costs a few
  API calls. Sources: invite / vanity / widget / discovery / bot (OAuth re-add) / ambiguous / unknown / not
  ready / no permission. Joins while the bot was offline can't be attributed.
- **Counts:** Total = invites − left − fake + bonus. Fake = account < 7 days old OR left within 24 h,
  worked out at read time, so changing the rule recounts history. Rejoins count once per inviter.
- **Startup:** only servers with the feature ON are warmed up (paced 250 ms, max 3 at once).
- **Leave reconcile** (`invites/inviteReconcile.js`): a member who left while the bot was offline or the DB
  was down kept an open row (never pruned, never "left"). Daily 05:10 UTC + once ~10 min after ready (after
  the warm-up), servers with the feature ON, 500 ms apart: open rows older than 720 h are closed
  (left_at = reconcile time) when the member is not in a complete member list (fetch gate; a skipped fetch,
  error or partial cache closes nothing). The 720 h age (= max fakeLeaveHours) means a reconciled row is
  never a "quick leave" fake, so no marker column; trade-off: younger rows wait until they are 30 days old.
- **Commands (1 new top-level → 62 + 3):** everyone: `/invites view [user]` (counts only),
  `/invites leaderboard`. Administrator: `/invites who`, `/invites list`, `/invites bonus add|remove`,
  `/invites reset` (confirm button), `/invites setup`.
- **Join/leave logs:** "Invited by @x (`code`)" and "account N days old (fake?)"; the leave log gets "Joined via".
- **Milestone roles:** up to 10 `{count → role}`, role safety check (roleSafety.js:40); kept when the count drops.
- **Dashboard:** new Invites page: settings, leaderboard, recent joins, codes, and a warning when Mewvo
  lacks Manage Server.
- **Data:** reuse `invite_tracking` (+ `deleted_at` column); new `invite_joins` (one row per join:
  inviter, code, source, account age, joined/left); new `invite_inviters` (bonus, reset_at). Reset never
  deletes rows; it moves a `reset_at` date.
- **Privacy:** export (who invited you, plus your own counts; never the invitees' ids), /wipedata,
  server deletion, retention (365 days after leaving), privacy page text.

Decisions: 1 off by default per server (D) · 2 fake = <7 days or left <24 h, adjustable (D) · 3 rejoins
count once (D) · 4 /wipedata deletes your join rows and blanks you as inviter in others' rows (D) ·
5 milestone roles kept when the count drops (D) · 6 anyone can `/invites view` another member, counts
only (D) · 7 join rows kept 365 days after leaving (D).
Unverified: [I1] OAuth re-adds need a marker in oauthVerification.js · [I3] the invites rate limit is per
server · [I5] inviteDelete can arrive before the join for a used-up invite (handled either way).

**Built (2026-11-09, all D accepted):** code in `src/services/invites/` (cache, tracker, stats, store, roles,
page, expectedAdds), `/invites`, Dashboard → Invites, `inviteTracking` setting. [I1] done (marker set right
before the guilds.join PUT). [I5] handled: a deleted code stays in the cache 60 s; a vanished code counts as
used up only within 15 s of its deletion. The support server never tracks (its joins are appeals/re-adds).
guildDelete does not drop the cache (tests/multiServerB2 forbids service imports there); the cache is bounded
and guildCreate re-warms. Tests: tests/inviteTracking.test.js, tests/db/inviteTracking.test.js.

---

## 3. Ticket ratings (upgrade; a basic version already exists)

**Already there ✓:** on close, the opener gets a DM with 1–5 stars + Comment + Decline (ticket.js:388,
dmRenderers.js:55-67), saved inside the ticket JSON and averaged by a full scan (tickets.js:127-166).
**Gaps:** no on/off switch and no time limit; not linked to the staff member who handled the ticket; the
comment can be overwritten forever and sent without stars; a double click can save twice; nothing happens
if the DM fails; not in staff stats, the dashboard or the privacy tools; modmail has none.

- **New table `ticket_ratings`** = the single source of truth: a "pending" row at close with the
  handling staff (the claimer, else the closer). A click is ONE atomic UPDATE (opener only, not rated yet,
  window open), which also fixes the double-click race. Same button ids, so DMs already sent keep working.
- **Comment:** once, only after stars, max 1000 characters, run through the automod word/insult filters →
  flagged comments are shown to staff in a spoiler, not blocked. No pings anywhere.
- **Shown in:** the transcript log (edited to add ★), `/staff stats` + the weekly staff report
  ("★4.6 (5)"), and dashboard Tickets: average per staff, per priority, 8-week trend (CSS bars, no chart
  JS), response rate, recent low ratings. Optional low-rating alert (≤2★) in the alerts channel.
- **Modmail:** the same rating on close (off by default).
- **Privacy:** export (the ratings you gave; staff see only stars + date about themselves), /wipedata
  blanks the opener + comment but keeps the stars, comments cleared after 180 days, rows deleted after 2 years.

Decisions: O1 tickets on (today's behaviour), modmail off (D) · O2 if the DM fails, post the rating
in the ticket channel and let the opener view it read-only until deletion (D) · O3 7-day window (D, 1–30) ·
O4 copy old ratings into the new table (D, additive) · O5 low-rating alert on, ≤2★ (D) · O6 the rated
staff member can see the comment (D).

---

## 4. Command explorer (website)

`/commands` exists today but lists only the everyone-commands (site.js:103-160). It becomes a full
explorer generated from the real command data, so it never goes stale.

- **Data:** `commandEntries()` (retirement.js:96-128: every command, subcommand and context menu, owner tools
  already excluded) + each command's own 8-language descriptions (commandLocalizations.js) + access tier
  (everyone / Manage Server / Administrator / owner kit) + "Moved to the dashboard: <page>" when retired.
  Built on the first request, cached per language.
- **Page:** one card per command with an anchor (`/commands#case-search`), description, options table, an
  example (generated; hand-written for ~10 popular ones), and an access tag. `/commands/case` → 301 to the anchor.
- **Search/filter without JavaScript:** `?q=&cat=&who=`, plus filter links; the one static script adds
  live filtering. **CSP ✓:** the site blocks all forms (`form-action 'none'`, shell.js:22) → allow
  `'self'` on /commands only (as the member portal does).
- **Tests:** every command appears once in all 8 languages, /database never appears, translated
  descriptions, filters, CSP (no inline script/style), contrast, layout check.

Decisions: O1 list the owner kit with an "owner-only when retired" tag; hide /database (D) · O2 dashboard
link = page name only (D) · O3 auto examples + ~10 hand-written (D) · O4 `form-action 'self'` on
/commands only (D) · O5 the "Owner" folder shows as "Recovery" (D).

---

## 5. Voice room controls (Join-to-Create) — no schema change

Room state already lives in the JTC key-value config (`temporaryChannels[id] = {ownerId, …}`,
database.js:1020, row-locked `mutateJoinToCreateConfig` :949), so this needs no schema change.

**Existing bugs to fix first (verified by Claude ✓):**
- B1 ✓ The owner gets a member overwrite that ALLOWS Speak (joinToCreateService.js:598); member overwrites beat the
  Muted role's deny (muteService.js MUTED_DENY) → a muted member can create a room and talk. Fix: no Speak.
- B3 ✓ The same overwrite gives the owner MoveMembers → they can disconnect anyone, admins included. Remove it;
  kicks go through the panel's checks.
- B2 ✓ Transfer writes with an unlocked `client.db.set` (voiceStateUpdate.js:270), never moves the owner
  overwrite (the old owner keeps power), and renames without the rate limit.
- B4 User selects aren't routed (interactionCreate.js:427) → member pickers use a modal with a user select.

**Panel:** one message in the room's own voice text chat, posted when the room is made. Buttons: Lock/Unlock,
Hide/Unhide, Rename, Limit, Permit, Reject, Kick, Transfer, Claim, Settings (bitrate, region). customIds
`vroom:<action>:<roomId>` / `vroomm:` (modals). Every click re-checks: the room still exists, the clicker is the
owner or an Administrator (logged), Claim only when the owner left and the clicker is inside. defer first;
modals declare opensModal.
**Safety:** overwrites edited per target (never `.set()`), so the Muted role and staff overwrites survive; Permit
never grants Speak/Send. Room owners can't target bots, the server owner, Administrators, OWNER_IDS, staff
or themselves. Rename limit (Discord: 2 per 10 min) is tracked → "next rename <t:R>". Room names pass through the
automod word/invite/URL filters (refused, no case). The bot needs Manage Permissions + Send/Embed in the room;
without them the panel is not posted and a warning is logged. Staff guard/anti-nuke unaffected (bot actions
ignored). Startup reconcile: gone rooms unregistered, empty rooms deleted, ownerless rooms left to Claim.
**Dashboard:** Join-to-Create → "Room controls" (a checkbox per control, admin override).

Decisions: 1 panel in the room's own chat (D) vs one interface channel · 2 admin override on, logged (D) ·
3 staff can't be kicked/rejected by room owners (D) · 4 remove the owner's native Move Members + Speak (D) ·
5 no waiting room in v1; bitrate + region in Settings (D) · 6 no `/room` command in v1 (D) · 7 blocked
name = refused only, no case (D) · 8 all controls on by default (D).
Unverified: [I1] a fitting voice/channel log event type exists · [I3] channelUpdate logging may spam for
bot overwrite edits → skip the bot's own edits if so.

---

## Build plan (after OK)

- **Wave 1 (parallel, worktrees):** A schema v14 + /schema-change (all 3 tables, versions, allowlist,
  workflows) · B command explorer (no schema; independent).
- **Wave 2 (on top of A):** C voice XP · D invite tracking · E ticket ratings, in parallel.
- Then: merge, `npm test` + `test:db` on v14, discord-reviewer over everything, an owner test script per feature.
- Deploy adds: SCHEMA_VERSION=14; Manage Server must be granted for invite tracking; new translations
  (7 languages) for native review.
