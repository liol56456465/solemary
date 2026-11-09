// retentionService.js — deletes old personal data on a schedule (GDPR Art. 5(1)(e), storage
// limitation; automatic deletion approved by the owner, 2026-11-04).
//
// Rules (each one bounded DELETE, at most BATCH_LIMIT rows per run; a bigger backlog is
// cleared over the following days):
//   watchlist     mod_watchlist rows that ended (or ran out) more than 1 year ago
//   no_contact    no_contact_orders that ended (or ran out) more than 1 year ago
//   raid_reports  automod_raid_incidents (incident reports) that ended more than 1 year ago
//   verification_audit  verification_audit rows older than 1 year
//   verification_ips    IP hashes not seen for 60 days (members with an active ban in that
//                       server keep theirs; verificationGuard.js). Both tables: verification_ips
//                       (pre-v12, home servers) and verification_guild_ips (per server, v12).
//   oauth_verified_guilds  the servers a member used "Verify with Discord" in, once their stored
//                       token is gone (revoked, /wipedata), after a 1-day grace
//   expired_temp_data / expired_cache_data  key-value rows whose expires_at passed more than a day
//                       ago. Reads already treat them as missing (expires_at > NOW()), so no live
//                       data goes; batches of BATCH_LIMIT, at most KV_MAX_BATCHES per run.
//                       ticket_data is NOT pruned: ticket reads ignore expires_at, so an expired
//                       ticket row is still live data there.
//   bot_dm_log    the bot DM log (schema v13; botDm/dmLog.js): rows older than 30 days. The
//                 language-change re-edit only looks at the last 30 days, so nothing it needs goes.
//   ticket_rating_comments  ticket/modmail rating comments older than 180 days are cleared (stars stay)
//   ticket_ratings          rating rows older than 2 years are deleted
//   ticket_ratings_unrated  never-rated rows 30 days after their window closed are deleted
//   invite_joins  invite tracking join rows (schema v14) of members who left more than 365 days
//                 ago (owner decision 7); members still in the server keep theirs.
// With the bot client (runRetention's first argument), CLIENT_RETENTION_RULES also run:
//   applications  submitted applications past the server's own retention (pending /
//                 reviewed days, Applications settings); moved here from the read path, so
//                 opening a list no longer deletes anything
// Elsewhere, on their own daily crons in app.js: the raid timeline (incident_timelines and
// their events, 90 days after the end; incidentTimeline.js), member_events (90 days),
// website accounts that never linked Discord (accountStore.prune, 7 days).
// Not touched (retention is a legal question): mod_cases, mod_ladder, mod_appeals, case
// notes / evidence / edits, staff_warnings, level data, tickets.
//
// runRetention runs every rule; one failing rule is logged and the others still run. The
// summary log line has counts only, never ids.

import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../../utils/logger.js';
import { query as dbQuery } from '../enforcement/db.js';
import { IP_RETENTION_MS, pruneVerificationIpHashes } from '../verificationGuard.js';
import { cleanupExpiredApplications } from '../../utils/database.js';
import { DM_LOG_DAYS, pruneDmLog } from '../botDm/dmLog.js';
import { RATING_RETENTION_DAYS, pruneOldRatings, pruneRatingComments, pruneUnratedRatings } from '../ticketRatingService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const YEAR_MS = 365 * DAY_MS;
export const BATCH_LIMIT = 5000;

/** Retention periods, for the privacy policy and the tests. */
export const RETENTION_DAYS = Object.freeze({
    watchlist: 365,
    no_contact: 365,
    raid_reports: 365,
    verification_audit: 365,
    verification_ips: IP_RETENTION_MS / DAY_MS,
    oauth_verified_guilds: 1,
    expired_temp_data: 1,
    expired_cache_data: 1,
    bot_dm_log: DM_LOG_DAYS,
    ticket_rating_comments: RATING_RETENTION_DAYS.comments,
    ticket_ratings: RATING_RETENTION_DAYS.rows,
    ticket_ratings_unrated: RATING_RETENTION_DAYS.unrated,
    invite_joins: 365,
});

/** Expired key-value rows: up to this many batches of BATCH_LIMIT per run. */
export const KV_MAX_BATCHES = 20;

/** Daily at 03:30 UTC, and once about 5 minutes after the bot is ready. */
export const RETENTION_CRON = '30 3 * * *';
export const RETENTION_STARTUP_DELAY_MS = 5 * 60 * 1000;
export const RETENTION_JOB = 'privacy_retention';

