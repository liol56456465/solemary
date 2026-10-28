// localDb.js — the guard every DB test uses (npm run test:db): only a Postgres on this machine.
// Parsed the way pg parses it (a URL parameter such as ?host= overrides the address, and
// "localhost" before the @ is a user name, not a host), so a remote database never slips through.

import { parse } from 'pg-connection-string';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalDatabaseUrl(url) {
    if (!url) return false;
    try {
        const { host } = parse(url);
        return LOCAL.has(String(host || '').toLowerCase());
    } catch {
        return false;
    }
}
