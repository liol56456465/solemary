// check-db.js — connects with the bot's own pool settings and reports what the
// database connection really looks like. Read-only: a SELECT ... FOR UPDATE on a
// throwaway value inside a transaction that is rolled back.
//
//   npm run db:check                 (uses POSTGRES_URL from the environment)
//   node --env-file=.env.test scripts/check-db.js
//
// Exits 1 if TLS verification fails for a remote host or a check fails.

import pg from 'pg';
import { resolvePostgresPoolConfig } from '../src/config/database/postgres.js';

const config = resolvePostgresPoolConfig();
const target = (() => {
    try {
        const url = new URL(config.connectionString);
        return `${url.hostname}:${url.port || 5432}${url.pathname}`;
    } catch {
        return `${config.host}:${config.port}/${config.database}`;
    }
})();

const client = new pg.Client(config);
let failed = false;
const report = (label, value) => console.log(`${label.padEnd(22)} ${value}`);

try {
    report('Target', target);
    report('TLS requested', config.ssl ? `yes (verify: ${config.ssl.rejectUnauthorized !== false}, custom CA: ${Boolean(config.ssl.ca)})` : 'no (local database)');
    await client.connect();

    const socket = client.connection?.stream;
    if (typeof socket?.getPeerCertificate === 'function') {
        const cert = socket.getPeerCertificate(true);
        const chain = [];
        for (let c = cert; c && Object.keys(c).length && !chain.includes(c); c = c.issuerCertificate === c ? null : c.issuerCertificate) chain.push(c);
        report('TLS verified', socket.authorized ? 'yes' : `NO (${socket.authorizationError})`);
        report('Certificate subject', cert.subject?.CN ?? '?');
        report('Certificate SAN', cert.subjectaltname ?? '?');
        report('Issuer chain', chain.map((c) => c.issuer?.CN ?? c.issuer?.O ?? '?').join(' -> '));
        report('Valid until', cert.valid_to ?? '?');
        if (config.ssl && config.ssl.rejectUnauthorized !== false && !socket.authorized) failed = true;
    } else {
        report('TLS', 'not in use');
        if (config.ssl) failed = true;
    }

    const { rows: [info] } = await client.query(`SELECT version() AS version, current_setting('statement_timeout') AS timeout,
        current_setting('application_name') AS app, current_user AS role, pg_size_pretty(pg_database_size(current_database())) AS size`);
    report('Server', info.version.split(',')[0]);
    report('Role', info.role);
    report('Database size', info.size);
    report('application_name', info.app || '(none)');
    report('statement_timeout', `${info.timeout}  (pool asks for ${config.statement_timeout || 0} ms; set again on connect by the bot)`);

    // Transactions and row locks must work (session pooler, not transaction mode).
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE meowist_check (id int) ON COMMIT DROP');
    await client.query('INSERT INTO meowist_check VALUES (1)');
    await client.query('SELECT id FROM meowist_check WHERE id = 1 FOR UPDATE');
    await client.query('ROLLBACK');
    report('Transaction + FOR UPDATE', 'ok');
} catch (error) {
    failed = true;
    report('ERROR', `${error.code ?? ''} ${error.message}`.trim());
} finally {
    await client.end().catch(() => {});
}
process.exit(failed ? 1 : 0);
