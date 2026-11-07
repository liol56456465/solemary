# Multi-server B0: settings per server

Phase B0a built the per-server settings core. Phase B0b moves the callers listed below onto it.
Line numbers are from `a607e88` plus the B0a commit. Re-check them with `grep` before editing.

## The core (B0a): `src/services/settings/guildSettings.js`

| Function | What it does |
|---|---|
| `resolveSetting(guildId, key)` | One setting of one server (sync, from the cache). |
| `settingsFor(guildId)` | Every registry setting of one server, as `{ key: value }` copies. |
| `refreshGuildSettings(guildId)` | Async. Reads that server's `guild_settings` row into the cache, then returns `settingsFor`. |
| `resolvedSource(guildId, key)` | `'database' \| 'env' \| 'default'` (a non-home server never gets `'env'`). |
| `isHomeGuild(guildId)` | True for the configured `MAIN_GUILD_ID` / `SUPPORT_GUILD_ID`. |
| `SettingsUnavailableError` | `type: 'database'` plus a `userMessage` ("…nothing was changed…"). |
| `neutralValue(entry)` (registry) | The default for a non-home server. |
| `missingSeedPatch(data, entries)` | The additive seed patch: only keys the row does not have yet. |

Rules:
- **Home servers** (main + support): `resolveSetting` *is* the old `getSetting`. It reads the same sources in the
  same order: stored value, then env, then the hardcoded fallback. If the database was down at boot it uses env
  (owner decision 1). `tests/fixtures/homeSettingsSnapshot.json` was captured from the old code, and
  `tests/settingsCore.test.js` checks that the core returns exactly those values.
- **Any other server**: only what it stored itself. Without a stored value it gets `neutralValue`:
  channel/category/role/url → `null`, lists → `[]`, production-only → empty. Generic defaults stay
  (numbers, durations, booleans, the cat name, empty JSON). It never gets an env value or a production ID.
- **Database error**: when the table was never read (DB down at boot) and the server was not refreshed,
  `resolveSetting` / `settingsFor` throw `SettingsUnavailableError` for a non-home server. `refreshGuildSettings`
  throws when the DB is down or the query fails, and leaves the cache untouched. An empty row is not an error:
  it gives the neutral defaults.
- **Seed**: `seedFromEnvOnce()` (startup, `app.js` `loadSettings`) only ever adds keys the row lacks
  (`missingSeedPatch` + `data || patch` under `FOR UPDATE`). It only seeds the main/support rows.
  No new table or column, no migration.
- **Compatibility, unchanged**: `getConfiguredSetting(key)` and the config getters (`enforcementConfig.X`,
  `automodConfig.X`, via `bindSettingGetters`) still return the main (or support) server's values.
  `getSetting(guildId, key)` still lends env/production fallbacks to any server. It is marked `@deprecated`, and
  B0b moves its callers.

Batches don't overlap by file: each file to edit belongs to exactly one batch. The exception is `postModLog`'s callers
(batch 2). They are spread across the tree, so batch 2 adds the `guildId` argument with a default for the main server
(`guildId = enforcementConfig.mainGuildId`), and every batch passes the real guild in the files it owns.

## How to move a caller (B0b)

1. Find the server the code acts in (`guild.id`, `interaction.guildId`, `record.guild_id`, …). If there is none,
   add a `guildId` parameter and pass it from every caller (listed per site below).
2. Replace `enforcementConfig.X` / `automodConfig.X` / `getConfiguredSetting('X')` / `getSetting(g, 'X')`
   with `resolveSetting(guildId, 'X')`.
3. Handle `null` / `[]`: "not set up in this server" must be a clear message or a quiet skip. It must never
   fall back to the main server.
4. Do not catch `SettingsUnavailableError` and turn it into defaults. Let it reach the error handler. In
   crons and events, skip that server for this run.
5. Keep home-server behaviour identical: the snapshot test must still pass. Add a test with a non-home server id.

## Inventory: callers that ignore the server

Totals: **4 batches, 69 rows** (a row is one site, or a few lines of one setting in one function; ~95 lines in all),
plus the dashboard list (B3) and the home-only sites to keep. Batch 2 is the largest in edits because `postModLog` has
27 callers. If it runs long, split it off as a fifth agent.
"guild?" says whether the server id is already in scope at that line.

