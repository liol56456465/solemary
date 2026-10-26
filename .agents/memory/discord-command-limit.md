---
name: Discord command limit
description: Architectural constraint for adding slash commands to this Discord bot.
---

Keep Discord’s global slash-command root count within 100. The project currently uses all 100 roots, so future user-facing command functionality should be added as subcommands under existing command groups unless a root command is removed.

**Why:** Discord enforces a 100-root global application-command limit, and the current command set registers at that limit.

**How to apply:** Before adding a command, inspect the existing roots and prefer an existing namespace such as `/ticket` for related functionality. Verify command registration after changes.
