# Multi-server B3 — web dashboard per server (plan, 2026-11-08)

Written from a read-only pass over `feature/dashboard-members` at 4ddebc9. Not built yet; waiting on the owner's
decisions (section 7). Assumptions not verified yet are marked [I#].

## 0. Core design: one guild-bound dashboard instance per server
- `createDashboard` today binds `const guildId = settings.mainGuildId` (routes.js:272) and passes it into every handler
  factory (enforcement, memberTools, inbox, incidents, permissionFix, owner; routes.js:973-995).
- Make `guildId` a parameter (default `settings.mainGuildId`). New `guildDashboards.js` builds and caches one instance
  per server (bounded LRU: 500 instances, 2 h idle). Sessions, OAuth states, rate limiters, audit store, member
  search and static files are shared. The static file reads at routes.js:373-381 move to module scope.
- Why: IDOR-safe by construction; the ~14 tests calling `createDashboard()` keep working; `moduleStatesCache`
  (routes.js:280) is no longer shared between servers; the big files stay almost untouched.
- The confirm-token store must be scoped: each instance prefixes subjects with `${guildId}:`, so a preview from
  server A can't be confirmed in server B.

## 1. Routes and URLs
- Global (never bound to a server): `/dashboard/static/*`, `/theme`, `/lang`, `/nav`, `/oauth/callback`, `/logout`,
  `/owner/*` (bot-wide, OWNER_IDS), and `/dashboard` = server picker when logged in, else login.
- Per server: `/dashboard/:guildId/...`; `:guildId` must pass `isSnowflake` (security.js:17), checked in middleware
  (Express 5 has no inline regex) [I2: `router.use('/:guildId')` strips the prefix and `req.path` is the suffix that
  `routeKey` expects].
- Support id: `/dashboard/<supportId>/*` → 302 to `/dashboard/<mainId>/*` (home servers count as one).
- Old links (first segment neither a reserved global word nor a snowflake): GET/HEAD 302, POST 307 to
  `/dashboard/<MAIN_GUILD_ID>/<rest>?<query>`. Use 302 for the first release so it can be rolled back.
- `path()` (html.js:73) reads the current guild from an AsyncLocalStorage set by the guild middleware (like
  language.js:121-137). Add `rootPath()` for global routes and `guildPath(id, suffix)`. Global links to switch:
  theme/nav/lang (html.js:236, 312), logout, OWNER_NAV (html.js:151, 186). [I1] Test that a POST's 303 `Location`
  keeps the guild prefix.
- `safeBackPath` (routes.js:221) already accepts `/dashboard/<digits>/…`; add a test.

## 2. Auth and session
- Scope `identify guilds` (routes.js:419). The callback (routes.js:431-476) calls `GET /users/@me/guilds` once
  with the same token, then drops the token as today. No OAuth token is stored.
- Any Discord user may log in; the refusal for users without main-server access (routes.js:463-467) goes.
  `createState` (security.js:48) carries a return path `r`, checked with `safeBackPath`; default = picker.
- Guild list cache: in memory, keyed by `session.idHash`, bounded (5,000), expires with the session (12 h). Holds
  only ids, names and icons of servers shared with the bot or managed by the user. No schema change. After a restart
  the picker shows "Refresh server list" (OAuth again with `prompt=none` [I3]). Direct `/dashboard/<id>` links
  work without the list, because access is checked live through the bot.
- Picker: shared servers (each re-checked live; ≤50 checks, 5 at a time, through the access cache); "Add Mewvo"
  for servers where the OAuth `permissions` show Manage Server or Administrator but the bot is absent (`installUrl`,
  shell.js:52, + `guild_id=…&disable_guild_select=true`); home servers for OWNER_IDS.
- Guild middleware, per request: session (else login with return path) → snowflake → bot is in the guild → server
  not blacklisted (`blacklistHit`, blacklistCache.js:48; blacklisted user = 403) → live access (`memberFacts`,
  `force: true`, access.js:59). Failures in steps 2-5 give one uniform 404 ("Server not found or you can't manage it").
- Losing access to one server must not log the user out: `requireUser` (routes.js:488-492) no longer destroys the
  session; it 404s that server only. POSTs: `access.forget(userId)` + fresh check.
- Access levels (access.js:24-44 `decideAccess`): admin = Administrator (unchanged); new `manager` = Manage Server
  without Administrator (`canView: true, canAct: false`; settings yes, moderation actions no); `owner` only when
  `hasOwnerPower(userId, guildId)` (ownerPower.js:24); `moderator` = the server's own `modRole`.
  `memberFacts` adds `isManager`. permissions.js:218 `allows()`: managers pass page and `settings.edit` keys;
  `levelLabel` (:236) gets "Manage Server".

## 3. Places to change (file:line)
- Routing/auth: routes.js:263, :272 (`guildId` parameter), :413-476 (scope, guild list, return path, no login
  refusal), :478-512 (no session destroy, 404, fresh check on POST, `req.dashboard.guildId`), :528, :538
  (`getConfiguredSetting` → `resolveSetting(guildId, …)`), :1130-1147 (`registerDashboard` builds the registry),
  :1149-1297 (split into `globalRouter` and `guildRouter`; `'/'` (:1159) becomes the picker); html.js:56/73
  (`path`/`rootPath`/`guildPath`), :151, :186 (owner nav uses root links), :318-328 (`serverSwitch` becomes a real
  switcher; change the `frame.server.note` text); security.js:48-80 (return path in the state). New files:
  `guildDashboards.js`, `serverPicker.js`.
- Access: access.js:24-75; permissions.js:218-240.
- Leftover OWNER_IDS checks: enforcementRoutes.js:214 → `e.hasOwnerPower(userId, guildId) || guild owner`; :657 →
  `e.hasOwnerPower(…, guildId)`; :991, :1041 → `isOwner: (id) => e.hasOwnerPower(id, record.guild_id)` (also the
  default in `checkAppealReviewer`, appealReviewer.js:48); enforcementData.js:31, :50 export `hasOwnerPower`;
  enforcementRoutes.js:661 `enforcementConfig.massActionLimit` → `resolveSetting(guildId, 'massActionLimit')`.
  Keep: `isBotOwner` at routes.js:316, :326 (bot-wide Owner area).
- Settings: guildSettings.js:360-363 `updateSettings` refuses non-home servers → allow any guild with role
  `'other'` (only `guild:'main'` keys without `homeOnly`; `old` = `neutralValue` instead of `seedValue` (:376); read
  back via `resolveSetting` (:398)); settingsRegistry.js:485-499 `validatePatch` gets the `'other'` role; mark
  `supportServerInvite`, `premiumRoleIds`, `transparencyReportEnabled`, `trustCardEnabled` as `homeOnly: true`.
  modules/common.js:60-87 `registryGuildId(ctx, key)` (home servers keep the old mapping; others use `ctx.guildId`,
  or null for support/homeOnly keys; `registryValue` → `resolveSetting`; `saveRegistry` writes only `ctx.guildId`);
  setupForms.js:20-22; overview.js:158-163 (`setupSettings` → guildId), :501-511 (`settingsRowsFor(…, guildId)`,
  using `resolvedSource`).
- Module pages: modules/enforcement.js:22-25 gets the `appealsHome` radio ("Mewvo support" / "our own server") and
  the `appealsInvite` field (registry schema + `inviteOrNull`), other servers only; home servers see a note that it
  doesn't apply. pages.js:283 `appealsPage`: appeals with no channel (`channel_id` null) are labelled "No channel:
  decide here" and listed first (the store-only list; `listPendingAppeals`, appealService.js:410, already filters by
  guild and selects `channel_id`). The appeal detail page must not assume a channel link. modules/automod.js:560-563:
  automod off while the staff guard is on → server owner only (as in commands/Enforcement/automod.js:373, :457).
  modules/support.js, rules.js (public `/rules` link), commands.js: home-only parts (section 4).