### Batch 1: enforcement actions (16 rows, 8 files to edit)

| file:line | setting | guild? / note |
|---|---|---|
| src/services/enforcement/massActionGuard.js:58 | massActionWindowMs (default param) | yes (`guildId`) |
| src/services/enforcement/massActionGuard.js:74 | massActionWindowMs (default param) | yes (`guildId`) |
| src/services/enforcement/massActionGuard.js:93 | massActionBlockMs | yes (`guild.id`) |
| src/services/enforcement/massActionGuard.js:95 | massActionBlockMs | yes |
| src/services/enforcement/massActionGuard.js:97 | massActionWindowMs | yes |
| src/services/enforcement/massActionGuard.js:106 | massActionBlockMs | yes |
| src/services/enforcement/massActionGuard.js:135 | massActionLimit | yes |
| src/services/enforcement/massActionGuard.js:138 | massMuteLimit | yes |
| src/services/enforcement/muteService.js:40 | mutedRoleId (`findMutedRole(guild)`, 8 callers) | yes (`guild.id`) |
| src/services/enforcement/warnRoleService.js:26 | warnRoleIds (`syncWarnRoles(guild, …)`) | yes |
| src/services/enforcement/evidenceService.js:191 | evidenceChannelId, modLogChannelId (`evidenceChannel(client)`) | **no**: add guildId |
| src/services/enforcement/appealReviewer.js:22 | independentAppealReview (`getSetting(guildId)`, leaky) | yes |
| src/handlers/enforcementPanel.js:199 | enforcementTemplates (`getConfiguredSetting`) | yes (`interaction.guildId`) |
| src/utils/commandGate.js:37 | adminRequestChannelId (main branch; others already use `getStoredSetting`, :40) | yes. Fold into `resolveSetting` |
| src/services/enforcement/massActionGuard.js (alert DM) | OWNER_IDS DM'd for every server | B4 sends this to the server owner. Leave it for now |
| src/services/enforcement/muteService.js:70, :118; enforcementService.js:791, :802; events/channelCreate.js:29 | callers of `findMutedRole(guild)` | guild passed already, no change (enforcementService.js belongs to batch 2) |

### Batch 2: automod, staff channels, enforcementService.js (18 rows, 10 files + the `postModLog` caller files)

