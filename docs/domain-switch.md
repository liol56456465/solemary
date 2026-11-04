# Domain switch runbook: mewvo.com + app.mewvo.com

For Ramūnas to run himself. Every step that touches production (DNS, Replit, GitHub, Discord
Developer Portal) is yours to do after you decide to go ahead; nothing here is automated.

**Target layout**

| Address | What | Served by |
|---|---|---|
| `https://mewvo.com` (+ `www`) | static website (Home, Features, Docs, Pricing, …) | GitHub Pages, built by `npm run export:site` |
| `https://app.mewvo.com` | the bot's web server: site pages that need live data, `/dashboard`, `/me`, OAuth callbacks, `/health` | Replit deployment |
| `https://meowist--sxexx.replit.app` | old address; keeps working, later sends GET pages to `app.mewvo.com` | same Replit deployment |

Every URL the bot builds comes from the `PUBLIC_URL` secret (OAuth redirect URIs, links in DMs,
the dashboard's same-origin check). So the switch is: make `app.mewvo.com` reach the deployment,
register the new callbacks in Discord, change `PUBLIC_URL`, test, then optionally turn on
`CANONICAL_REDIRECT`.

---

## 0. Before you start

- [ ] The code with `src/utils/canonicalHost.js` is merged into the branch Replit deploys (it is
      off by default, so deploying it changes nothing until `CANONICAL_REDIRECT=true`).
- [ ] Note the current values you will roll back to: `PUBLIC_URL=https://meowist--sxexx.replit.app`,
      `CANONICAL_REDIRECT` unset/`false`.
- [ ] Lower the TTL of any existing `mewvo.com` records at the registrar to 300 s a day ahead, if
      the registrar allows it (faster rollback).

**Check:** `curl -sS https://meowist--sxexx.replit.app/health` → `{"status":"healthy",…}`.

## 1. GitHub Pages: verify the domain, then add it (before DNS)

GitHub recommends verifying the domain first and adding it to the repository **before** creating
DNS records (otherwise someone else could claim it). Source:
https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site

1. GitHub → your profile Settings → Pages → "Add a domain" → `mewvo.com`. GitHub shows a TXT
   record (`_github-pages-challenge-<user>.mewvo.com`). Add it at the registrar, click Verify.
2. Build the static site **outside this repo** (the default `./Mewvo` folder is not in `.gitignore`;
   the repo is public, keep the export out of it):

   ```bash
   nvm use
   node scripts/export-site.js --out ../mewvo-site --site-url https://mewvo.com --app-url https://app.mewvo.com
   ```

   (`npm run export:site -- --out ../mewvo-site --site-url https://mewvo.com --app-url https://app.mewvo.com` is the same.)
3. Push `../mewvo-site` to its own repository (e.g. `mewvo-site`), branch `main`.
4. That repo → Settings → Pages → Source "Deploy from a branch", `main`, `/ (root)`.
   Custom domain: `mewvo.com` (the export already wrote a `CNAME` file with `mewvo.com`).

**Check:** `cat ../mewvo-site/CNAME` → `mewvo.com`; links to bot pages point to app.mewvo.com:
`grep -o 'href="https://app.mewvo.com/[a-z]*' ../mewvo-site/index.html | sort -u`.

## 2. DNS for mewvo.com (GitHub Pages)

At the registrar, for the apex `mewvo.com` (`@`) — values per the GitHub docs page above (checked
2026-11-04; re-check the page when you do this):

| Type | Name | Value |
|---|---|---|
| A | @ | `185.199.108.153` |
| A | @ | `185.199.109.153` |
| A | @ | `185.199.110.153` |
| A | @ | `185.199.111.153` |
| AAAA | @ | `2606:50c0:8000::153` |
| AAAA | @ | `2606:50c0:8001::153` |
| AAAA | @ | `2606:50c0:8002::153` |
| AAAA | @ | `2606:50c0:8003::153` |
| CNAME | www | `<your-github-username>.github.io` (no repository name) |

Remove any other A/AAAA/ALIAS records on `@` (e.g. registrar parking).

**Check** (can take minutes to hours):

```bash
dig +short mewvo.com A        # the four 185.199.x.153
dig +short mewvo.com AAAA     # the four 2606:50c0:800x::153
dig +short www.mewvo.com CNAME
```

Then in the Pages settings wait for the DNS check to pass and tick **Enforce HTTPS** (the
certificate can take up to ~1 h). `curl -sSI https://mewvo.com/` → `HTTP/2 200`;
`curl -sSI http://mewvo.com/` → redirect to https.

## 3. app.mewvo.com → Replit

1. Replit → the deployment → Settings → Custom domains (Link a domain) → `app.mewvo.com`.
2. Replit shows the DNS records to create.
   **Copy exactly what Replit shows** — don't use values from anywhere else.
3. Add them at the registrar for the name `app`.

**Check:** Replit shows the domain as verified/linked, then
`curl -sS https://app.mewvo.com/health` → `{"status":"healthy",…}` with a valid certificate (no `-k`).
At this point both hosts serve the same app; `PUBLIC_URL` still says the replit address.

## 4. Discord Developer Portal: ADD the new redirects

Developer Portal → application `1531096173786566697` → OAuth2 → Redirects. **Add** (keep the
three `https://meowist--sxexx.replit.app/...` entries until step 9 is done):

- `https://app.mewvo.com/oauth/callback` — Verify with Discord (`src/services/oauthVerification.js:42`)
- `https://app.mewvo.com/dashboard/oauth/callback` — dashboard login (`src/services/dashboard/routes.js:177`)
- `https://app.mewvo.com/me/callback` — My record / Mewvo accounts (`src/services/site/memberPortal.js:131`)

These are the only three redirect URIs built in the code (grep for `redirect_uri`). Save.

**Check:** the portal lists six redirects (three old, three new).

## 5. Change PUBLIC_URL

Replit deployment secrets: `PUBLIC_URL=https://app.mewvo.com` (no trailing slash). Leave
`CANONICAL_REDIRECT` unset/`false`. Republish.

**Check:**

- Deployment log shows `Dashboard enabled at /dashboard (OAuth redirect https://app.mewvo.com/dashboard/oauth/callback; …)`
  and, if the member portal is on, `Member portal enabled at /me (OAuth redirect https://app.mewvo.com/me/callback…)`.
- No line `Canonical host redirect ON` yet.

What changes for people right now:

- **Dashboard and /me sessions are host-bound.** Cookies are set without a `Domain` attribute
  (`src/services/dashboard/security.js:135-139`: `Path`, `HttpOnly`, `SameSite=Lax`, `Secure`
  when HTTPS/production — `routes.js:179`, `memberPortal.js:134`; paths `/dashboard`
  (`routes.js:262`) and `/me` (`memberPortal.js:353`)). So a login on the replit host is not seen on
  app.mewvo.com: **staff log in once again on the new host.** Nothing to migrate.
- **Forms on the old host stop working**: every dashboard / billing POST checks that the Origin is
  the `PUBLIC_URL` origin (`security.js:154`, `billing.js:220`). Staff still sitting on the replit
  host get "security token or origin mismatch" on save → tell them to use app.mewvo.com.
- **Logins started on the old host fail** until step 7: the OAuth state cookie is set on the
  replit host, but Discord sends the browser back to app.mewvo.com. Test on app.mewvo.com directly,
  and do step 7 soon after.
- **DMs already sent keep working**: their links point at the replit host, which keeps serving
  the same app (and after step 7 forwards GET pages to app.mewvo.com).
- A "Verify with Discord" link opened in the 10 minutes around the republish can fail once
  (it was built with the old redirect URI); clicking Verify again makes a fresh one.

## 6. Smoke test on the new host (before the redirect)

Use an alt account where it says so. Expected result per step:

1. `https://app.mewvo.com/` → the website home page.
2. `https://app.mewvo.com/dashboard` → Login with Discord → back on `/dashboard/overview`, logged in.
3. Change one harmless setting in the dashboard and save → "saved", entry in the audit log.
4. Log out → back to the website.
5. `https://app.mewvo.com/me` (if `MEMBER_PORTAL_ENABLED=true`) → log in with the alt → own record shows.
6. Verify button in the server (if OAuth verification is on), alt account → Discord authorize →
   success page/redirect, alt gets the verified role.
7. `/test action user` on yourself → DM preview; if it contains a web link (rules page, My record), it starts with `https://app.mewvo.com`.
8. `https://mewvo.com/` → static site; its "Dashboard" link goes to `https://app.mewvo.com/dashboard`.

## 7. Turn on the canonical redirect

Only after step 6 passed. Replit secret `CANONICAL_REDIRECT=true`, republish.

**Check:**

- Log line `Canonical host redirect ON: GET/HEAD on other hosts → https://app.mewvo.com`.
- `curl -sSI 'https://meowist--sxexx.replit.app/leaderboard?page=2'` → `301`,
  `location: https://app.mewvo.com/leaderboard?page=2`, `cache-control: public, max-age=3600`.
- `curl -sS https://meowist--sxexx.replit.app/health` → JSON, **no** redirect (health checks stay put).
- `curl -sSI 'https://meowist--sxexx.replit.app/dashboard/oauth/callback'` → not a 301 (callbacks are exempt).
- `curl -sSI https://app.mewvo.com/` → `200`, no redirect loop.

What the redirect does (`src/utils/canonicalHost.js`): only GET/HEAD, only when the request host is
not the `PUBLIC_URL` host; POST/other methods, `/health`, `/ready`, `/oauth/callback`,
`/dashboard/oauth/callback`, `/me/callback`, localhost and `NODE_ENV=test` are never redirected.
The target is always `PUBLIC_URL`'s origin + the same path and query (never taken from
`Host`/`X-Forwarded-Host`; paths like `//evil.com` are not redirected). The 301 may be cached by
browsers for 1 hour only, so a rollback takes effect within an hour.