- Bot-side links: site/shell.js:93-97 `dashboardUrlFor` → `${origin}/dashboard/${guildId}` (no guild →
  `/dashboard`); tests/multiServerB2.test.js:303; config/commands/retirement.js:59-63 `retiredMessage(accessKey,
  guildId)` via `dashboardUrlFor`; utils/commandGate.js:144 passes `guild.id`.
- Text: new `servers.json` plus additions to `frame.json`, `errors.json`, `general.json` in all 8 languages (the
  key-parity test enforces this). CLAUDE.md (dashboard scopes). Privacy page: the dashboard asks for `guilds`;
  server ids are kept in memory up to 12 h, never stored.

## 4. Home-only for now (404 in other servers, hidden from the nav; one `homeOnly.js` set)
- Support server module (support.js).
- Backup page `/backup` (settingsBackup.js backs up only home rows; see docs/multi-server-b0.md).
- Owner area `/owner/*` (global, OWNER_IDS).
- Premium roles, transparency report and trust card toggles.
- Rules: the module works per server; the "public /rules page" link shows in home servers only.
- Everything else is per server. Scale note for B5: Members `/users` does a full member fetch.

## 5. Test plan
New tests/dashboardMultiServer.test.js. Fake client with guilds A (user is admin), B (stranger), main and support;
memory sessions; spies on services.
- IDOR: loop over the whole `ROUTES` table (permissions.js:105): every GET/POST under `/dashboard/B/...` → 404 and
  no service called with B. A's case code under B (page, edit, void, evidence, notes, tags, appeal preview/decide)
  → 404, no write. A's role-rule id, inbox channel, incident id, bulk job id under B → 404. A's `/users/<id>` under
  B → 404. B's audit page lists only B rows. Bad ids (16 or 21 digits, non-digits, trailing slash, mixed case) →
  404. Bot not in server or server blacklisted → 404; blacklisted user → 403; support id → 302 to main.
