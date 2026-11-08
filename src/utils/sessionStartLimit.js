// sessionStartLimit.js — one boot line from GET /gateway/bot: how many gateway session starts
// (logins/identifies) are left today. Discord allows 1,000 per 24 h; at 0 the bot cannot log in
// until the reset, so a restart loop must back off long before that
// (docs/scale-and-verification.md). Never throws: a failed call only costs the log line.

import { Routes } from 'discord.js';

/** "Session starts: 998 of 1000 left today (reset in 23.9 h), max concurrency 1, recommended shards 1". */
export function describeSessionStartLimit(body) {
    const limit = body?.session_start_limit;
    if (!limit || !Number.isFinite(Number(limit.remaining))) return 'Session starts: unknown (no session_start_limit in the answer)';
    const hours = (Number(limit.reset_after) || 0) / 3_600_000;
    let line = `Session starts: ${limit.remaining} of ${limit.total ?? '?'} left today (reset in ${hours.toFixed(1)} h), max concurrency ${limit.max_concurrency ?? 1}`;
    if (body.shards !== undefined) line += `, recommended shards ${body.shards}`;
    if (Number(limit.remaining) < 100) line += ' (LOW: check for a restart loop)';
    return line;
}

/** Fetches /gateway/bot with the client's REST and logs one line; a failure logs a warning. */
export async function logSessionStartLimit(client, { log, warn = log } = {}) {
    try {
        const body = await client.rest.get(Routes.gatewayBot());
        const line = describeSessionStartLimit(body);
        (Number(body?.session_start_limit?.remaining) < 100 ? warn : log)(line);
        return line;
    } catch (error) {
        warn(`Session starts: could not read /gateway/bot (${error?.message || error})`);
        return null;
    }
}
