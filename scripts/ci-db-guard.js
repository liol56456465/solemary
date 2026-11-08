// ci-db-guard.js — runs before the database tests in CI (npm run test:db:ci). The CI job sets
// its env vars itself (no --env-file), so this keeps the same safety as test mode: test mode
// on, a database on this machine only, and no Discord token or client secret in the job.
// Exits 1 with the reason; prints no values.

import { isLocalDatabaseUrl } from '../tests/helpers/localDb.js';

const problems = [];
if (process.env.NODE_ENV !== 'test') problems.push('NODE_ENV must be "test".');
if (!isLocalDatabaseUrl(process.env.POSTGRES_URL || '')) problems.push('POSTGRES_URL must point at a database on localhost.');
for (const name of ['DISCORD_TOKEN', 'TOKEN', 'DISCORD_CLIENT_SECRET', 'OAUTH_TOKEN_KEY', 'SESSION_SECRET']) {
    if (process.env[name]) problems.push(`${name} must not be set for the database tests.`);
}

if (problems.length) {
    console.error(`Refusing to run the database tests:\n- ${problems.join('\n- ')}`);
    process.exit(1);
}
console.log('CI database guard: local database, test mode, no tokens.');
