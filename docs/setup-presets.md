# Setup presets — plan (2026-11-09, WAITING FOR OWNER OK, no code yet)

One-click starting configuration for a server, from /setup (button) and the dashboard Setup page.
Written by a read-only Plan agent; file:line references are as of bc0c1714.

## Key constraint
Settings live in 6 places with no cross-place transaction: registry `guild_settings`
(`updateSettings` guildSettings.js:456, one transaction + audit rows), automod KV (`automodSettings.js:153`,
setters :225-382), guild config (tickets `ticketSettingsService.js:76`, verification
`verificationSettingsService.js:91`, log events `loggingService.js:600`, log channels :618), welcome
(`welcomeService.js:135`), leveling (`leveling.js:509`), native AutoMod policies (`nativeBridge.js:49`).
So "apply" is a compensating plan with a "before" snapshot per step. Automod thresholds are hard-coded
(`config/automod.js:28-41`, owner decision 3, `settingsRegistry.js:21-22`), so presets can't change them.

## Presets
| Preset | Automod | Log events | Welcome/goodbye | Leveling | Rules library | Tickets / templates |
|---|---|---|---|---|---|---|
| community | on, enforce; heads-up + second chance on; gate age=flag | moderation.*, message.delete/edit, member.join/leave | on + default text if a channel is already set | on, cooldown 20 | respect, hate, harassment, spam, advertising, nsfw, scams, channels, tos, staff | 1 per user, DM on close; "Spam: 1h mute", "Ads: warn" |
| gaming | as community; caps/mentions monitor | + member.namechange | same | on, cooldown 15 | community + voice, spoilers, evasion | same + "Raiding: permanent ban" |
| friends | on, monitor; gate off | moderation.* | goodbye off | on | respect, hate, tos | none |
| study | on, enforce; disrespect on; caps monitor | moderation.*, message.* | on if channel set | off [I1] | respect, harassment, channels, debates, begging, minimod, tos | 2 per user, DM on close |
| strict | on, enforce; all rules on; heads-up + second chance off; gate age=kick 7d, links/botname=flag | moderation.*, message.*, role.*, member.* | unchanged | unchanged | community + doxxing, impersonation, raiding, evasion, names | slurs/harassment/scamming/raiding |

`english` and `characters` stay off everywhere (`DEFAULT_OFF_RULES` automodSettings.js:59).

## Never
- Create channels/roles or post anything (no setupTicketSystem, setupVerification, publish*Panel,
  postRulesMessages — dashboard/services.js:76-82); no permission changes (fixBotChannelPermissions).
- Touch modRole, auto-roles, mutedRoleId, warnRoleIds, mass-action limits, staffGuard, panic/lockdown.
- homeOnly keys/pages (settingsRegistry.js:226,232,286,316; homeOnly.js:13).
- Enable verification (needs an existing role); it is listed as "to do yourself".
- Native Discord AutoMod rules (D: skip).
- Overwrite admin-changed values unless "Replace" is chosen (registry: saved key, guildSettings.js:128;
  others: differs from the default).
- Break list limits: rules append/skip existing (rules.js:432), max 30 (settingsRegistry.js:52);
  templates merge by name, max 10 (templateService.js:15, cleanTemplates :62).

## UX
- Discord: "Apply a starting preset" button on the /setup reply (setupGuide.js:147) → select preset →
  fill-only (D) / replace → ephemeral preview (will change / skipped, already set / to do yourself) →
  Confirm. safeDefer each step; customId `spreset:<step>:<userId>:<nonce>`; bounded TTL panel state.
  Viewing stays Manage Server; apply/undo need Administrator, re-checked every interaction
  (serverScope.js:26-35). Texts via textForInteraction/botText keys.
- Dashboard: "Starting presets" card on Setup (routes.js:1273), module `presets` (apply, undo), both
  adminOnlyActions + action.confirm; confirm token (routes.js:1146-1160), CSRF/Origin (:1128, :709),
  audit + mod-log (recordDashboardChange :1182, audit.js:101). Not in MANAGER_PAGES (permissions.js:240).

## Data / safety
- Definitions: `src/config/setupPresets.js` (pure, no ids). Service: `src/services/setup/presetService.js`
  with `planPreset({client, guildId, key, mode})` (validates with each place's own validator),
  `applyPlan(plan, actor)` (ordered writes, reverse-order restore on failure, registry parts in one
  updateSettings), a per-guild busy set (structureBackupService.js:53-57 pattern), `undoLastPreset`.
- Audit: the Discord path writes `createAuditStore().writeRows(..., 'preset', changes)` + logEvent moderation.config.
- Undo: KV key `setupPreset:last:<guildId>` holding at, actor, key and a before/after list per step; last
  apply only, 30 days; restores only values still equal to what the preset wrote. No schema change.
  (settingsBackup.js is home-only and registry-only, so not reusable.)

## Files / tests / agents
Add: config/setupPresets.js, services/setup/presetService.js, interactions/buttons/setupPreset.js,
interactions/selectMenus/setup/setupPreset.js, dashboard/modules/presets.js, texts x8 (bot + dashboard).
Change: setupGuide.js, serverRules.js (pure addLibraryRules next to addRule :142, used by rules.js:427-445),
dashboard modules/index.js, permissions.js, helpPages.js.
Tests: definitions pass every validator; keys exist; no homeOnly/ids/create services; fill-only vs replace;
limits at 29 rules / 9 templates; failure at step k restores 1..k-1; undo skips edited values; busy lock;
interaction (other user refused, non-admin, expiry, defer first); dashboard (manager 403, confirm token,
audit + mod-log, non-home server, only ctx.guildId).
Agents: A1 core (definitions, service, serverRules helper, tests) → A2 Discord flow + texts, A3 dashboard
(A2/A3 stub the contract).

## Owner decisions (D = default)
1. Entry: (D) button on the /setup reply vs a `/setup preset` subcommand.
2. Mode: (D) fill-only; Replace is explicit.
3. Who applies: (D) Administrator; Manage Server can only preview.
4. Start mode: (D) enforce, friends = monitor; alternative: every preset monitor for 7 days.
5. Thresholds via presets: (D) no (they stay in code).
6. Native AutoMod: (D) untouched.
7. Undo: (D) last apply, 30 days, KV, no schema change.
8. Preset list/contents: (D) as above; rules text stays English (the library is English-only).

Unverified: [I1] leveling off for study OK; [I2] welcome enabled without a channel (not relied on);
[I3] updateGuildConfigAtomic throws without saving; [I4] a few-KB KV value per guild is fine for B5 growth;
[I5] modules/index.js entry + button directory format.
