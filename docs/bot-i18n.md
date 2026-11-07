# Bot translations

The bot's own messages (DMs, replies, posts) can be shown in the same 8 languages as the website and
dashboard: en, ru, de, fr, it, pl, es, pt-BR. They use the website's i18n core
(`src/services/site/i18n.js`) with their **own catalog**: `src/content/bot/<lang>/<namespace>.json`.

## Which language a message gets (owner's "mixed" rule)

| Message | Language | `purpose` |
| --- | --- | --- |
| Ephemeral / private answer to the person who ran the command | that person's Discord language (`interaction.locale`) | `'reply'` |
| DM to a member (punishment, unban/unmute, appeal result, case removed) | the server's language | `'dm'` |
| Public post in a channel (also a prefix-command reply) | the server's language | `'public'` |

- Discord locales: `en-US`/`en-GB` → en, `pt-BR` → pt-BR, `es-ES`/`es-419` → es, others by prefix. Anything else → English.
- Server language: setting `botLanguage` (registry, `guild_settings`), Dashboard → Bot → **Bot language**. Default English.
- If the setting cannot be read (database down), the message is English and one warning is logged. This is the
  only read that falls back to a default on error (the language is cosmetic; a DM must still go out).
- **One function decides:** `resolveBotLanguage({ guildId, member, userId, interaction, purpose })` in
  `src/utils/botText.js`. A later member preference (e.g. a language role) goes in there only. Always pass
  `member` or `userId` when you have them, so call sites don't change then.

## API (`src/utils/botText.js`)

```js
import { textForInteraction, textForGuild, resolveBotLanguage, botText } from '../../utils/botText.js';

const tr = textForInteraction(interaction);              // ephemeral reply: the user's language
const tr = textForInteraction(interaction, { purpose: 'public' }); // a public reply: the server's
const tr = textForGuild(guild.id, { userId });           // DM to a member: the server's language
tr.t('ns.key', { name })                                 // plain text, {params} filled in
tr.tp('ns.key', count, { name })                         // plurals: ns.key.one / few / many / other
tr.lang                                                  // 'de', … (pass it on as { lang })
```

Shared builders take the language as `{ lang }` (last argument), never a translator, and default to
English: `banDm(record, { lang })`, `buildUserErrorEmbed(type, text, { lang })`,
`getUserMessage(error, { lang })`, `getAdminRequiredMessage(guildId, { lang })`.

## Translated now

- Enforcement DMs (`src/services/enforcement/dmTemplates.js`): ban, kick, mute, warn, ban/mute ended
  (unban/unmute), case removed, appeal accepted/denied, durations (`durationIn`). `/test action` previews use
  the server language too (what the member would get). Keep-apart DMs and the "Contest this" button: still English.
- `/setup` (namespace `setup`, reply language) and the join welcome post and DM (`setup.welcome.*`, the server's
  language; a new server is English until it picks one).
- Error replies (`errorHandler.js` built-in messages, `embeds.js` error titles) and the Administrator and
  Manage Server refusals (`commandGate.js`). A custom `userMessage` written in code is still shown as written (English).

## Translating a command (the later sweep)

1. Pick a namespace (usually the command name, e.g. `rank`). Create `src/content/bot/<lang>/rank.json` in
   **all 8 languages** (nested JSON: key `rank.card.title` = `rank.json` → `card` → `title`).
2. Put the English text in `en/` **exactly** as the code has it today (byte for byte, including `**`, emoji,
   `\n`). Replace each `${value}` with a `{name}` placeholder.
3. In the command: `const tr = textForInteraction(interaction)` (ephemeral) or
   `textForGuild(interaction.guildId, { member: interaction.member, purpose: 'public' })` (posted in the channel),
   then `tr.t('rank.card.title', { name })`. Pass `{ lang: tr.lang }` to shared helpers.
4. Plurals: `key.one` + `key.other` in English; ru/pl need `few` + `many`; fr/it/es/pt-BR need `many`
   (`Intl.PluralRules(lang).resolvedOptions().pluralCategories`). Use `tr.tp(key, count)`.
   Don't name a non-plural key `one/few/many/other/zero/two` (the parity test reads it as a plural).
5. Keep untouched: `{placeholders}`, `/commands`, case codes, Discord markup (`<t:…:F>`, `<#id>`, `<@id>`,
   `**bold**`, `-#`), URLs. Text values from users are never re-read as placeholders.
6. Run `npm test`. `tests/botI18n.test.js` fails on a missing or extra key, a placeholder mismatch or a
   missing plural form. Add an "English unchanged" assert for the command's main output.

Style: plain, natural words a moderator would use; the website's terms for that language (e.g. de
"Einspruch", "Fallcode"; ru "апелляция", "бан"); German/French use "du"/"tu", Russian "вы", like the site.
Watch Discord limits: content 2000, embed title 256, field 1024, description 4096 (translations run longer).
