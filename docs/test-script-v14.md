# Discord test script — v14 features + beginner/public waves (2026-11-09)

Run on Replit after the deploy (owner OK required). **Home** = the main Mewvo server; **X** = a test server
that is NOT one of Mewvo's servers (add Mewvo with the install link; set X's Discord language to German for
the language steps). Use an alt account as the member. Expected result after each →.

## 1. Voice XP (Dashboard → Leveling → Voice XP)
1. Card shows off, 3–7 XP, cap 120, people needed 2. Turn on, save → "Voice XP settings saved."
2. Alone in voice 3 min → `/rank` voice time stays 0, no XP.
3. With the alt in the same channel 3+ min → `/rank` shows 1–2 min more, XP +3–7/min.
4. Deafen 2 min → time stops. AFK/excluded channel → no increase.
5. Chat right after → chat XP still given. `/leaderboard type:Voice time` → both accounts, no pings.

## 2. Invite tracking (needs Manage Server + Manage Roles in X)
1. `/invites view` → "Invite tracking is off…". Dashboard → Invites → on → codes card fills.
2. Alt joins via your invite → join log "Invited by: @you (`code`)", account age.
3. `/invites view user:@you` (as a member) → total 1. `/invites leaderboard` → you are #1.
4. Alt leaves → leave log "Joined via…", total 0, fake 1. Rejoin → "not counted again".
5. `/invites reset user:@you`: another member clicks Reset → refused; you click → reset.

## 3. Ticket ratings
1. Alt opens a ticket, staff claims + closes → ONE close DM naming the server with the transcript attached,
   plus a separate rating DM (1–5, comment, no thanks).
2. Click 4 → only "Add a comment" left; ticket log and transcript log show ★★★★☆ and the claimer.
3. Rate 1 → low-rating alert in the alerts channel, staff as "name (id)", no ping.
4. Alt blocks DMs → survey appears in the closed ticket channel; alt can read, not type; after rating or
   "No thanks" the alt can no longer see the channel (also 30 min after a rating, or when the window ends).
5. Close an unclaimed ticket → your confirmation says the rating will count for you. `/staff stats` → ★x.x (n).

## 4. Website
1. `/commands` → member commands only, "Show all commands (incl. admin)" link; search works.
2. Home, pricing and FAQ don't say "you can't add Mewvo yet"; every "Add to Discord" has the permissions line.
3. `/de/privacy` and `/de/terms` → German "In short" box + "the English version is binding".

## 5. A new server owner (X)
1. Adding Mewvo → German welcome, "Admins: …/setup…", button "Dashboard (für Admins)". If no channel is
   writable, the server owner gets a DM instead.
2. Put a role above Mewvo → `/setup` first row ➖ names it; dashboard checklist: "Essentials" (role position
   first) then "Optional"; progress counts essentials only.
3. `/help` → step 1 is `/setup`, no "boost" line, German category names.
4. Level-up posts are OFF until turned on in Dashboard → Leveling.
5. Dashboard → Enforcement → "Post the appeal panel" → one panel in X, nothing new in Mewvo Support.
   `/setappeal` without a category → a private "Appeals" category is created.

## 6. Automod in X
1. No review channel / mod log → `/automod enable` refused ("pick a channel…").
2. With a review channel → "on" + Report only line; a spam message gives a review card with Apply,
   nothing deleted. After switching to On it stays On.
3. Three automod warns → no ban; DMs without "Warning X of 3"; `/background` "Automod warning — doesn't
   count toward bans". Dashboard → Warn ladder settings: "Automod warnings count" on → the 3rd bans.
4. Warn ladder off → manual warns record only, no ban, no ladder text in DMs or the panel.

## 7. Moderation (X unless noted)
1. Moderator role (Dashboard → Commands) on the alt, no Administrator → `/enforcements` shows Warn/Mute/Kick
   (+Unmute/Remove warn), no Ban; in Home the same alt is refused.
2. Warn → result card "Next warn: …" + "Undo (mistake)"; alt DM: title first, "Warnings don't expire. 2 more
   warnings mean an automatic ban for 7 days.", "Case code: x (you need this to appeal)".
3. 3rd warn → automatic 7-day ban + "Mistake? Remove the warn" → unbanned, stage back, DM with invite.
   Unban of a ladder ban → "Unban only (stage stays)" / "Remove the warn (stage goes back)".
4. As the Moderator-role alt: Undo on an older warn after someone else's 3rd warn banned the member → refused.
5. Ban with "permanent" + cannot appeal → second red confirm "Yes, ban permanently".
6. Remove Mewvo's Ban Members → Ban refused at once naming the permission; the member gets NO DM.
7. Safety limit (set limit 2): after 1 kick "Heads-up: 1 more…"; when blocked, Unban/Unmute still work.
8. `/purge 5` → preview → Cancel (nothing deleted) / Delete (skipped count shown).
9. `/lock duration:2m` → role allows also locked; auto-unlock after ~3 min restores exactly.
10. Modmail staff channel → pinned "Start with // for a staff-only note"; relayed messages get ✅.

## 8. Verification and appeals (X)
1. Verify with Discord (German client) → consent asks for profile only (no "join servers for you"); German
   privacy line; German result page. In Home it still asks for "join servers" as before.
2. Warn the alt in X with no invite set → DM says "To appeal: contact the staff of X." (no Mewvo invite).

## 9. Member experience
1. `/language set` in a server without language roles → "Gespeichert: Mewvo schreibt dir DMs auf Deutsch…";
   DM the bot → German modmail prompt; Appeal button → German form, My record / My appeals German.
2. Giveaway: join twice → blue "Already entered" + Leave → left; winner gets a DM naming the server.
3. `/remind me in:1m text:test` → "⏰ Reminder you set 1 minute ago: test". `/report` → "Report sent".
4. `/wipedata` → 9 items incl. personal language; plain "what stays" text.
5. A non-admin running `/ban`-type commands → "Only server admins can use this…".
