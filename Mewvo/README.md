# Mewvo website

The public website of Mewvo, a Discord bot for moderation, appeals and community tools.
Plain static files: no build step, no scripts. Generated from the bot's repository with
`npm run export:site`; regenerate there instead of editing these files by hand.

## Pages

- `/`
- `/features`
- `/pricing`
- `/docs`
- `/docs/getting-started`
- `/docs/warnings`
- `/docs/appeals`
- `/docs/using-the-dashboard`
- `/faq`
- `/commands`
- `/about`
- `/privacy`
- `/terms`

The dashboard, leaderboard, status, server rules, transparency report and "My record" need
the running bot, so their links go to **https://app.mewvo.com**.

## Publish on GitHub Pages with mewvo.com

1. Create a new GitHub repository (for example `mewvo-site`) and push the contents of this folder
   to its `main` branch.
2. Repository → Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. The `CNAME` file already says `mewvo.com`. At your domain registrar add these DNS records:
   - `A` records for `mewvo.com`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `CNAME` record `www` → `<your-github-username>.github.io`
4. When GitHub shows the domain as verified, tick "Enforce HTTPS".

## Connect the bot's address (app.mewvo.com)

1. In the Replit deployment, add the custom domain `app.mewvo.com` and create the DNS record Replit shows.
2. Set the deployment secret `PUBLIC_URL` to `https://app.mewvo.com`, then republish.
3. Discord Developer Portal → OAuth2 → Redirects: add `https://app.mewvo.com/oauth/callback`,
   `https://app.mewvo.com/dashboard/oauth/callback` and `https://app.mewvo.com/me/callback`.
