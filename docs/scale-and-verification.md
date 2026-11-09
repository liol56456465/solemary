# Scale and verification (B5 T5)

For Ramūnas. What to do before Mewvo grows past 100 servers, what to tell Discord, and the limits to watch.
`[I#]` = not verified yet. File references are to `feature/dashboard-members` at the time of writing.

## 1. Verification checklist

An unverified bot cannot join more than 100 servers. Discord opens the application form at 75 servers.
Review takes days to weeks [I11], so apply at about 75.

1. Turn on 2FA on your Discord account (the form requires it).
2. Create a Developer Team and move the Mewvo application into it (recommended; lets a second person help later).
3. Owner ID verification (Discord's identity check through Stripe) when the form asks for it.
4. Public Terms and Privacy URLs: `https://<site>/terms` and `https://<site>/privacy` (already served,
   `src/services/site/i18n.js:162`). Before applying, check that the privacy page says:
   - which privileged intents we use and why (section 2 below);
   - message text is not stored, except a short excerpt a staff member attaches to a case as evidence
     (`mod_case_evidence.excerpt`, `src/utils/database/schema.js:269`, at most 500 characters,
     `src/services/enforcement/evidenceService.js:139`); the page already says this
     (`src/services/site/pages/legal.js:109`);
   - the retention table, and deletion on request;
   - the `guilds` OAuth scope line (dashboard login).
5. A short bot description and the support server invite.
6. Intent justification text + screenshots/video (sections 2 and 3).
7. The prefix-commands decision (section 4) made before you apply.
8. Apply at about 75 servers.

## 2. Privileged intents: justification drafts

Non-privileged intents always requested: Guilds, GuildMessages, GuildMessageReactions, DirectMessages,
GuildVoiceStates, GuildBans, AutoModerationExecution and GuildInvites (invite tracking, v14: inviteCreate /
inviteDelete keep the per-server invite use cache; no justification needed).

Both intents are switchable: `ENABLE_MESSAGE_CONTENT` and `ENABLE_GUILD_MEMBERS` (default true,
`src/config/intents.js`). If Discord refuses one, set it to `false` and the bot still starts; the features
below switch off and the startup log shows one warning per disabled feature (`src/events/ready.js`).

### Message Content (draft text)

> Mewvo is a moderation bot. It reads the text of server messages only to moderate them and to run
> features the server's admins turn on. Message text is processed in memory and is not stored; the only
> text kept is a short excerpt that a moderator deliberately attaches to a case as evidence. Features:
> 1. Automod filters: scam links, NSFW links, foreign server invites, personal information, blocked and
>    sexual words, insults and harassment, caps floods, forbidden characters, language checks, duplicate
>    and cross-channel spam, and each server's own word filters. Edited messages are checked again so
>    filters can't be bypassed by editing, and a first offence can get a heads-up instead of a penalty.
> 2. Counting game: checks that each message in the counting channel is the next number.
> 3. Tag auto-responses: replies with a saved answer when a message contains a trigger word chosen by admins.
> 4. Modmail: staff type replies in a staff channel and Mewvo relays them to the member by DM; messages
>    starting with `//` stay as internal staff notes.
> 5. Logs and archives the admins turn on: the text of edited/deleted messages in the server's log
>    channel, starboard reposts, and ticket transcripts sent when a ticket closes.

Where each one reads text (checked with grep):

| Feature | Code |
| --- | --- |
| Automod filters (all text checks) | `src/services/automod/automodService.js:232` (`collectHits`), filters in `src/services/automod/filters.js` |
| Automod on edits (anti-bypass, heads-up) | `src/events/messageUpdate.js:24`, `src/services/automod/headsUp.js` |
| Automod review card excerpt (posted to staff, not stored) | `src/services/automod/reviewCards.js:222` |
| Automod test run on old messages (dashboard) | `src/services/automod/backtest.js:358` |
| "Report message" context menu (excerpt in the staff card) | `src/services/automod/memberChecks.js:101` |
| Counting game | `src/events/messageCreate.js:216` (`handleCountingGame`) |
| Tag auto-responses | `src/services/community/tagService.js:161` (`respondToTags`) |
| Prefix commands | `src/events/messageCreate.js:92` (`handlePrefixCommand`) |
| Modmail staff relay + `//` notes | `src/events/messageCreate.js:79`, `src/services/modmailService.js:507-511` |
| Message delete / edit logs | `src/events/messageDelete.js:65`, `src/events/messageUpdate.js` |
| Starboard repost | `src/services/community/starboardService.js:86` |
| Ticket transcripts | `src/services/ticket.js:686` (`generateTranscript`; sent as a file, not stored) |
| XP per message (only "is it empty") | `src/events/messageCreate.js:279` |

Not affected by the intent (Discord always sends the text of DMs and of messages that mention the bot):
modmail from members (`handleModmailDm`, `src/services/modmailService.js:373`) and the setup wizard's
typed answers in DMs (`src/commands/Core/configWizard.js:224`).

### Guild Members (draft text)

> Mewvo needs member join, leave and update events to welcome new members, protect servers from raids and
> keep moderation in force: a muted member who leaves and rejoins gets the mute back, a banned member gets
> the Banned role in the support server, and role and level rules are applied on join. It fetches the
> member list only for staff tools (role rules backfill, level role sync, staff activity), rate-limited
> and at most once a minute per server.

| Feature | Code |
| --- | --- |
| Welcome / goodbye messages, auto roles, verification on join | `src/events/guildMemberAdd.js:112,202`, `src/events/guildMemberRemove.js:26` |
| Join gate, raid tracking, impersonation check, probation | `src/events/guildMemberAdd.js:80-94`, `src/events/guildMemberUpdate.js:43` |
| Mute + temp role re-apply on rejoin, Banned role on join | `src/events/guildMemberAdd.js:60-74` |
| Role rules (join, role change, backfill) | `src/events/guildMemberAdd.js:97`, `src/events/guildMemberUpdate.js:37`, `src/services/members/roleRuleService.js:240` |
| Level roles on rejoin and the startup sync | `src/events/guildMemberAdd.js:105`, `src/services/leveling/levelRoleSyncService.js:167` |
| Member join/leave/update logs, member insights | `src/events/guildMemberAdd.js:206`, `src/events/guildMemberRemove.js:90,149`, `src/events/guildMemberUpdate.js:47` |
| Temp roles end when removed by hand, kept on leave | `src/events/guildMemberUpdate.js:26`, `src/events/guildMemberRemove.js:153` |
| Full member list (all through one gate) | `src/utils/memberFetchGate.js:152`; callers: `src/services/enforcement/bannedRoleService.js:103`, `src/services/staffActivityService.js:273`, `src/commands/Enforcement/staff.js:155`, `src/services/dashboard/enforcementRoutes.js:333`, `src/services/randomMemberService.js` |

Without the intent Discord sends none of these events; the three `guildMember*` handlers also return at
once (`hasIntent('GuildMembers')`), and full member fetches return the cache marked partial
("based on cached members"), so the Banned role sync and staff tools still run on what is cached.

## 3. What to screenshot or record

Discord reviewers want to see each intent in use. Record on a test server, never with real member data:

- Message Content (short screen recording): post a scam link → automod deletes it and the staff card appears;
  edit a clean message into a blocked word → caught; counting game (right and wrong number); a tag trigger
  reply; a modmail reply from the staff channel arriving in the member's DM, and a `//` note not arriving.
- Guild Members: an alt joins → welcome message + join log; a muted alt leaves and rejoins → muted again;
  a role rule giving a role on join.
- Screenshots: the dashboard automod settings page, the privacy page section on intents and storage.

## 4. Prefix commands: decision for you

Discord does not accept prefix commands as a reason for Message Content. Every command already exists as a
slash command. Two options:

- **A. Drop prefix commands outside Mewvo's own servers.** Keep `!` commands in the main and support
  servers only. Discord grants the intent per bot, not per server: if it is granted (for automod etc.),
  using it for prefix commands everywhere isn't what we told Discord, so other servers lose them. If it is
  refused, prefix commands stop everywhere (`ENABLE_MESSAGE_CONTENT=false` switches them off). Needs a
  small server check in `handlePrefixCommand` (not built).
  - Plus: nothing changes for our own staff; the justification stays honest.
  - Minus: depends on the intent being granted; other servers lose `!` commands.
- **B. Mention prefix (`@Mewvo cmd`).** Discord always sends the text of messages that mention the bot, so
  this works with or without the intent, in every server.
  - Plus: works even if Message Content is refused; no intent reason needed.
  - Minus: longer to type; one more parser change (accept `<@botId>` and `<@!botId>` as the prefix);
    the `!` habit breaks for existing staff.

A and B can be combined (`!` in our servers, `@Mewvo` everywhere). Nothing is built for B yet.

## 5. Rate limits, session starts, sharding

- REST: about 50 requests per second for the whole bot, plus per-route limits; discord.js queues these.
  10,000 failed requests (401/403/429) in 10 minutes → temporary IP ban from Cloudflare [I18].
- Gateway: 120 events sent per 60 s per connection (presence updates, member requests). Full member
  fetches are paced by `src/utils/memberFetchGate.js` (one per server per minute, two at once).
- Session starts: 1,000 logins per 24 h. Each restart uses one. The boot log now shows
  `Session starts: N of 1000 left today ...` from `GET /gateway/bot` (`src/utils/sessionStartLimit.js`,
  called from `src/events/ready.js`; a failure only logs a warning) and warns below 100.
- **Restart backoff (note; start scripts unchanged):** a crash loop that restarts every 10 s uses 1,000
  session starts in under 3 hours; at 0 the bot can't log in until the reset, and Discord may reset the
  token [I17]. If the log shows the number falling fast, stop the deployment instead of letting it retry.
  If Replit restarts on crash, a wait before `login()` that grows with each recent restart (for example 5 s,
  30 s, 2 min, 10 min) would be the fix; propose separately.
- Sharding: Discord requires it at 2,500 servers per connection (close code 4011). Plan `shards: 'auto'`
  (still one process) at about 1,500 servers; the `/gateway/bot` line already shows Discord's recommended
  shard count.

## 6. Database size plan

Estimates from `docs/multi-server-b5.md` section 2 [I5]:

- Active server (about 200 members, 1,000 messages/day): 0.3–0.5 MB per month; idle server about 20 KB.
- 500 servers (20% active): about 50 MB/month, so 500 MB in 8–10 months; 1,000 servers: 4–5 months.
- Free tiers are 0.5 GB (Supabase goes read-only over it [I7]; Neon free is also 0.5 GB [I8]).

Plan:
1. Watch the DB size card on the owner Health page (T4; amber at 70%, red at 90% of `DB_SIZE_LIMIT_MB`).
2. Move to Supabase (go-live checklist) and plan a paid tier before 300 MB.
3. Retention deletes and new indexes only after your OK (listed in `docs/multi-server-b5.md` section 2).
