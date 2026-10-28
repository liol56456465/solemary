---
name: Discord command limit
description: Architectural constraint for adding slash commands to this Discord bot.
---

Keep Discord's global slash-command root count within 100. After the enforcement rework the bot registers 90 global roots, plus guild-only commands (/enforcements and /background in MAIN_GUILD_ID, /appeals and /appeals-panel in SUPPORT_GUILD_ID) that do not count toward the global limit. Prefer subcommands under existing groups for new user-facing features.

**Why:** Discord enforces a 100-root global application-command limit.

**How to apply:** Before adding a command, inspect the existing roots and prefer an existing namespace such as `/ticket`. Give a command `scope: 'main' | 'support'` to register it per guild instead of globally. Verify registration with `npm run deploy:commands:test`.