- OWNER_IDS: no permission in B → 404; Administrator in B → admin there, no owner override (mass-action guard
  applies, no appeal-reviewer override). Main: owner as before.
- Permission lost mid-session in B → B 404s, A still works, session kept. Manager: settings OK; `canAct` actions and
  `admin` module actions → 403. A POST re-checks access even when the cache is fresh.
- CSRF/Origin per server route: missing, wrong or other-session token → 403; missing or foreign Origin → 403; same
  for the 307 legacy POST. Tampered login return path (absolute URL, `//evil`, `..`) → picker.
- Cross-server form posts: A's channel/role id posted to B's module → 400 (forms.js:143, :159). `saveRegistry` in B
  calls `updateSettings` only with B's id. homeOnly keys refused for B. `appealsHome`: bad invite rejected, `'own'`
  without invite allowed. Automod off by a non-owner while the staff guard is on → refused. A's confirm token
  replayed in B → refused. `dashboardUrlFor`/`retiredMessage` produce `/dashboard/<id>`.
- test:db: `updateSettings` for a non-home server creates its own row and audit rows and never touches home rows.
- docs/test-script.md: new section for the owner's Discord/browser test.

## 6. Agents (worktrees) and merge order
1. A3 settings per server: guildSettings.js, settingsRegistry.js, modules/common.js, setupForms.js, overview.js.
2. A2 access levels + OWNER_IDS: access.js, permissions.js, enforcementRoutes.js, enforcementData.js, general.json ×8.
3. A1 routing + auth (B3a): routes.js, html.js, security.js, new guildDashboards.js + serverPicker.js,
   servers.json/frame.json/errors.json ×8. Contracts from the others: `decideAccess` role `'manager'`,
   `HOME_ONLY_PAGES` from homeOnly.js (A4 owns it; A1 may stub it), `registryValue(ctx, …)`.