const cutoff = (now, days) => new Date(now - days * DAY_MS);
const count = (result) => result?.rowCount || 0;

/** mod_watchlist: ended, or past `until` and never closed, more than a year ago. */
export async function pruneWatchlist({ query = dbQuery, tables = pgConfig.tables, now = Date.now(), limit = BATCH_LIMIT } = {}) {
    const t = tables.mod_watchlist;
    return count(await query(
        `DELETE FROM ${t} WHERE id IN (
             SELECT id FROM ${t}
             WHERE COALESCE(ended_at, until) IS NOT NULL AND COALESCE(ended_at, until) < $1
             LIMIT $2)`,
        [cutoff(now, RETENTION_DAYS.watchlist), limit]));
}

/** no_contact_orders: ended early, or past `until`, more than a year ago. */
export async function pruneNoContactOrders({ query = dbQuery, tables = pgConfig.tables, now = Date.now(), limit = BATCH_LIMIT } = {}) {
    const t = tables.no_contact_orders;
    return count(await query(
        `DELETE FROM ${t} WHERE id IN (
             SELECT id FROM ${t} WHERE COALESCE(ended_at, until) < $1 LIMIT $2)`,
        [cutoff(now, RETENTION_DAYS.no_contact), limit]));
}

/** automod_raid_incidents (incident reports): ended more than a year ago (ended_at is NOT NULL). */
export async function pruneRaidIncidents({ query = dbQuery, tables = pgConfig.tables, now = Date.now(), limit = BATCH_LIMIT } = {}) {
    const t = tables.automod_raid_incidents;
    return count(await query(
        `DELETE FROM ${t} WHERE id IN (
             SELECT id FROM ${t} WHERE COALESCE(ended_at, started_at) < $1 LIMIT $2)`,
        [cutoff(now, RETENTION_DAYS.raid_reports), limit]));
}

/** verification_audit: rows older than a year. */
export async function pruneVerificationAudit({ query = dbQuery, tables = pgConfig.tables, now = Date.now(), limit = BATCH_LIMIT } = {}) {
    const t = tables.verification_audit;
    return count(await query(
        `DELETE FROM ${t} WHERE id IN (
             SELECT id FROM ${t} WHERE created_at < $1 LIMIT $2)`,
        [cutoff(now, RETENTION_DAYS.verification_audit), limit]));
}

/** verification_ips: the guard's own prune (60 days, active bans kept). */
export async function pruneVerificationIps({ query = dbQuery, now = Date.now(), limit = BATCH_LIMIT } = {}) {
    return pruneVerificationIpHashes({ q: query, now, limit });
}

/**
 * oauth_verified_guilds: rows of members without a stored token (oauth:tokens:<id> in temp_data),
 * last authorized more than a day ago (the grace covers a verification storing its token).
 */
export async function pruneOAuthVerifiedGuilds({ query = dbQuery, tables = pgConfig.tables, now = Date.now(), limit = BATCH_LIMIT } = {}) {
    const t = tables.oauth_verified_guilds;
    return count(await query(
        `DELETE FROM ${t} WHERE ctid IN (
             SELECT o.ctid FROM ${t} o
             WHERE o.authorized_at < $1
               AND NOT EXISTS (
                   SELECT 1 FROM ${tables.temp_data} d
                   WHERE d.key = 'oauth:tokens:' || o.user_id AND (d.expires_at IS NULL OR d.expires_at > $3)
               )
             LIMIT $2)`,
        [cutoff(now, RETENTION_DAYS.oauth_verified_guilds), limit, new Date(now)]));
}

/**
 * Rows of a key-value table (temp_data, cache_data; primary key `key`) that expired more than a
 * day ago, in batches. SKIP LOCKED: a row a write holds right now waits for the next run.
 */
export async function pruneExpiredKeyValues(table, { query = dbQuery, limit = BATCH_LIMIT, maxBatches = KV_MAX_BATCHES } = {}) {
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
        const n = count(await query(
            `DELETE FROM ${table} WHERE key IN (
                 SELECT key FROM ${table}
                 WHERE expires_at IS NOT NULL AND expires_at <= NOW() - interval '1 day'
                 LIMIT $1 FOR UPDATE SKIP LOCKED)`,
            [limit]));
        total += n;
        if (n < limit) break;
    }
    return total;
}

export async function pruneExpiredTempData({ query = dbQuery, tables = pgConfig.tables, limit = BATCH_LIMIT } = {}) {
    return pruneExpiredKeyValues(tables.temp_data, { query, limit });
}

