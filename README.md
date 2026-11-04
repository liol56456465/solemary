# Mewvo

Mewvo is a Discord bot for moderation and community servers: enforcement cases with a warn ladder,
appeals, reports, modmail, levels and utility commands, plus a web dashboard for server admins.

Fork of [TitanBot](https://github.com/codebymitch/TitanBot) by codebymitch (MIT) — see [LICENSE](LICENSE).

## Running the tests

Requires Node.js 22 (`nvm use` reads `.nvmrc`).

```sh
npm install
npm test
```

## Privacy and terms

Both are pages of the bot's website, at `/privacy` and `/terms` on whatever address `PUBLIC_URL` is
(today the Replit address; `https://mewvo.com` after the domain switch, see `docs/domain-switch.md`):

- Privacy Policy: <https://meowist--sxexx.replit.app/privacy>
- Terms and Conditions: <https://meowist--sxexx.replit.app/terms>

The Replit address keeps working after the switch (it redirects to the new domain), so these links
do not break; update them to `https://mewvo.com/...` once that domain is live.

## Third-party data

- `/weather`: weather data from [MET Norway](https://api.met.no/) (CC BY 4.0), locations from
  [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL) via Nominatim.
- `/define`: definitions from Wiktionary (CC BY-SA) via the Free Dictionary API.
