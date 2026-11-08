// errorEvents.js — records system errors for the dashboard's Owner → Recent errors page
// (table error_events, schema v11; store: services/owner/errorEventStore.js).
//
// Called by errorHandler.js: handleInteractionError (system errors only, the ones that show a
// Ref) and handleTaskError. Fire and forget: recordErrorEvent never throws, never waits and never
// changes the reply a user gets. A failed insert logs one warning (at most one per 5 minutes).
//
// What a row holds: error code and type, the source (command name, customId prefix or task
// name), the server ID, the short trace (what the user saw after the code in the Ref) and the
// internal error message, cut to 300 characters with Discord IDs masked. Never a user ID and
// never text a member wrote.
//
// Limits: at most RATE_LIMIT rows per RATE_WINDOW_MS (in memory, so an error storm cannot flood
// the database); the store keeps the newest KEEP_ROWS rows (pruned on insert).

import { logger } from './logger.js';

export const RATE_LIMIT = 30;
export const RATE_WINDOW_MS = 60 * 1000;
export const KEEP_ROWS = 500;
export const MESSAGE_MAX = 300;
export const TRACE_MAX = 8;
export const WARN_EVERY_MS = 5 * 60 * 1000;

const SNOWFLAKE = /\b\d{17,20}\b/g;
// Quoted values in standard messages (pg "invalid input syntax …: \"x\"", JSON.parse) can be member input.
const QUOTED = /"[^"]*"|'[^']*'/g;
const SOURCE_MAX = 100;
const CODE_MAX = 64;
const TYPE_MAX = 32;

/** The internal message as stored: one line, quoted values and Discord IDs masked, at most 300 characters. */
export function cleanErrorMessage(message) {
    const text = String(message ?? '').replace(QUOTED, '"…"').replace(SNOWFLAKE, '<id>').replace(/\s+/g, ' ').trim();
    return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text;
}

const cut = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const guildIdOf = (value) => (typeof value === 'string' && /^\d{17,20}$/.test(value) ? value : null);

/** The row recordErrorEvent stores (pure). */
export function errorEventRow({ errorCode, errorType, source, guildId = null, traceId = null, message = '' } = {}) {
    const trace = traceId ? cut(traceId, TRACE_MAX) : '';
    return {
        error_code: cut(errorCode, CODE_MAX) || 'UNKNOWN',
        error_type: cut(errorType, TYPE_MAX) || 'unknown',
        source: cut(source, SOURCE_MAX).replace(SNOWFLAKE, '<id>') || 'unknown',
        guild_id: guildIdOf(guildId),
        trace_id: trace || null,
        message: cleanErrorMessage(message),
    };
}

/** Where an interaction error came from: the command name, else the customId prefix. */
export function interactionSource(interaction, context = {}) {
    if (interaction?.commandName) return String(interaction.commandName);
    if (typeof interaction?.customId === 'string' && interaction.customId) return `${interaction.customId.split(':')[0]}:`;
    if (context?.command) return String(context.command);
    return context?.source ? String(context.source) : 'interaction';
}

/**
 * A recorder: rate limit + throttled warning around a sink(row) → Promise. The default one
 * (below) writes to the database; tests make their own.
 */
export function createErrorRecorder({
    sink, now = () => Date.now(), limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS, warnEveryMs = WARN_EVERY_MS, log = logger,
} = {}) {
    let windowStart = 0;
    let used = 0;
    let dropped = 0;
    let lastWarn = -Infinity;
    let failedSinceWarn = 0;

    function warnFailed(error) {
        failedSinceWarn += 1;
        const at = now();
        if (at - lastWarn < warnEveryMs) return;
        lastWarn = at;
        const more = failedSinceWarn > 1 ? ` (${failedSinceWarn} failed since the last warning)` : '';
        failedSinceWarn = 0;
        try {
            log.warn(`Recent errors: could not record an error event${more}: ${error?.message || error}`);
        } catch { /* logging must not throw either */ }
    }

    /** Queues one row; true when accepted, false when rate-limited. Never throws. */
    function record(event) {
        try {
            const at = now();
            if (at - windowStart >= windowMs) {
                windowStart = at;
                used = 0;
            }
            if (used >= limit) {
                dropped += 1;
                return false;
            }
            used += 1;
            const row = errorEventRow(event);
            Promise.resolve()
                .then(() => sink(row))
                .catch(warnFailed);
            return true;
        } catch (error) {
            warnFailed(error);
            return false;
        }
    }

    return { record, stats: () => ({ used, dropped }) };
}

let sinkOverride = null;

async function databaseSink(row) {
    const { insertErrorEvent } = await import('../services/owner/errorEventStore.js');
    return insertErrorEvent(row);
}

const defaultRecorder = createErrorRecorder({ sink: (row) => (sinkOverride || databaseSink)(row) });

let recordedCount = 0;

/** Records one error event (fire and forget; see the top of this file). */
export function recordErrorEvent(event) {
    recordedCount += 1;
    return defaultRecorder.record(event);
}

/** How many error events were reported since the process started (counted before the rate limit; the health report). */
export function errorEventCount() {
    return recordedCount;
}

/** Tests: replace where rows go (null = the database again). */
export function setErrorEventSink(fn) {
    sinkOverride = typeof fn === 'function' ? fn : null;
}
