// inviteReconcile.js — closes invite_joins rows of members who left while Mewvo could not see it.
//
// left_at is normally stamped by guildMemberRemove (inviteTracker.noteMemberLeft) or by the
// member's next join (inviteStore.insertJoin). A member who left while the bot was offline or the
// database was down, and never came back, kept an open row forever: never pruned by the 365-day
// retention (it only deletes rows with left_at set) and counted as "still here" for the inviter.
//
// This job, for every server with invite tracking on (same pick as the invite warm-up):
//   1. reads the open rows (left_at IS NULL, counted or not) that joined more than
//      MIN_AGE_HOURS ago, in pages by id (no member fetch when there are none);
//   2. gets the member list through the member fetch gate (utils/memberFetchGate.js);
//   3. only when that list is complete (memberListTrusted) closes the rows whose member is not in
//      it: left_at = NOW(), batched UPDATEs (id = ANY($ids)). Safe when unsure: a skipped fetch
//      (too large, rate limit, cooldown, busy, timeout, no intent), an error or a partial cache
//      closes nothing — like the role mirror (docs/home-servers.md).
//
// The real leave time is unknown, so left_at is the reconcile time. The fake rule ("left within
// fakeLeaveHours of joining", inviteStats FAKE_SQL / isFakeJoin) must never treat these rows as
// quick leaves. No marker column is needed: only rows that joined more than MIN_AGE_HOURS
// (= the highest fakeLeaveHours a server can set, INVITE_LIMITS.maxLeaveHours, 720 h) ago are
// closed, and the UPDATE re-checks that against the same NOW(), so for every allowed setting
// left_at >= joined_at + fakeLeaveHours: such a row counts as "left", never as "fake".
// Trade-off: a member who joined and left within those 30 days while Mewvo was blind stays open
// until the row is 30 days old (then the next daily run closes it).
//
// Runs daily (cron, overlap guard in app.js; off in test mode like the other crons) and once
// after startup, after the invite warm-up. One server at a time, a pause between servers; one
// summary log line per run. A server that fails is counted and the others still run; the run
// then throws so cronStats records it as failed.

import { logger } from '../../utils/logger.js';
import { fetchAllMembers } from '../../utils/memberFetchGate.js';
import { isEnforcementDbAvailable } from '../enforcement/db.js';
import { INVITE_LIMITS } from '../settings/settingsRegistry.js';
import { inviteWarmUpSettled } from './inviteCache.js';
import { forgetLeaderboard, inviteTrackingOn } from './inviteStats.js';
import { closeOpenJoins, listOpenJoins } from './inviteStore.js';

export const RECONCILE_JOB = 'invite_left_reconcile';
export const RECONCILE_CRON = '10 5 * * *'; // daily 05:10 UTC
export const RECONCILE_STARTUP_DELAY_MS = 10 * 60_000;
export const RECONCILE_SERVER_PAUSE_MS = 500;
export const MIN_AGE_HOURS = INVITE_LIMITS.maxLeaveHours;
export const PAGE_SIZE = 5000;
export const MAX_PAGES = 20; // at most 100,000 open rows per server per run; the rest next run
export const UPDATE_BATCH = 1000;
const TRUSTED_REASONS = new Set(['fetched', 'fresh', 'cache']);

/**
 * Is the gate's member list complete enough to say "not in it = left"? Pure. Only a complete
 * result (not partial, a finished fetch or a full cache) whose size reaches guild.memberCount.
 */
export function memberListTrusted(guild, gate) {
    if (!gate || gate.partial !== false || !TRUSTED_REASONS.has(gate.reason)) return false;
    const total = Number(guild?.memberCount) || 0;
    const size = Number(gate.members?.size) || 0;
    return total > 0 && size >= total;
}

/**
 * Which open rows belong to members who are gone? Pure. rows: [{ id, userId }];
 * members: anything with has(userId) (the member cache); trusted: memberListTrusted(...).
 * An untrusted list → nobody (never guess).
 */
export function absentJoinIds(rows, members, trusted) {
    if (!trusted || !members || typeof members.has !== 'function') return [];
    return (rows || []).filter((row) => row?.userId && !members.has(String(row.userId))).map((row) => String(row.id));
}

const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
});

/**
 * One server. Returns { open, closed, untrusted: reason | null }. Throws on a database error.
 * deps: list, close, fetchMembers (tests).
 */
