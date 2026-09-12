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