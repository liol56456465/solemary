# Contributing to Mewvo

Thank you for your interest in contributing to Mewvo! This guide covers local setup, project conventions, and what we look for in pull requests.

## Ways to Contribute

- Bug fixes and reliability improvements
- New commands or enhancements to existing features
- Documentation updates

Before starting large features, open an issue or discuss in the [support server](https://discord.gg/7Ckv9Bt577) so we can align on scope and avoid duplicate work.

## Getting Started

### Prerequisites

- **Node.js 22.12+** (Docker and CI use Node 22; `nvm use` reads `.nvmrc`)
- **PostgreSQL** on localhost, for the database tests

### Local Setup

There is no local dev environment for the bot itself: it is never started locally against Discord.
Discord testing happens on the owner's Replit deployment (see [docs/test-script.md](docs/test-script.md)).
Locally you run the automated tests only.

1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the unit tests:
   ```bash
   npm test
   ```
4. Run the database tests against a local Postgres (they skip themselves unless `POSTGRES_URL` points at localhost):
   ```bash
   npm run test:db
   ```
   The npm scripts load their environment from `~/.config/mewvo/`, outside the repo. Never put an env file with
   real values in the repo folder: the repo is public. `.env.example` lists the variable names with placeholders only.

## Development Workflow

1. **Fork the repository** and create a branch from `main`.
2. **Make focused changes**: one logical change per pull request when possible.
3. **Open a pull request** with a clear description of what changed and why.

Use descriptive branch names, for example:

- `fix/ticket-panel-refresh`
- `feature/appeal-reminders`
- `docs/contributing-guide`

## Database & Migrations

Mewvo uses PostgreSQL as its store. Production refuses to start without it (unless `ALLOW_MEMORY_DB=true`), and a database error is reported to the user instead of being hidden behind default values.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run migrate` | Apply migrations |
| `npm run migrate:check` | Verify schema version matches expectations |
| `npm run migrate:status` | Show current migration status |

If your change modifies the database schema, update the expected schema version in `.env.example` (`SCHEMA_VERSION`, `SCHEMA_VERSION_LABEL`) and ensure `npm run migrate:check` passes locally.

Features that read or write data need a test in `tests/db/` (run with `npm run test:db`), including the database-error path.

## Code Guidelines

- **Match existing style**: ES modules (`import`/`export`), async/await, and the conventions used in neighboring files.
- **Handle errors gracefully**: catch failures, log with context, and send user-friendly embed replies where appropriate.
- **Avoid breaking guild isolation**: guild-specific config and data must stay scoped per server (`guild:{guildId}:...` keys, `interaction.guildId`).
- **Keep changes minimal**: prefer extending existing utilities and services over duplicating logic.
- **Document user-facing behavior**: update README.md when setup steps or configuration change; mention new env vars in `.env.example`.

There is no ESLint config in this repo today; consistency with surrounding code is the main bar.

## Pull Request Checklist

In your PR description, include:

- **What** changed
- **Why** the change is needed
- **How to test** it: which automated tests cover it, and the Discord steps to check on Replit

## Reporting Issues

When reporting a bug, include:

- Steps to reproduce
- Expected vs. actual behavior
- Relevant logs (`LOG_LEVEL=debug` can help locally)
- Whether you use PostgreSQL or memory fallback
- Bot version / commit hash if known

## License

By contributing, you agree that your contributions will be licensed under the same [MIT License](LICENSE) that covers this project.
