# New-user audit (2026-11-05) — what to simplify

Read-only audit by Claude (code reading only; guesses marked [unverified]). Source for the simplification wave.

## Why posting seems limited to one channel
- The channel picker (`src/services/dashboard/forms.js:283-293`) lists every channel but marks none; the
  permission warning only shows for an already-selected channel, so a refusal comes after submitting.
- Server-side refusals: Messages page (`modules/messages.js:39-43`; plain text still demands Embed Links at
  `:93`), `botMessageService.js:115-121`, rules post (`rules/rulesPost.js:187,212`), ticket/verification/
  reaction-role panels, `/embedbuilder`, `/logging channel` (refuses announcement channels).
- One fixed channel, no picker: Owner → Announce (`ownerRoutes.js:350-357,961-969`: alerts → mod log →
  logging), staff posts (`channelRouting.js:36-41`), image uploads only via the audit log channel
  (`modules/welcome.js:136-150`, `welcomeImageStore.js`).
- Likely cause [unverified]: Mewvo's role lacks Send Messages/Embed Links in most channels; #automod-logs has an
  explicit allow. A "Fix permissions" button would use `channel.permissionOverwrites.edit(...)` (pattern at
  `channelToolsService.js:109`) — needs Manage Channels + Manage Roles and can only grant what Mewvo has.

## Confirmations to replace with Confirm / Cancel
Ticket "Type DELETE" modal (`ticket_dashboard.js:853-888`); void tick (`enforcementPages.js:414-416`,
`enforcementRoutes.js:731`); bulk void tick (`pages.js:101-104`, `enforcementRoutes.js:810`); purge tick + dialog
(`modules/channels.js:42,65`); applications delete tick (`modules/applications.js:163`); owner ticks
(`ownerRoutes.js:731,938,997,1153`, `ownerPages.js:152,402,428`, `ownerErasePages.js:47`); bulk ban double confirm
(`enforcementPages.js:239`); "Type the new … in chat" (`JoinToCreate/modules/config_setup.js:192,270,353`); DM
wizard "Type skip" (`configWizard.js:198`); End poll needs a pasted link (`messages.js:309`); typed user IDs
(`enforcementPages.js:512,513,584,602`, `tickets.js:56`, `channels.js`, `logging.js:70`).
Model to copy: appeal confirm page (`enforcementPages.js:468-486`, one-time token `confirmTokens.js`).

## Jargon → plain words
Void → "Remove case (a mistake, it stops counting)" / "Removed"; Revoked → "Lifted early"; Ladder level →
"Warning stage 1 of 3 (7-day ban)"; Unappealable → "Can they appeal? Yes/No"; Precedent → "What staff usually
gave for this reason"; Standing / My standing → "Record so far" / "My record"; Probation → "Extra-watch period
after a ban"; Heads-up first → "Warn privately first (2 min to fix)"; Second chance → "Friendly notice for a first
small offence"; Watch only / monitor → one term "Report only (don't delete)"; No-contact → "Keep apart";
Mass-action guard → "Safety limit: too many bans or kicks in 10 minutes"; Show diff → "Show what changed".
Add all of them to "Words explained" (`helpPages.js:8-50`).

## Where a new owner gets stuck
Checklist (`overview.js:108-122`) lacks Mewvo's permissions, Moderator role, main log channel, appeal panel; shows
"Banned role in the support server" even without one. Setup wizard only links to pages (`helpPages.js:73-90`).
Silent no-ops when mod log/alerts aren't set (`enforcementService.js:196,211`, `alertPost.js:19-21`). Errors give
no fix steps (`forms.js:212`). Admin refusal links a hard-coded main-server channel (`commandGate.js:27-30`,
`settingsRegistry.js:125`). "Administrator permission in the main server" texts (`messages.js:296`, `channels.js:36`).

## Top 20 (effort)
1 mark bad channels in pickers (S) · 2 "Fix permissions" button (M) · 3 Mewvo-permissions card + first setup step (S)
· 4 Announce picks a channel (S) · 5 rename Void/Revoked (S) · 6 void → confirm page (M) · 7 drop tick boxes (S)
· 8 Type DELETE → buttons (S) · 9 no Embed Links for plain text (S) · 10 allow announcement channels in slash pickers (S)
· 11 one automod mode term (S) · 12 plain ladder/standing/precedent/appealable (S) · 13 plain probation/heads-up/
second chance (S) · 14 glossary (S) · 15 checklist additions (S) · 16 inline setup wizard (M) · 17 failed mod-log/
alert posts shown on dashboard (M) · 18 admin refusal text (S) · 19 member search + open-polls list instead of typed
IDs/links (M) · 20 modals instead of typing in chat (M).