| file:line | setting | guild? / note |
|---|---|---|
| src/services/automod/channelRouting.js:45 | reviewChannelId (`currentChannelIds()`) | **no**: add guildId |
| src/services/automod/channelRouting.js:46 | alertsChannelId | **no** |
| src/services/automod/channelRouting.js:47 | modLogChannelId | **no** |
| src/services/automod/channelRouting.js:36 | `resolveChannelId(purpose, ids = currentChannelIds())` | signature → `(guildId, purpose, ids?)` |
| src/services/automod/channelRouting.js:52-55 | `fetchStaffChannel(client, purpose)` uses `mainGuildId` (:54) | add guildId |
| src/services/enforcement/enforcementService.js:196-197 | `postModLog(client, action, fields)`: `resolveChannelId(purpose)` + `guildId = mainGuildId` | **no**: add guildId. 27 callers in 19 files (`grep -rn "postModLog(" src`), most have a guild in scope |
| src/services/enforcement/enforcementService.js:112 | rejoinInviteMaxAgeSeconds (`createRejoinInvite`, 8 callers) | yes (`guild`) |
| src/services/automod/alertPost.js:16, :21 | `fetchStaffChannel` / `resolveChannelId` callers | thread guildId |
| src/services/automod/automodTuning.js:76 | `fetchStaffChannel(client, 'alerts')` | thread guildId |
| src/services/automod/automodContest.js:137 | `fetchStaffChannel(client, 'review')` | thread guildId |
| src/services/automod/reviewCards.js:51 | `fetchStaffChannel(client, 'review')` | thread guildId |
| src/services/automod/automodSettings.js:92 | exemptChannelIds (main list merged into every server's list) | yes (`guildId`) |
| src/commands/Enforcement/automod.js:89 | exemptChannelIds (status embed) | yes (`guildId`) |
| src/services/automod/filters.js:103 | extraBlockedWords (`blockedCompiled()`: one compiled list for all servers) | **no**: compile and cache per guild |
| src/services/automod/customRules.js:212 | automodCustomRules (`storedCustomRules()`) | **no**: add guildId |
| src/services/automod/customRules.js:224, :232 | `storedCustomRules()` fallbacks | thread guildId |
| src/services/automod/customRules.js:301 | `storedCustomRules()` while `customRuleLimit(guildId)` is per guild | yes |
| src/commands/Enforcement/automod.js:265, :431 | `storedCustomRules()` (autocomplete, list) | yes (`interaction.guildId`) |

### Batch 3: appeals, reports, modmail (19 rows, 7 files)

| file:line | setting | guild? / note |
|---|---|---|
| src/services/enforcement/appealService.js:64 | appealWindowMs | `record.guild_id` |
| src/services/enforcement/appealService.js:79 | appealCooldownMs | `record.guild_id` |
| src/services/enforcement/appealService.js:117 | appealsCategoryId (`getAppealsCategory(mainGuild)`) | yes (`mainGuild.id`); rename the param |
| src/services/enforcement/appealService.js:124 | reportsCategoryId (`getReportsCategory(mainGuild)`) | yes |
| src/services/enforcement/appealService.js:126 | appealsCategoryId | yes |
| src/services/enforcement/appealService.js:382 | supportGuildId (not a setting) | B4: ban/kick appeals of other servers go to the web form |
| src/services/enforcement/appealService.js:384 | supportAppealsCategoryId | home-only until B4. Make it explicit (`isHomeGuild(record.guild_id)`) |
| src/services/enforcement/appealStatusService.js:17 | staleAppealReminderMs (`staleAfter()`) | **no**: add guildId |
| src/services/enforcement/staleAppealService.js:60 | staleAppealReminderMs | yes (`guild`) |
| src/services/enforcement/staleAppealService.js:86 | staleReportMs | yes |
| src/services/enforcement/staleAppealService.js:87 | staleReportMs | yes |
| src/services/enforcement/staleAppealService.js:90 | staleAppealReminderMs | yes |
| src/services/modmailService.js:221 | modmailCategoryId | yes (`guild`) |
| src/services/modmailLinks.js:85 | modmailCategoryId (`importModmailTopicsOnce(guild)`) | yes |
| src/services/openChannelCap.js:31 | openChannelCap (`withOpenChannelSlot(guild, …)`) | yes |
| src/services/site/memberPortal.js:189 | appealWindowMs (`config = enforcementConfig`, :177) | `record.guild_id` |
| src/services/site/memberPortal.js:190 | appealWindowMs | same |
| src/services/site/memberPortal.js:195 | appealCooldownMs | same |
| src/services/site/memberPortal.js:246 | `buildRecordView({ config = enforcementConfig })` | pass per-record config |

### Batch 4: support server, invites, verification, rules, community, site (16 rows, 13 files)

| file:line | setting | guild? / note |
|---|---|---|
| src/services/enforcement/bannedRoleService.js:22, :50, :79 | bannedRoleId (support server) | home-only by design (Support = Mewvo's own). Make it explicit |
| src/services/enforcement/dmTemplates.js:11 | supportServerInvite (`invite()`, every punishment DM) | the case's guild is in the template data. Owner question 1 |
| src/commands/Core/support.js:18 (+ :10 FALLBACK_INVITE) | supportServerInvite (`supportInviteUrl()`) | callers support.js:30, handlers/help/helpButtons.js:49, commands/Core/help.js:112. Owner question 1 |
| src/app.js:340 | supportServerInvite (member portal) | website = Mewvo's. Keep as home value |
| src/services/oauthVerification.js:244 (+ :32 DEFAULT_SUCCESS_REDIRECT = main invite) | verifySuccessRedirect | the verifying guild is in the OAuth state. **Leak**: other servers send users to Mewvo's main server |
| src/services/verificationQuiz.js:283 | rulesPost (`getSetting(guildId)`, leaky) | yes |
| src/services/verificationQuiz.js:285 | serverRules (`getSetting(guildId)`, leaky) | yes |
| src/services/rules/serverRules.js:32 | serverRules (`getConfiguredSetting`) | **no**: add guildId |
| src/services/rules/serverRules.js:37 | reasonRuleLinks (`getConfiguredSetting`) | **no**: add guildId |
| src/commands/Moderation/rules.js:55 | serverRules | yes (`interaction.guildId`) |
| src/commands/Moderation/rules.js:56 | rulesPost | yes |
| src/services/community/catService.js:61 | catName (`getSetting(guildId)`, leaky) | yes |
| src/services/community/catService.js:62 | catAnnounce (`getSetting(guildId)`, leaky) | yes |
| src/services/billing/premiumEffects.js:92 | premiumRoleIds (main-server supporter roles) | home-only by design (roles live in main) |
| src/services/site/site.js:572 | transparencyReportEnabled | the website reports the main server only. Keep home until a per-server site exists |
| src/services/site/site.js:580 | trustCardEnabled | same |

Batch 4 done (owner decisions 2026-11-07): new registry keys `appealsHome` ('mewvo' | 'own', default 'mewvo') and
`appealsInvite` (invite or null). `dmTemplates.appealInvite(guildId)`: home servers (and no server named) keep
`supportServerInvite`; others get it for 'mewvo', their own invite for 'own', no invite line for 'own' without one.
`/support` and the website stay Mewvo's Support server. The dashboard choice is B3 work (the dashboard edits home
servers only, which ignore it). Batch 3 still has to pass `{ guildId: record.guild_id }` to `appealDeniedDm`
(appealService.js:829); until then it sends the home invite, as before.

### Dashboard (B3, not B0b: needs `/dashboard/:guildId` first)

The pages always read the main/support server through one chokepoint plus a few direct reads:
- src/services/dashboard/modules/common.js:86 `registryValue(ctx, key)` → `getSetting(registryGuildId(key))`.
  Callers: modules/automod.js (12), enforcement.js (1 loop over KEYS, :22), leveling.js (4), logging.js (1), rules.js (3),
  support.js (5), verification.js (3). `storedCustomRules(ctx)` in modules/automod.js:70, :353, :527, :550, :564, :569, :688.
- src/services/dashboard/setupForms.js:20 (all REGISTRY_KEYS), overview.js:161, :505, :510 (`settingSource`),
  routes.js:526 (staffHandoverNote), :536 (savedCaseSearches), enforcementRoutes.js:624 (massActionLimit),
  ownerRoutes.js:385 (warnRoleIds), :387 (bannedRoleId; already guarded by `guild.id === supportGuildId`).
- Already guarded, fine: ownerRoutes.js:351 (`guildRole(guild.id) === 'main'`).
- `updateSettings` refuses any non-home server (guildSettings.js `updateSettings`). B3 must open it up
  for other servers with the same registry validation.

### Home-only by design: keep as they are

- src/config/enforcement.js:114, :118 (startup validation of the home env).
- src/config/testMode.js:261, :279, :280 (test-mode checks of the home servers' values).
- src/services/settings/settingsBackup.js (backs up the home rows).

## Not settings, but tied to the main server (B1/B2, for reference)

`enforcementConfig.mainGuildId` / `supportGuildId` filters (commandLoader, channelRouting.js:54, ownerRoutes, memberPortal,
memberBackupService.js:30-57, site.js:193, trust/transparency services) belong to B1/B2, not B0b.

## Open questions for the owner

1. **Support invite for other servers**: their punishment DMs and `/support` (`supportServerInvite`). Today
   every server would show Mewvo's Support invite. Options: (a) keep Mewvo's Support invite for `/support` (it is the
   bot's help server) but leave it out of other servers' DMs, (b) a per-server invite, (c) both. B0a gives other servers `null`.
2. **Generic numeric defaults** (mass-action limits, appeal window 30 days, cooldown 7 days, stale report 7 days):
   B0a keeps them for other servers (they are not Mewvo-specific). Confirm, or make them "off until set".
3. **Database down at boot**: the home servers keep running on env values (owner decision 1). Other servers
   throw (their settings are unknown). Confirm that's wanted, or should other servers also refresh lazily?