## 8. Email (Resend) — only when email sending exists

This branch has **no** email code (no Resend, no `EMAIL_FROM`; grep finds nothing). When it is added:
Resend → Domains → add `mewvo.com` (or a subdomain such as `mail.mewvo.com`), create **exactly the
DNS records Resend shows** (SPF/DKIM/MX/DMARC), wait for "Verified", then set
`EMAIL_FROM=…@mewvo.com` in the deployment secrets and republish. Check: send a test mail, look at
the headers for `dkim=pass` and `spf=pass`.

## 9. Clean-up (a few days later, when nothing broke)

- Re-run `/setappeal` only if you want the panels re-posted: the appeal panels contain no
  web links (`src/commands/Enforcement/setappeal.js` builds no URL), so this is not needed for the switch.
  Links in punishment DMs (rules page, My record) follow `PUBLIC_URL` automatically for new DMs.
- Discord Developer Portal: remove the three old `https://meowist--sxexx.replit.app/...` redirects.
  After that, a login can only finish on app.mewvo.com (fine: `PUBLIC_URL` points there).
- Keep the replit host running (it is the deployment itself); with the redirect on, old links land on the new host.

## Rollback

At any step:

1. Replit secrets: `PUBLIC_URL=https://meowist--sxexx.replit.app`, `CANONICAL_REDIRECT=false`
   (or remove it). Republish.
2. Keep the old redirects in the Developer Portal (that is why step 4 only adds).
3. Staff log in again on the replit host (host-bound cookies, see step 5).
4. Browsers that cached the 301 keep going to app.mewvo.com for up to 1 hour; that host still
   serves the same deployment, so it works — it just uses the other host's cookies.
5. DNS/GitHub Pages can stay as they are; the static site does not depend on the bot.

**Check:** `curl -sSI https://meowist--sxexx.replit.app/` → `200` (no redirect), dashboard login on
the replit host works.
