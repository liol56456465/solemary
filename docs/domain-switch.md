# Domain switch runbook: mewvo.com

For Ramūnas to run himself. Every step that touches production (DNS, Replit, Discord Developer
Portal) is yours to do after you decide to go ahead; nothing here is automated.

**Target layout**

| Address | What | Served by |
|---|---|---|
| `https://mewvo.com` | everything: the website (all 8 languages, `/de/…` etc.), `/dashboard`, `/me`, OAuth callbacks, `/health` | Replit deployment |
| `https://www.mewvo.com` | sends GET pages to `https://mewvo.com` (step 7) | same Replit deployment |
| `https://app.mewvo.com` | optional; if you link it, it also sends GET pages to `https://mewvo.com` | same Replit deployment |
| `https://meowist--sxexx.replit.app` | old address; keeps working, after step 7 sends GET pages to `mewvo.com` | same Replit deployment |

**Why one host (`PUBLIC_URL=https://mewvo.com`) and no separate `app.mewvo.com`**

- The whole site is served by the bot app (owner decision 2026-11-04): the planned owner Website
  editor changes texts and images live (`src/services/site/i18n.js:5`), so a static copy (GitHub
  Pages) would go stale. There is no static export any more.
- Every URL the bot builds comes from the `PUBLIC_URL` secret: the three OAuth redirect URIs, the
  dashboard / billing same-origin check (`src/services/dashboard/security.js:154`,
  `src/services/site/billing.js:418`), links in DMs, and the site's canonical, Open Graph,
  `hreflang` and sitemap URLs (`siteOrigin()`, `src/services/site/shell.js:74`; used in
  `shell.js:206-207` and `site.js:387`, `site.js:524-531`).
- Login and language cookies have no `Domain` attribute, so they belong to exactly one host
  (`security.js:134-139`, `src/services/site/language.js:79-81`). With site and dashboard on the same host, a login and a chosen
  language are seen everywhere on the site; with two hosts they would not be.
- `CANONICAL_REDIRECT=true` (`src/utils/canonicalHost.js`) sends **every** other host that reaches
  the deployment (`www.mewvo.com`, `app.mewvo.com`, the replit address) to the same path on
  `PUBLIC_URL`. So `www` and `app` need no code or extra setting: link them in Replit and the
  redirect does the rest. `app.mewvo.com` is only worth linking if it was ever shared; otherwise
  skip it (steps marked *optional*).

So the switch is: link `mewvo.com` (+ `www`) to the deployment, register the new callbacks in
Discord, change `PUBLIC_URL`, test, then turn on `CANONICAL_REDIRECT`.

---

## 0. Before you start

- [ ] The domain is bought and you can edit its DNS records at the registrar.
- [ ] The code with `src/utils/canonicalHost.js` is merged into the branch Replit deploys (it is
      off by default, so deploying it changes nothing until `CANONICAL_REDIRECT=true`).
- [ ] Note the current values you will roll back to: `PUBLIC_URL=https://meowist--sxexx.replit.app`,
      `CANONICAL_REDIRECT` unset/`false`.
- [ ] Lower the TTL of any existing `mewvo.com` records at the registrar to 300 s a day ahead, if
      the registrar allows it (faster rollback). Remove registrar parking records on `@` and `www`.

**Check:** `curl -sS https://meowist--sxexx.replit.app/health` → `{"status":"healthy",…}`.

## 1. mewvo.com → Replit

Replit links one hostname per custom domain entry, so `mewvo.com` and `www.mewvo.com` are two
entries.

1. Replit → the deployment → Settings → Custom domains (Link a domain) → `mewvo.com`.
2. Replit shows the DNS records to create (usually an A record and a TXT verification record).
   **Copy exactly what Replit shows** — don't use values from anywhere else.
3. Add them at the registrar for the apex (`@`).

**Check:** Replit shows `mewvo.com` as verified/linked (can take minutes to hours), then
`curl -sS https://mewvo.com/health` → `{"status":"healthy",…}` with a valid certificate (no `-k`).
At this point both hosts serve the same app; `PUBLIC_URL` still says the replit address.

## 2. www.mewvo.com (and optionally app.mewvo.com) → Replit

