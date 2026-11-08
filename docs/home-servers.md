# Home servers: role mirror, health report, profile channel

Three features that only run in Mewvo's own three servers (the bot is in all three). Every id
lives in `src/config/homeServers.js` (ids are not secrets).

| Server | Id | Used for |
|---|---|---|
| main | `1527697154926182492` | source of the role mirror |
| support | `1564312871976829009` | mirrored roles |
| database (owner tools) | `1564332751170044186` | mirrored roles, health channel, profile channel, `/database` |

## 1. Role mirror (main → support / database)

A member's roles in MAIN decide these roles in the other two servers:

| Main role(s) | Gives | In |
|---|---|---|
| `1527697154926182498` | `1564363263402184885` | support |
| any of `1527697154943225980`, `…979`, `…978`, `…977` | **UNSET** (given as `156436291527508386`) | support |
| `1527697154943225981` | `1564363269765079070` | support |
| `1527697154943225982` | `1564362821071016080` | support |
| any of `1527697154943225980`, `…979`, `…978`, `…977` | `1569108491380072581` | database |
| `1527697154943225982` | `1569108245241536613` | database |

The second row's id has only 18 digits and is older than the support server, so it cannot be a
role there (a digit was probably lost). It is kept as an UNSET entry: skipped, and one warning at
startup ("Role mirror: the support role for main roles … is not set"). Fix: put the right id as
`target` in `REAL_MIRROR_RULES`.

- The target role is given while the member has any source role in main, and removed when they
  have none or leave main. Only these six target roles are ever touched ("managed"): a managed
  role given by hand in support/database to someone without the main role is taken away at the
  next reconcile, and one removed by hand comes back.
- Triggers: role change in main (`guildMemberUpdate`), joining support/database
  (`guildMemberAdd`), leaving main (`guildMemberRemove`), and an hourly reconcile (`:25`, cron
  `role_mirror`) that reads the full member lists through `memberFetchGate` and logs one summary line.
- No loop: only role changes in MAIN are acted on; the mirror only changes support/database.
- Safe when unsure: if main is unreachable, or a member's main roles are unknown (fetch error,
  partial member list), nothing is removed.
- Every change is one single-role add/remove with the audit-log reason `Mewvo role mirror`; never a
  full role-list write, so the Banned role sync (support), the supporter role (main), warn roles
  and level roles cannot be overwritten.
- Checks per target role: it exists, is not integration-managed, the bot has Manage Roles and its
  highest role is above it. Otherwise: one warning per role per hour, and that role is skipped.
- Staff guard: it ignores audit-log entries made by the bot itself, and it does not watch member
  role updates; the mass-action guard only counts bans, kicks and mutes. Mirror changes trip neither.

**Owner setup:** in support and in database, Mewvo's role needs **Manage Roles** and must be
**above** every target role (Server Settings → Roles, drag Mewvo above them).

## 2. Health report (every 5 minutes)

Channel `1569108216372269217` in the database server. One message, **edited** every 5 minutes
(cron `health_report`); its id is kept in memory and in the key-value store
(`home:health:message`). If the message is deleted, a new one is posted. Nobody is pinged.

Shows: uptime, gateway ping, servers, cached members, heap/RSS, event-loop p99 (since the last
report); database status and latency, size (`pg_database_size`) and schema version (both cached
10 minutes); each cron job's last run, failures and skipped ticks (failing jobs first); errors
and REST rate-limit hits since the last report; gateway session starts left today (cached 10
minutes); `NODE_ENV`, Replit deployment yes/no, Node version. No tokens, URLs, hosts or user data.

The title says "All good", "Needs a look" (a failing cron, schema mismatch, errors or rate limits
since the last report, fewer than 100 session starts) or "Problem" (database not connected).

**Owner setup:** Mewvo needs View Channel, Send Messages and Embed Links there (it warns once an
hour otherwise).

## 3. Profile channel (`/database profile`)

`/database profile user:<user or id>` (owner only: `OWNER_IDS`, in the database server only, like
every `/database` subcommand). Shows what the database holds about that user across all
servers: cases (code, server, type, status, reason), warns per server, warn ladder level per
server, appeals, staff reports, watchlist, keep-apart orders, levels per server, tickets,
modmail, verification log and OAuth-verified servers, website account, premium plan and orders,
bot blacklist, staff warnings, staff activity per week, cases they gave. Never shown: IPs (not
even "IP seen"), OAuth tokens or records, sessions, password hashes, 2FA data, full premium codes.
Long results are paged with Previous / Next (embed limits kept).

- In channel `1564332757029490851` the reply is a normal visible message and is **deleted after 2
  minutes**. The pages are edits of that one message, so the delete removes every page. The
  timer is in memory: a restart within those 2 minutes leaves the message (delete it by hand).
- Anywhere else in the database server it is ephemeral, as before.

## Test mode

With `NODE_ENV=test` none of the real ids is used. Each feature is off unless its test id is set
in the test env file, and a real id there is ignored (and refused at startup):

| Env | What |
|---|---|
| `MAIN_GUILD_ID`, `SUPPORT_GUILD_ID` | test main / support (already required) |
| `HOME_DATABASE_GUILD_ID` | test database server |
| `HOME_HEALTH_CHANNEL_ID` | health channel there |
| `HOME_PROFILE_CHANNEL_ID` | profile channel there |
| `HOME_ROLE_MIRROR` | rules, e.g. `111…,222…>333…@support;444…>555…@database` |

Crons (health report, reconcile) are off in test mode unless `TEST_ENABLE_CRON=true`.