4. A4 module pages (B3b): modules/*.js except common.js, pages.js, enforcementPages.js, homeOnly.js, module
   catalogs ×8; `admin: true` on every role- or permission-granting action (modRole, autoroles, reaction roles,
   level rewards, verification/application/birthday roles, channel lock/purge, automod trusted roles and turning
   automod off, mass-action limits); the "main server" texts in commands.json.
5. A5 links + cross-cutting tests + docs: site/shell.js, retirement.js, commandGate.js, multiServerB2 test, new
   dashboardMultiServer.test.js, privacy text, docs/test-script.md, CLAUDE.md diff proposal.
Merge A3 → A2 → A1 → A4 → A5 (A5's link changes any time; its IDOR suite last). npm test + test:db after each merge,
then discord-reviewer over the wave.

## 7. Owner decisions (recommended default in brackets)
1. What Manage Server without Administrator may do [settings pages only; every role, permission and safety setting
   and all moderation actions need Administrator; can view what Moderators can view except the watchlist and staff
   discipline].
2. "Re-checked on every request" [fresh check on every POST; GETs use a 30 s cache per (user, server), down from 60 s].
3. The server's own Moderator role opens the dashboard in other servers [yes, existing Moderator table].
4. Guild list storage [in memory + "Refresh" after a restart; no schema change].
5. Old links [302 GET / 307 POST to main, 301 in a later release; support URL redirects to main].
6. Who may log in [anyone; picker afterwards, with "Add Mewvo"].
7. Feature flag to ship B3 switched off [no flag].
8. Backup page for other servers [home-only for now].

## 8. Developer Portal and deployment secrets
- Developer Portal: no change. Redirect stays `${PUBLIC_URL}/dashboard/oauth/callback`; `guilds` is not privileged
  and is requested in the authorize URL. Existing users see the new consent line "Know what servers you're in" once.
- Deployment secrets: no new or changed secret (only if decision 7 picks a flag).
- Needs the owner's OK anyway: the privacy-page wording for the `guilds` scope, and the deploy itself.

## 9. Privacy page draft (A5, OWNER REVIEW: legal text)
The English text is in `src/services/site/pages/legal.js` (`privacyPage`), marked `<!-- OWNER REVIEW: legal text -->`:
one new table row "Dashboard server list" and one paragraph "When Mewvo is removed from a server". The legal pages
are English-only (`isEnglishOnlyPath`, site.js sitemap note), so the other 7 languages are drafts here only, for the
day the legal pages get translated. `LEGAL_UPDATED` is not bumped yet: bump it when the text is approved.

<!-- OWNER REVIEW: legal text -->
**de.** *Serverliste des Dashboards:* Wenn du dich im Dashboard anmeldest, fragt Mewvo Discord nach der Liste der
Server, in denen du bist (die Berechtigung „guilds“). Davon behält Mewvo nur ID, Name und Symbol der Server, in denen
Mewvo ist oder die du verwalten kannst. Zweck: nur die Serverauswahl. Gespeichert: nur im Arbeitsspeicher des
laufenden Servers, höchstens 12 Stunden, nie in der Datenbank; das Discord-Login-Token wird nicht behalten.
*Wenn Mewvo von einem Server entfernt wird:* Die Daten des Servers werden nicht gelöscht, sondern behalten, bis der
Server die Löschung verlangt. Der Eigentümer des Servers schreibt dazu an die Kontaktadresse oder im Support-Server
und nennt die Server-ID; Mewvo prüft das und löscht innerhalb eines Monats. Mitglieder können ihre eigenen Daten
jederzeit löschen lassen.

**es.** *Lista de servidores del panel:* Al iniciar sesión en el panel, Mewvo pide a Discord la lista de servidores en
los que estás (el permiso «guilds»). Solo guarda el ID, el nombre y el icono de los servidores donde está Mewvo o que
puedes gestionar. Uso: solo el selector de servidores. Se guarda solo en la memoria del servidor en marcha, hasta 12
horas, nunca en la base de datos; el token de inicio de sesión de Discord no se guarda.
*Si se quita Mewvo de un servidor:* los datos del servidor no se borran; se guardan hasta que el servidor pida que se
borren. El propietario del servidor lo pide por el contacto o en el servidor de soporte, con el ID del servidor; Mewvo
lo comprueba y los borra en un plazo de un mes. Los miembros pueden pedir que se borren sus propios datos en cualquier
momento.

**fr.** *Liste des serveurs du tableau de bord :* quand tu te connectes au tableau de bord, Mewvo demande à Discord la
liste des serveurs où tu es (la permission « guilds »). Mewvo n’en garde que l’ID, le nom et l’icône des serveurs où
Mewvo est présent ou que tu peux gérer. Usage : uniquement le choix du serveur. Conservée seulement dans la mémoire du
serveur en cours d’exécution, 12 heures au plus, jamais dans la base de données ; le jeton de connexion Discord n’est
pas conservé.
*Quand Mewvo est retiré d’un serveur :* les données du serveur ne sont pas supprimées ; elles sont gardées jusqu’à ce
que le serveur en demande la suppression. Le propriétaire du serveur la demande via le contact ou sur le serveur de
support, avec l’ID du serveur ; Mewvo vérifie et supprime sous un mois. Les membres peuvent faire supprimer leurs
propres données à tout moment.

**it.** *Elenco server della dashboard:* quando accedi alla dashboard, Mewvo chiede a Discord l’elenco dei server in
cui sei (il permesso “guilds”). Ne tiene solo ID, nome e icona dei server in cui c’è Mewvo o che puoi gestire. Uso:
solo la scelta del server. Conservato solo nella memoria del server in esecuzione, fino a 12 ore, mai nel database; il
token di accesso Discord non viene conservato.
*Quando Mewvo viene rimosso da un server:* i dati del server non vengono cancellati; restano finché il server non ne
chiede la cancellazione. Il proprietario del server la chiede tramite il contatto o nel server di supporto, indicando
l’ID del server; Mewvo verifica e cancella entro un mese. I membri possono far cancellare i propri dati in qualsiasi
momento.

**pl.** *Lista serwerów panelu:* gdy logujesz się do panelu, Mewvo prosi Discorda o listę serwerów, na których jesteś
(uprawnienie „guilds”). Zachowuje z niej tylko ID, nazwę i ikonę serwerów, na których jest Mewvo albo którymi możesz
zarządzać. Cel: tylko wybór serwera. Przechowywane tylko w pamięci działającego serwera, do 12 godzin, nigdy w bazie
danych; token logowania Discorda nie jest zachowywany.
*Gdy Mewvo zostanie usunięty z serwera:* dane serwera nie są usuwane; są przechowywane, dopóki serwer nie poprosi o ich
usunięcie. Właściciel serwera prosi o to przez kontakt albo na serwerze wsparcia, podając ID serwera; Mewvo to
sprawdza i usuwa dane w ciągu miesiąca. Członkowie mogą w każdej chwili poprosić o usunięcie własnych danych.

**pt-BR.** *Lista de servidores do painel:* quando você entra no painel, o Mewvo pede ao Discord a lista dos servidores
em que você está (a permissão “guilds”). Guarda só o ID, o nome e o ícone dos servidores em que o Mewvo está ou que
você pode gerenciar. Uso: só o seletor de servidores. Fica só na memória do servidor em execução, por até 12 horas,
nunca no banco de dados; o token de login do Discord não é guardado.
*Quando o Mewvo é removido de um servidor:* os dados do servidor não são apagados; ficam guardados até o servidor pedir
a exclusão. O dono do servidor pede pelo contato ou no servidor de suporte, informando o ID do servidor; o Mewvo
confere e apaga em até um mês. Os membros podem pedir a exclusão dos próprios dados a qualquer momento.

**ru.** *Список серверов панели:* при входе в панель Mewvo запрашивает у Discord список серверов, на которых вы
состоите (разрешение «guilds»). Из него сохраняются только ID, название и значок серверов, где есть Mewvo или которыми
вы можете управлять. Цель: только выбор сервера. Хранится только в памяти работающего сервера, не дольше 12 часов,
никогда в базе данных; токен входа Discord не сохраняется.
*Если Mewvo удалён с сервера:* данные сервера не удаляются, а хранятся, пока сервер не попросит их удалить. Владелец
сервера просит об этом через контакт или на сервере поддержки, указав ID сервера; Mewvo проверяет запрос и удаляет
данные в течение месяца. Участники могут в любой момент попросить удалить свои собственные данные.