1. Same place, Link a domain → `www.mewvo.com`; copy the records Replit shows, for the name `www`.
2. *Optional:* the same for `app.mewvo.com` (name `app`), only if that address was ever shared.

**Check:** both show as verified; `curl -sS https://www.mewvo.com/health` → JSON with a valid
certificate (and the same for `app.mewvo.com` if linked).

## 3. Discord Developer Portal: ADD the new redirects

Developer Portal → application `1531096173786566697` → OAuth2 → Redirects. **Add** (keep the
three `https://meowist--sxexx.replit.app/...` entries until step 8 is done):

- `https://mewvo.com/oauth/callback` — Verify with Discord (`src/services/oauthVerification.js:43`)
- `https://mewvo.com/dashboard/oauth/callback` — dashboard login (`src/services/dashboard/routes.js:177`)
- `https://mewvo.com/me/callback` — My record / Mewvo accounts (`src/services/site/memberPortal.js:133`)

These are the only three redirect URIs built in the code (grep for `redirect_uri`). No `www` or
`app` entries: logins always start and end on `PUBLIC_URL`. Save.

**Check:** the portal lists six redirects (three old, three new).

## 4. Change PUBLIC_URL

Replit deployment secrets: `PUBLIC_URL=https://mewvo.com` (no trailing slash, no `www`). Leave
`CANONICAL_REDIRECT` unset/`false`. Republish.

**Check:**

- Deployment log shows `Dashboard enabled at /dashboard (OAuth redirect https://mewvo.com/dashboard/oauth/callback; …)`
  and, if the member portal is on, `Member portal enabled at /me (OAuth redirect https://mewvo.com/me/callback…)`.
- No line `Canonical host redirect ON` yet.
- If the site is public (`PUBLIC_SITE_ENABLED=true`):
  `curl -sS https://mewvo.com/sitemap.xml | head` → URLs start with `https://mewvo.com/`, and
  `curl -sS https://mewvo.com/de/ | grep -o 'hreflang="[a-zx-]*" href="[^"]*"' | head -3` →
  `href="https://mewvo.com/…"`.

What changes for people right now:

- **Dashboard and /me sessions are host-bound.** Cookies are set without a `Domain` attribute
  (`src/services/dashboard/security.js:134-139`: `Path`, `HttpOnly`, `SameSite=Lax`, `Secure`
  when HTTPS/production — `routes.js:179`, `memberPortal.js:136`; paths `/dashboard`
  (`routes.js:262`) and `/me` (`memberPortal.js:369`)). So a login on the replit host is not seen on
  mewvo.com: **staff log in once again on the new host.** A chosen site language is also per host
  (visitors pick it once more). Nothing to migrate.
- **Forms on the old host stop working**: every dashboard / billing POST checks that the Origin is
  the `PUBLIC_URL` origin (`security.js:154`, `billing.js:418`). Staff still sitting on the replit
  host get "security token or origin mismatch" on save → tell them to use mewvo.com.
- **Logins started on the old host fail** until step 6: the OAuth state cookie is set on the
  replit host, but Discord sends the browser back to mewvo.com. Test on mewvo.com directly,
  and do step 6 soon after.
- **DMs already sent keep working**: their links point at the replit host, which keeps serving
  the same app (and after step 6 forwards GET pages to mewvo.com).
- A "Verify with Discord" link opened in the 10 minutes around the republish can fail once
  (it was built with the old redirect URI); clicking Verify again makes a fresh one.

## 5. Smoke test on the new host (before the redirect)

Use an alt account where it says so. Expected result per step:

1. `https://mewvo.com/` → the website home page; `https://mewvo.com/de/` → the German home page.
2. `https://mewvo.com/dashboard` → Login with Discord → back on `/dashboard/overview`, logged in.
3. Change one harmless setting in the dashboard and save → "saved", entry in the audit log.
4. Website editor (once it exists): change one text, save, reload `https://mewvo.com/` → the new text shows. Change it back.
5. Log out → back to the website.
6. `https://mewvo.com/me` (if `MEMBER_PORTAL_ENABLED=true`) → log in with the alt → own record shows.
7. Verify button in the server (if OAuth verification is on), alt account → Discord authorize →
   success page/redirect, alt gets the verified role.
