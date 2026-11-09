# Language roles

A member picks a language through a role; that choice wins for messages meant for that member.

## What is built

- Setting `languageRoles` (registry, `guild_settings`, `guild: 'main'`, every server): `{ en, ru, de, fr, it, pl, es, pt-BR } → roleId`,
  each optional, one role per language (two languages on one role are refused). Dashboard → Bot language →
  **Language roles** (Administrator-only: these roles are handed to anyone who asks; each must have no staff
  permissions and sit below Mewvo's role).
- Home default (main server, production only, no data migration): the owner's roles (corrected list, 2026-11-08):
  en 1569098172578402344, ru 1569098287590670356, de 1569098415282069544, fr 1569099080125259776,
  it 1569099182042648727, pl 1569099300103786708, es 1569099459923677337, pt-BR 1569099585551601764.
- `resolveBotLanguage` (src/utils/botText.js), first step for purposes `reply`, `dm` and `member`: the member's
  language role, when the caller passes a member object. Several language roles: fixed order en, ru, de, fr, it, pl,
  es, pt-BR (Discord does not say when a role was added). No role: the old rule, unchanged.
  `public` (panels, giveaways, mod log, review cards) never looks at a role.
- `/language set` (everyone): a private select; picking one adds that role and removes the member's other language
  roles. `/language panel [channel]` (Administrator): a persistent panel with one button per language that has a role
  (native names, no flags) that does the same for whoever clicks.

## Discord Onboarding (owner, in Discord; no code)

Server Settings → Onboarding → Questions → Add a question, e.g. "Which language do you want Mewvo to use?".
Single choice. One answer per language, each giving its language role (the same roles as on the dashboard). Mark it
as not required if members may skip it. Mewvo reads the role, so Onboarding, `/language` and the panel all work
together; `/language` cleans up a second language role if a member ends up with two.

## Re-edit DMs of the last 30 days (built, schema v13; owner OK 2026-11-08)

When a member changes language, the bot DMs it sent them about that server in the last 30 days are edited
into the new language. Code: `src/services/botDm/` (`dmRenderers.js`, `dmLog.js`, `dmRelang.js`).

**Table `bot_dm_log`** (v13, additive): `id`, `guild_id`, `user_id`, `channel_id` (the DM channel), `message_id`
(unique), `template_key`, `params` (jsonb), `lang` (the language the DM is in now), `created_at`. Indexes
`(user_id, created_at desc)` and `(created_at)`.

- **Sending:** `sendLoggedDm(user, { key, params, guildId, member, components, files })` renders the template in the
  member's language (language role, else the server's), sends it with `allowedMentions: { parse: [] }` and logs it.
  Logged only for a server that has language roles, with the database up; a failed log write never undoes a
  delivered DM (that DM is just never re-edited).
- **Templates** (`dmRenderers.js`): `enf.ban|kick|mute|warn|banEnded|muteEnded|appealAccepted|appealDenied|caseVoided`,
  `ticket.closed|feedback|transcript`, `application.result`, `verification.approved|denied`, `suggestion.status`,
  `premium.gift`. Params hold only what the DM showed: the case fields the DM reads (no internal notes, no staff or
  target ids), and staff/member text (reason, note, suggestion, gift note) exactly as shown. A re-edit renders only
  our text again.
- **Trigger:** `guildMemberUpdate` when a language role was added or removed (Onboarding, staff, `/language`), and
  the `/language` handlers. Debounced 60 s per server + member (two changes within a minute: one run, final
  language); a newer change stops a run at its next DM.
- **Run:** at most 50 DMs (newest first, only those not in that language yet), one edit every 1.5 s for the whole
  bot, one run at a time. A deleted DM or DM channel (10008/10003) loses its row; an answered feedback survey (its
  buttons gone) is not put back and loses its row. Components are replaced only when the template renders them
  (the feedback buttons); attachments and embed timestamps stay. The member gets no new DM. Current settings apply
  on a re-edit (appeal invite, PUBLIC_URL links), as they would for a new DM.
- **Retention:** rows older than 30 days go in the daily retention job (`privacy/retentionService.js`, rule
  `bot_dm_log`). `/wipedata` deletes the member's rows (all servers).

## Personal language without a role (audit 4.6, 2026-11-09)

- `/language set` lists all 8 languages. One with a role here works as above; one without a role (or any pick in
  a server without language roles) is saved as the member's **personal language**: key-value key
  `user:<id>:lang` (no schema change), one value per Discord account, for every server. The member's language
  roles in that server are removed then (a role would keep winning there); if Mewvo can't remove them the
  choice is still saved and the answer says the role still applies there. "Clear my personal language" removes it.
- Also on the website: My record → Account settings → "Language of Mewvo's DMs" (POST `/me/account/language`).
- Order: language role > personal language > Discord locale (private answers) / server language (DMs). Public
  posts and posts for one member in a channel never use it.
- In memory: loaded at startup (`loadPersonalLanguages`), written through. A failed load: DMs use the server
  language, one warning, a retry at most once a minute. Reads for the settings page and the export throw.
- DM re-edit: DMs to a member with a personal language are logged too (also without language roles); a change
  re-edits their DMs of every server in `bot_dm_log` plus the current one (`schedulePersonalRelang`). The "Contest
  this" button is not re-rendered on a re-edit (it stays in the language it was sent in).
- Privacy: in the data export (`personalLanguage`), deleted by `/wipedata` (item `language`), on the privacy page.
