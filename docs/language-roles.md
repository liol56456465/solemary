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

## Proposal (not built): re-edit DMs of the last 30 days

When a member changes language, the bot DMs it sent them in the last 30 days are edited into the new language.
This needs a DM log = a **schema change** (needs the owner's OK and `/schema-change`).

**Table `bot_dm_log`** (schema v13):

| column | type | note |
| --- | --- | --- |
| `id` | bigserial PK | |
| `guild_id` | text not null | the server the DM is about |
| `user_id` | text not null | recipient |
| `channel_id` | text not null | the DM channel |
| `message_id` | text not null unique | |
| `kind` | text not null | template name: `ban`, `kick`, `mute`, `warn`, `unban`, `unmute`, `caseVoided`, `appealAccepted`, `appealDenied`, … |
| `params` | jsonb not null | what the template needs to re-render (case code, reason key, times, invite) — no free-text secrets; a custom reason is stored as given to the DM already |
| `lang` | text not null | language it was sent in |
| `sent_at` | timestamptz not null default now() | |

Index `(guild_id, user_id, sent_at desc)`.

**Retention:** rows older than 30 days are deleted by the existing once-a-minute expiry cron (batched delete,
`WHERE sent_at < now() - interval '30 days'`); also covered by `/wipedata` and the privacy export.

**What gets re-edited:** only DMs from a template the bot can render again in another language (enforcement DMs,
appeal results, ticket/modmail system notices). Never: messages with staff-written text other than the reason,
messages older than 30 days, messages whose invite has expired (the invite stays the same link, it is not renewed).
Edits run in the background with a rate limit (Discord: ~5 edits/5 s per channel) after a language switch; a failed
edit (DM closed, message deleted) is skipped and logged at debug level. The member gets no new DM.

**Open questions for the owner:** keep 30 days? Store `params` (more data at rest) or only re-edit what can be
rebuilt from `mod_cases` by case code (less data, fewer DM kinds)?
