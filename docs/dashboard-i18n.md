# Dashboard translations

The web dashboard (`/dashboard`) is shown in the same 8 languages as the website: en, ru, de, fr, it,
pl, es, pt-BR. It uses the website's i18n core (`src/services/site/i18n.js`) with its **own catalog**.

## What is translated now (the frame)

- Page shell: title, skip link, top bar, breadcrumbs, search box, language picker, theme menu,
  sidebar groups and items, phone tab bar and "More" sheet, account menu, "Unsaved changes" marks.
- Shared form parts (`forms.js`): Save / Reset, pickers, field errors, on/off pills.
- Overview, the Commands page, and every error / message page (`messagePage`, `fail` in `routes.js`).
- The words the static script shows (`frame.script.*`: Copy, Cancel, Saving…, relative times),
  handed to it as JSON in `<body data-ui-text>` (non-English pages only; no inline script).

Module pages (Welcome, Automod, Cases, Owner pages …) still show their own English text inside the
translated frame. That is expected until their wave is done.

## Where things live

| What | Where |
| --- | --- |
| Text | `src/content/dashboard/<lang>/<namespace>.json` (nested JSON, key `frame.nav.label` = `frame.json` → `nav.label`) |
| Catalog + markup | `site/i18n.js`: `DASHBOARD_CATALOG`, `translator(lang, { catalog: 'dashboard' })` |
| Request language, translator | `dashboard/language.js`: `dashboardLanguage(req, userId)`, `dashboardText(lang)`, `textFor(ctx)` |
| Escaping core | `dashboard/safeHtml.js` (`html`, `raw`, `escapeHtml`; re-exported by `html.js`) |
| Tests | `tests/dashboardI18n.test.js` |

The dashboard catalog takes **no owner edits** (Owner → Website edits only the website catalog).

## Which language a request gets

1. The `mewvo_lang` cookie (Path=/, shared with the website; either picker sets it).
2. The Discord account's language (`locale` from the login's `identify` call; kept in memory only).
3. The browser's `Accept-Language`.
4. English.

Nothing ever redirects because of a language. The picker is a plain link to
`GET /dashboard/lang?code=de&next=/dashboard/…`: it sets the cookie (only for one of the 8 codes) and
goes back with `safeBackPath` (dashboard paths only). Every value from a cookie, header or Discord is
matched against `LANG_CODES` before use.

## Using the translator

- Pages: `ctx` (module pages) carries `t / ti / tb / tp / tpi / tx / fmtNumber / fmtDate / fmtDateTime / weekday / has`;
  shell functions get `session.lang` / `lang`. Helpers without a context call `currentText()` (the
  request's language from an AsyncLocalStorage; English outside a request, e.g. in tests).
- `t(key, params)` plain text (escaped by `html```), `ti` inline markup (`**bold**`, `` `code` ``, `[text](/path)`),
  `tb` blocks, `tp(key, count)` plurals (`key.one`, `key.few`, `key.other` … per CLDR), `tx` a text node that keeps
  the catalog's quotes as typed. Params are always escaped unless they are `html```/`raw` (SafeHtml).
- English output must stay byte-for-byte what it was: English numbers stay ungrouped (`12345`) and dates
  stay `2026-10-27 14:03 UTC`; other languages get `Intl` formats.
- CSS words (`::after { content }`) come from `data-*` attributes on non-English pages (`unsavedAttr()`, `data-in-use`).

## Translating a module page (later waves)

1. Create `src/content/dashboard/<lang>/<namespace>.json` for **all 8 languages**. The namespace is
   `namespaceOf(module.key)` (`reaction-roles` → `reactionRoles`, `owner/home` → `ownerHome`).
2. Put the page's help line at `<namespace>.page.help`: `moduleSettingsPage` picks it up automatically.
3. Replace the module's English strings with `ctx.t('<namespace>.…')` (or `textFor(ctx)` in helpers).
   Action messages (`result.message`, `InputError`) use the same `ctx`.
4. Add the module file to the "every catalog key the frame code names exists" test list.
5. Run `npm test`: the key-parity test fails on any key missing in a language, any extra key, any
   placeholder mismatch, or a missing plural category (e.g. Russian/Polish `few` + `many`).
6. Check long words at 360–1280 px in de / pl / fr / ru (local preview only, see `scripts/dashboard-screenshots.js --serve`;
   set the `mewvo_lang` cookie in the preview's cookie middleware).

Translation style: plain, natural words a moderator would use; keep Discord / bot terms the website
already uses for that language (e.g. "Automod", "Tickets", "Join to create" stay as the site has them);
keep `{placeholders}`, `/commands` and `ENV_NAMES` untouched.