export async function reconcileGuild(guild, deps = {}) {
    const { list = listOpenJoins, close = closeOpenJoins, fetchMembers = fetchAllMembers } = deps;
    const out = { open: 0, closed: 0, untrusted: null };
    let page = await list(guild.id, { minAgeHours: MIN_AGE_HOURS, afterId: 0, limit: PAGE_SIZE });
    if (!page.length) return out;

    const gate = await fetchMembers(guild);
    if (!memberListTrusted(guild, gate)) {
        out.untrusted = gate?.reason || 'unknown';
        // Still count what is open (for the summary), without touching it.
        out.open = page.length;
        return out;
    }

    // A snapshot taken right after the trust check: gate.members is the live cache, and a
    // GUILD_CREATE during the awaits below (re-identify) clears and partly refills it. Someone who
    // joins after the snapshot has a new (too young) row; their old open row is closed by
    // insertJoin anyway.
    const present = new Set(gate.members.keys());
    try {
        for (let pages = 0; page.length && pages < MAX_PAGES; pages += 1) {
            out.open += page.length;
            const absent = absentJoinIds(page, present, true);
            for (let i = 0; i < absent.length; i += UPDATE_BATCH) {
                out.closed += await close(guild.id, absent.slice(i, i + UPDATE_BATCH), { minAgeHours: MIN_AGE_HOURS });
            }
            if (page.length < PAGE_SIZE) break;
            page = await list(guild.id, { minAgeHours: MIN_AGE_HOURS, afterId: page.at(-1).id, limit: PAGE_SIZE });
        }
    } finally {
        if (out.closed) forgetLeaderboard(guild.id);
    }
    return out;
}

/**
 * Every server with invite tracking on, one at a time, `pauseMs` between them; one summary line.
 * A failing server is counted and the others still run; then the run throws (error.totals) so
 * cronStats records it as failed. Returns { servers, closed, untrusted, errors } or { skipped: 'database' }.
 * deps (tests): isOn(guildId), dbAvailable(), reconcile(guild), sleepFn, pauseMs, log.
 */
export async function reconcileInviteLeaves(client, deps = {}) {
    const {
        isOn = (id) => inviteTrackingOn(id), dbAvailable = isEnforcementDbAvailable,
        reconcile = (guild) => reconcileGuild(guild), sleepFn = sleep, pauseMs = RECONCILE_SERVER_PAUSE_MS,
        log = (line) => logger.info(line),
    } = deps;
    if (!dbAvailable()) {
        log('Invite leave reconcile skipped: database unavailable');
        return { skipped: 'database' };
    }
    const guilds = [...(client?.guilds?.cache?.values?.() || [])].filter((g) => g?.id && isOn(g.id));
    const totals = { servers: guilds.length, closed: 0, untrusted: 0, errors: 0 };
    const reasons = new Map();
    for (const [index, guild] of guilds.entries()) {
        if (index > 0) await sleepFn(pauseMs);
        if (!client.guilds.cache.has(guild.id)) continue; // left while the job ran
        try {
            const result = await reconcile(guild);
            totals.closed += result.closed || 0;
            if (result.untrusted) {
                totals.untrusted += 1;
                reasons.set(result.untrusted, (reasons.get(result.untrusted) || 0) + 1);
            }
        } catch (error) {
            totals.errors += 1;
            logger.warn(`Invite leave reconcile failed for guild ${guild.id}: ${error.message}`);
        }
    }
    const why = reasons.size ? ` (${[...reasons].map(([r, n]) => `${r}: ${n}`).join(', ')})` : '';
    log(`Invite leave reconcile: ${totals.servers} server(s), ${totals.closed} row(s) closed, `
        + `${totals.untrusted} skipped without a complete member list${why}, ${totals.errors} failed`);
    // Failed servers make the run count as failed in cronStats (the health report shows it).
    if (totals.errors) throw Object.assign(new Error(`invite leave reconcile failed for ${totals.errors} server(s)`), { totals });
    return totals;
}

/**
 * Registers the daily run and the startup run (RECONCILE_STARTUP_DELAY_MS after ready, then it
 * waits for the invite warm-up). Both go through `wrap` (app.js exclusive()). Returns the job.
 */
export function scheduleInviteLeaveReconcile({
    schedule, wrap, run, whenReady, setTimer = setTimeout, warmUp = inviteWarmUpSettled,
}) {
    const job = wrap(RECONCILE_JOB, run);
    schedule(RECONCILE_CRON, job, { timezone: 'UTC' });
    whenReady(() => {
        const timer = setTimer(() => Promise.resolve(warmUp()).catch(() => null).then(() => job()), RECONCILE_STARTUP_DELAY_MS);
        timer?.unref?.();
    });
    return job;
}
