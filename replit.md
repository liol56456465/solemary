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

- `DISCORD_TOKEN` (Discord bot token)
- `CLIENT_ID` (Discord application/client ID)

The current Replit workspace uses:

- `NODE_ENV=development`
- `PORT=5000`
- `WEB_HOST=0.0.0.0`

## Deployment

- The deployment must run with `NODE_ENV=production` (the workspace's `development` must never
  act as production) and `LOG_LEVEL=info`.
- Use a **Reserved VM** deployment, not Autoscale: the bot keeps one gateway connection open and
  runs cron jobs, so it must be exactly one always-on instance. (`.replit` currently says
  `deploymentTarget = "cloudrun"`; changing the deployment type is a production change and needs
  the owner's OK.)
- On stop the bot shuts down gracefully (crons, Discord client, buffered counters, HTTP, database;
  10 s at most) and exits 0 after SIGTERM.

PostgreSQL is the owner's own database, set as the secret `POSTGRES_URL`. The bot reads only `POSTGRES_URL`; Replit's own `DATABASE_URL` is ignored. Schema changes run with `npm run migrate`, and `SCHEMA_VERSION` must match. Music was removed, so there is no Lavalink.

## Ticket support

- Closing a ticket generates an HTML transcript and attempts delivery to the configured transcript channel and the ticket creator's DMs.
- The separate `dmOnClose` option controls only the closure-notice DM; transcript and feedback delivery are independent.
- Ticket creators receive a feedback survey by DM when a ticket closes. Their rating/comment is saved to the ticket record and logged when a ticket log channel is configured.
- `/test action user` sends the exact DM a member would get to the person who ran it, and does nothing else (footer "Simulation, no action taken").