export async function pruneExpiredCacheData({ query = dbQuery, tables = pgConfig.tables, limit = BATCH_LIMIT } = {}) {
    return pruneExpiredKeyValues(tables.cache_data, { query, limit });
}

/** bot_dm_log: DMs logged for a language change, older than 30 days. */
export async function pruneBotDmLog({ query = dbQuery, tables = pgConfig.tables, now = Date.now(), limit = BATCH_LIMIT } = {}) {
    return pruneDmLog({ query, tables, now, limit });
}

/** invite_joins: rows whose member left the server more than 365 days ago. */
export async function pruneInviteJoins({ query = dbQuery, tables = pgConfig.tables, now = Date.now(), limit = BATCH_LIMIT } = {}) {
    const t = tables.invite_joins;
    return count(await query(
        `DELETE FROM ${t} WHERE id IN (
             SELECT id FROM ${t} WHERE left_at IS NOT NULL AND left_at < $1 LIMIT $2)`,
        [cutoff(now, RETENTION_DAYS.invite_joins), limit]));
}

export const RETENTION_RULES = Object.freeze([
    ['watchlist', pruneWatchlist],
    ['no_contact', pruneNoContactOrders],
    ['raid_reports', pruneRaidIncidents],
    ['verification_audit', pruneVerificationAudit],
    ['verification_ips', pruneVerificationIps],
    ['oauth_verified_guilds', pruneOAuthVerifiedGuilds],
    ['expired_temp_data', pruneExpiredTempData],
    ['expired_cache_data', pruneExpiredCacheData],
    ['bot_dm_log', pruneBotDmLog],
    // Ticket ratings (v14, ticketRatingService.js).
    ['ticket_rating_comments', pruneRatingComments],
    ['ticket_ratings', pruneOldRatings],
    ['ticket_ratings_unrated', pruneUnratedRatings],
    ['invite_joins', pruneInviteJoins],
]);

/**
 * Expired submitted applications of every server the bot is in (key-value store; the
 * per-server retention days). One failing server is logged and the others still run.
 */
export async function pruneExpiredApplications({ client, cleanup = cleanupExpiredApplications } = {}) {
    if (!client?.db || !client.guilds?.cache) return 0;
    let removed = 0;
    for (const guildId of client.guilds.cache.keys()) {
        try {
            removed += (await cleanup(client, guildId))?.removed || 0;
        } catch (error) {
            logger.warn(`Retention: applications of one server not cleaned this run: ${error.message}`);
        }
    }
    return removed;
}

/** Rules that need the bot client (key-value store data); run only when runRetention gets one. */
export const CLIENT_RETENTION_RULES = Object.freeze([
    ['applications', pruneExpiredApplications],
]);

/**
 * Runs every rule. Returns { counts: { rule: n }, failed: [rule] }; never throws. A failed
 * rule is logged (warn) and the next one runs. One info line with the counts.
 */
export async function runRetention(client = null, { query = dbQuery, tables = pgConfig.tables, now = Date.now(), rules = RETENTION_RULES, clientRules = CLIENT_RETENTION_RULES } = {}) {
    const counts = {};
    const failed = [];
    for (const [name, rule] of [...rules, ...(client ? clientRules : [])]) {
        try {
            counts[name] = await rule({ query, tables, now, client });
        } catch (error) {
            failed.push(name);
            logger.warn(`Retention: rule ${name} failed, nothing deleted by it this run: ${error.message}`);
        }
    }
    const parts = Object.entries(counts).map(([name, n]) => `${name}=${n}`);
    if (failed.length) parts.push(`failed=${failed.join(',')}`);
    logger.info(`Retention: deleted ${parts.join(' ') || 'nothing'}`);
    return { counts, failed };
}

/**
 * Wires the job: the daily cron and one run RETENTION_STARTUP_DELAY_MS after ready. `wrap` is
 * app.js's overlap guard (exclusive), so the startup run and the cron never run at once.
 * whenReady(fn) calls fn once the client is ready. Returns the wrapped job.
 */
export function scheduleRetention({ schedule, wrap, run, whenReady, setTimer = setTimeout }) {
    const job = wrap(RETENTION_JOB, run);
    schedule(RETENTION_CRON, job, { timezone: 'UTC' });
    whenReady(() => {
        const timer = setTimer(job, RETENTION_STARTUP_DELAY_MS);
        timer?.unref?.();
    });
    return job;
}
