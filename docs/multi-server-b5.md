# Multi-server B5: scale and Discord limits (plan, 2026-11-08)

Written from a read-only pass over `feature/dashboard-members`. [I#] = not verified yet.
Client (`src/app.js:68-94`): intents Guilds, GuildMembers, GuildMessages, GuildMessageReactions,
MessageContent, DirectMessages, GuildVoiceStates, GuildBans, AutoModerationExecution. No `makeCache`, no
`sweepers` (discord.js defaults: 200 messages per channel, unlimited member cache), no sharding.

## 1. What grows with servers or members
### A. Full member fetches (discord.js 14.27 throws on a gateway RATE_LIMITED reply)
- `serverstatsService.js:69` via `getCounterCount` :88 → `updateCounter` (cron `app.js:415`, loop `app.js:511-528`):
  one full fetch per counter per server every 15 min. Worst one. Fix: use `guild.memberCount`; bots from the
  cache; compute once per server per run. Same in `serverstats_list.js:26`.
- `levelRoleSyncService.js:150,181-183` (startup, `ready.js:85`): one full fetch per server with reward roles,
  one after another → gate, size cap, spread over about 30 min.
- `roleRuleService.js:233-239`, `dashboard/enforcementRoutes.js:328-334`, `staff.js:120`,
  `staffActivityService.js:195`, `bannedRoleService.js:100` → gate.
- `randomMemberService.js:39` (`/randomuser`): any member can trigger it, no limit → gate; cache-only in big servers.
- New `src/utils/memberFetchGate.js`: one fetch at a time per server (later callers join it), at least 60 s
  between fetches per server [I1], at most 1–2 at once across all servers, skip when the cache has ≥90% of
  memberCount, refuse above `FULL_FETCH_MAX_MEMBERS` (25,000), treat GatewayRateLimitError as "later".
### B. Crons and startup loops over every server
- `updateAllCounters` (app.js:505-540): only servers that have counters, short pause between servers,
  drop or opt-in the COUNTER_UPDATE log event.
- `catService.js:207` (5 min) and `birthdayService.js:327` (daily): config read per server → config cache or
  an in-memory set of servers that use the feature.
- `modmailService.js:216`: every modmail DM reads every server's config → cache / set of modmail servers.
- `userUpdate.js:21,61` → logEvent config read per server → config cache.
- Startup (`ready.js:55-89`: panelHealth, reactionRole reconcile, levelRoleSync): only servers with panels,
  paced, run as one background job about 60 s after ready.
### C. Hot path: about 4 DB reads per message (`messageCreate.js`)
- Counting config :213, getGuildConfig :89, getLevelingConfig :250 (getGuildConfig again), getUserLevelData
  :277, plus an addXp write at most once per user per minute. `getGuildConfig` has no cache
  (`guildConfigStorage.js:37`). The same uncached read happens on every `logEvent` (`loggingService.js:339`)
  and twice in `messageDelete.js:20,23`.
- Fix: a BoundedMap config cache in guildConfigStorage (about 2,000 entries, 60 s TTL, cleared on every write
  path), the same for the counting config. Result: about 0–1 reads per message.
### D. Unbounded in-memory maps
- `applicationService.js:21`, `tools_calculate.js:8,14`, `welcomeImageStore.js:17`, `starboardService.js:23-24,95`
  (loads every starboard post ever), `configService.js:11` → BoundedMap / TTL / load the last 30 days only.
### E. Startup REST
- `commandLoader.js` PUTs global + home command lists on every boot → hash and skip when unchanged (KV);
  200 creates/day [I2].
- 403 backoff per channel/server in `loggingService` and `serverstatsService` (Discord bans an IP for a while
  after 10,000 invalid requests in 10 min; Replit's IP may be shared [I3]).
### F. External APIs
- `feedService.js:286` YouTube RSS: 4 at once, 15 s timeout, stop after about 10 min and resume next tick.
- `search_define.js:27`: LRU of 500 words + cooldown [I4]. Twitch, weather, exchange rates: OK.
### G. Logs
- PRIVACY: `messageCreate.js:102,104,203` log prefix commands with their arguments at info → debug, no args.
- `interactionCreate.js:104` → debug. Level-ups are logged twice (`xpSystem.js:49`, `messageCreate.js:307`) →
  one, at debug. `levelRoleSyncService.js:89,115` → summary line only. `logger.js:200-203`: no maxSize →
  `maxSize: '50m'` + gzip.

## 2. Database growth (estimates [I5]; measure with pg_total_relation_size)
- Active server (about 200 members, 1,000 msgs/day): about 0.3–0.5 MB/month; idle server about 20 KB.
- 500 servers (20% active) ≈ 50 MB/month → 500 MB in about 8–10 months; 1,000 servers → about 4–5 months.
  Supabase free goes read-only over the limit [I7]; Neon free is also 0.5 GB [I8].
- Retention proposals (NEED OWNER OK: deleting data):
  - expired `temp_data` / `cache_data` rows (never deleted today [I6]);
  - `dashboard_audit` > 365 days (or 180);
  - `staff_activity` > 1 year;
  - test cases (`is_test`) > 30 days;
  - `starboard_posts` > 1 year.
  - Owner decisions: old low-XP level rows, and data of servers Mewvo left (today: kept until the server asks).
- Indexes (schema v13 via /schema-change, NEEDS OWNER OK):
  - add `user_levels(guild_id, level DESC, total_xp DESC)`;
  - drop the unused `idx_user_levels_xp` (it causes non-HOT updates);
  - add `user_levels(user_id)`, `dashboard_audit(created_at)`, `staff_activity(week_start)`,
    `starboard_posts(created_at)` [I9];
  - optional: `temp_data(key text_pattern_ops)` [I10].
- DB size card on the owner Health page (no schema change):
  - `pg_database_size` + the top 10 tables, cached 10 min;
  - `DB_SIZE_LIMIT_MB` (default 500), amber at 70%, red at 90%;
  - a daily check DMs OWNER_IDS at most once a day when over 70%.

## 3. Discord side
- **Verification:** an unverified bot can't join more than 100 servers; you can apply from about 75.
  Discord asks for owner ID verification, 2FA, a team (recommended), a description, and Terms + Privacy URLs.
  Takes days to weeks [I11]: apply at 75.
- **Message Content intent:** list every feature that reads message text — automod filters + anti-bypass,
  heads-up, counting game, tag auto-responses, modmail relay, `//` notes. Prefix commands are NOT an
  accepted reason → owner decision: drop prefix commands for other servers or switch to a mention prefix.
  We must be able to say that content is not stored.
- **Guild Members intent:** welcome / join gate, verification, mute re-apply, member logs, role/level rules,
  temp roles, impersonation checks, dashboard member list.
- **Degrade without an intent:** intents from env (`ENABLE_MESSAGE_CONTENT`, `ENABLE_GUILD_MEMBERS`); the bot
  still starts if one is refused.
- **Command limits:** 100 slash + context menus [I13]; we use 61 + 3 → keep under 90.
- **Rate limits:** 50 REST requests/s; 120 gateway sends per 60 s; 1,000 session starts per day → log
  `session_start_limit.remaining` at boot and add a restart backoff.
- **Sharding:** mandatory at 2,500 servers (close code 4011); `shards: 'auto'` (one process) from about 1,500.
- **Owner checklist:**
  1. 2FA + Developer Team.
  2. Privacy/Terms: intents, retention table, deletion on request, the `guilds` line.
  3. Intent justification text + screenshots/video.
  4. Prefix decision.
  5. Apply at about 75 servers.
  6. Watch the DB card; move to Supabase before 300 MB.
  7. VM RAM → `--max-old-space-size` at about 75% [I15].
  8. `shards: 'auto'` at about 1,500 servers.

## 4. Gateway cache (new `src/config/clientCache.js`)
- `Options.cacheWithLimits`:
  - `MessageManager` 50;
  - `GuildMemberManager` maxSize 25,000 (keep the bot's own member);
  - set to 0: ReactionUserManager, PresenceManager, GuildStickerManager, GuildScheduledEventManager,
    StageInstanceManager, ThreadMemberManager;
  - Invites / AutoModerationRules only if nothing reads them [I16];
  - keep ReactionManager and VoiceStateManager.
- Sweepers: messages every 900 s with a 3,600 s lifetime; threads default. No member sweeper.
- Show heap, cached members and cached messages on the owner Health page.

## 5. Agents
- T1 member fetch gate.
- T2 crons + startup pacing + command hash skip + feeds.
- T3 hot path: config cache, logs, bounded maps, clientCache.
- T4 retention + indexes + DB card. Indexes and deletes need the owner's OK; the DB card does not.
- T5 docs/scale-and-verification.md + env intents (after T3).
- Merge order: T4, T1, T3, T2, T5, then discord-reviewer. `app.js`: T3 owns the constructor, T2 owns
  `updateAllCounters`.