8. `/test action user` on yourself → DM preview; if it contains a web link (rules page, My record), it starts with `https://mewvo.com`.
9. `/support` → the Privacy Policy / Terms links start with `https://mewvo.com` (`src/commands/Core/support.js:12-14`).

## 6. Turn on the canonical redirect

Only after step 5 passed. Replit secret `CANONICAL_REDIRECT=true`, republish.

**Check:**

- Log line `Canonical host redirect ON: GET/HEAD on other hosts → https://mewvo.com`.
- `curl -sSI 'https://www.mewvo.com/leaderboard?page=2'` → `301`,
  `location: https://mewvo.com/leaderboard?page=2`, `cache-control: private, max-age=3600`.
- `curl -sSI 'https://meowist--sxexx.replit.app/de/'` → `301`, `location: https://mewvo.com/de/`.
- (if linked) `curl -sSI https://app.mewvo.com/dashboard` → `301`, `location: https://mewvo.com/dashboard`.
- `curl -sS https://meowist--sxexx.replit.app/health` → JSON, **no** redirect (health checks stay put).
- `curl -sSI 'https://meowist--sxexx.replit.app/dashboard/oauth/callback'` → not a 301 (callbacks are exempt).
- `curl -sSI https://mewvo.com/` → `200`, no redirect loop.

What the redirect does (`src/utils/canonicalHost.js`): only GET/HEAD, only when the request host is
not the `PUBLIC_URL` host; POST/other methods, `/health`, `/ready`, `/oauth/callback`,
`/dashboard/oauth/callback`, `/me/callback`, localhost and `NODE_ENV=test` are never redirected.
The target is always `PUBLIC_URL`'s origin + the same path and query (never taken from
`Host`/`X-Forwarded-Host`; paths like `//evil.com` are not redirected). The 301 may be cached by
browsers for 1 hour only, so a rollback takes effect within an hour.

## 7. Email (Resend) — only when email sending exists

This branch has **no** email code (no Resend, no `EMAIL_FROM`; grep finds nothing). When it is added:
Resend → Domains → add `mewvo.com` (or a subdomain such as `mail.mewvo.com`), create **exactly the
DNS records Resend shows** (SPF/DKIM/MX/DMARC), wait for "Verified", then set
`EMAIL_FROM=…@mewvo.com` in the deployment secrets and republish. Check: send a test mail, look at
the headers for `dkim=pass` and `spf=pass`.

## 8. Clean-up (a few days later, when nothing broke)

- Re-run `/setappeal` only if you want the panels re-posted: the appeal panels contain no
  web links (`src/commands/Enforcement/setappeal.js` builds no URL), so this is not needed for the switch.
  Links in punishment DMs (rules page, My record) follow `PUBLIC_URL` automatically for new DMs.
- Discord Developer Portal: remove the three old `https://meowist--sxexx.replit.app/...` redirects.
  After that, a login can only finish on mewvo.com (fine: `PUBLIC_URL` points there).
- Keep the replit host running (it is the deployment itself); with the redirect on, old links land on the new host.
- Update the production URL in CLAUDE.md ("Servers and IDs") to `https://mewvo.com`.

**Check:** the portal lists exactly the three `https://mewvo.com/...` redirects; a dashboard login
on `https://mewvo.com/dashboard` still works.

## Rollback

At any step:

1. Replit secrets: `PUBLIC_URL=https://meowist--sxexx.replit.app`, `CANONICAL_REDIRECT=false`
   (or remove it). Republish.
2. Keep the old redirects in the Developer Portal (that is why step 3 only adds).
3. Staff log in again on the replit host (host-bound cookies, see step 4).
4. Browsers that cached the 301 keep going to mewvo.com for up to 1 hour; that host still
   serves the same deployment, so it works — it just uses the other host's cookies, and its
   dashboard forms fail the origin check until the cache expires (use the replit address directly).
5. The custom domains in Replit and the DNS records can stay as they are.

**Check:** `curl -sSI https://meowist--sxexx.replit.app/` → `200` (no redirect), dashboard login on
the replit host works.
