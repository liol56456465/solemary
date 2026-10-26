# Replit setup

## Run

The project is a Node.js Discord bot with an Express health server.

- Workflow: `Start application`
- Command: `npm start`
- Preview port: `5000`
- Health check: `/health`
- Readiness check: `/ready`

## Required environment

Add these through Replit Secrets/environment variables:

- `DISCORD_TOKEN` — Discord bot token
- `CLIENT_ID` — Discord application/client ID

The current Replit setup also uses:

- `NODE_ENV=development`
- `PORT=5000`
- `WEB_HOST=0.0.0.0`

PostgreSQL is supplied by the Replit environment through `DATABASE_URL`. The bot initializes its schema on startup. Lavalink nodes are loaded from `lavalink/nodes.json`; individual unavailable public nodes are logged and skipped.

## Ticket support

- Closing a ticket generates an HTML transcript and attempts delivery to the configured transcript channel and the ticket creator's DMs.
- The separate `dmOnClose` option controls only the closure-notice DM; transcript and feedback delivery are independent.
- Ticket creators receive a feedback survey by DM when a ticket closes. Their rating/comment is saved to the ticket record and logged when a ticket log channel is configured.
- `/test` is restricted in code to the current server owner or a configured bot owner. It is a dry-run diagnostics command: it checks moderation permissions, target eligibility, role hierarchy, ticket, feedback, transcript, and verification setup without taking moderation actions. Use a different member as the target for member-based checks.