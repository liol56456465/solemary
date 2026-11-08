// memberFetchGate.js — the only way to run a full guild.members.fetch() (no user id).
//
// A full fetch is a gateway "Request Guild Members" (opcode 8); Discord rate-limits it and
// discord.js 14.27 rejects with a GatewayRateLimitError when it answers RATE_LIMITED. With many
// servers the bot must not fire these freely, so every full fetch goes through here:
//   - one full fetch at a time per guild; later callers join the running promise;
//   - at least MIN_GAP_MS (60 s) between full fetches of one guild, plus a per-caller freshness
//     (`maxAgeMs`): a fetch that finished within it is reused;
//   - at most MAX_CONCURRENT (2) full fetches at once across all guilds (others wait in a
//     bounded queue, up to `waitMs`);
//   - no fetch when the cache already holds >= 90% of guild.memberCount;
//   - no fetch above FULL_FETCH_MAX_MEMBERS (env, default 25000) or the caller's `maxMembers`;
//   - a gateway rate limit = "try again later": warned once per guild per hour, retried no
//     sooner than Discord's retry_after (and the 60 s gap).
// It never throws. The result always carries the member cache (guild.members.cache):
//   { members, fetched, partial, reason }
//   fetched: a full fetch finished during this call (own or joined);
//   partial: the cache may be missing members (no complete list now); callers that show the
//            result to staff say so ("based on cached members");
//   reason:  'fetched' | 'cache' | 'fresh' | 'cooldown' | 'too-large' | 'rate-limited' |
//            'busy' | 'timeout' | 'failed' | 'no-guild'.

import { BoundedMap } from './boundedMap.js';
import { logger } from './logger.js';

export const MIN_GAP_MS = 60_000;
export const MAX_CONCURRENT = 2;
export const CACHE_COMPLETE_RATIO = 0.9;
export const DEFAULT_MAX_MEMBERS = 25_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_WAIT_MS = 30_000;
const RATE_LIMIT_WARN_MS = 60 * 60_000;
const MAX_WAITERS = 100;
const MAX_TRACKED_GUILDS = 5_000;

/** guildId → { lastAttemptAt, lastOkAt, retryAt, warnedAt } */
const state = new BoundedMap(MAX_TRACKED_GUILDS);
/** guildId → Promise<'ok'|'failed'|'timeout'|'rate-limited'|'busy'> (bounded by the cap + queue) */
const inflight = new BoundedMap(MAX_CONCURRENT + MAX_WAITERS + 10);
let running = 0;
const waiters = [];

/** FULL_FETCH_MAX_MEMBERS from the environment (positive integer), else 25000. */
export function fullFetchMaxMembers(env = process.env) {
    const value = Number.parseInt(env.FULL_FETCH_MAX_MEMBERS ?? '', 10);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_MEMBERS;
}

/** True for discord.js's GatewayRateLimitError (gateway RATE_LIMITED) or a RATE_LIMITED code. */
export function isGatewayRateLimit(error) {
    if (!error) return false;
    if (error.constructor?.name === 'GatewayRateLimitError' || error.name === 'GatewayRateLimitError') return true;
    if (error.code === 'RATE_LIMITED' || error.code === 'GatewayRateLimited') return true;
    return error.data?.retry_after !== undefined && error.data?.opcode !== undefined;
}

function entryOf(guildId) {
    let entry = state.get(guildId);
    if (!entry) {
        entry = { lastAttemptAt: 0, lastOkAt: 0, retryAt: 0, warnedAt: 0 };
        state.set(guildId, entry);
    }
    return entry;
}

function cacheIsComplete(guild) {
    const total = Number(guild.memberCount) || 0;
    return total > 0 && (guild.members.cache?.size || 0) >= total * CACHE_COMPLETE_RATIO;
}

function result(guild, reason, { fetched = false, partial = true } = {}) {
    return { members: guild?.members?.cache ?? new Map(), fetched, partial, reason };
}

/** Takes one of the MAX_CONCURRENT slots; false when none freed up within waitMs or the queue is full. */
function acquireSlot(waitMs) {
    if (running < MAX_CONCURRENT) {
        running += 1;
        return Promise.resolve(true);
    }
    if (waiters.length >= MAX_WAITERS || waitMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
        const waiter = { resolve: null, timer: null };
        waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            resolve(false);
        }, waitMs);
        waiter.resolve = () => { clearTimeout(waiter.timer); resolve(true); };
        waiters.push(waiter);
    });
}

function releaseSlot() {
    const next = waiters.shift();
    if (next) next.resolve(); // the slot passes straight to the next waiter
    else running = Math.max(0, running - 1);
}

async function runFetch(guild, entry, { timeoutMs, waitMs, now }) {
    if (!(await acquireSlot(waitMs))) return 'busy';
    entry.lastAttemptAt = now();
    let timer;
    try {
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        const outcome = await Promise.race([
            Promise.resolve()
                .then(() => guild.members.fetch({ time: timeoutMs }))
                .then(() => 'ok', (error) => {
                    if (isGatewayRateLimit(error)) {
                        const retryAfterMs = Math.max(0, Number(error.data?.retry_after) || 0) * 1000;
                        entry.retryAt = now() + Math.max(retryAfterMs, MIN_GAP_MS);
                        if (!entry.warnedAt || now() - entry.warnedAt >= RATE_LIMIT_WARN_MS) {
                            entry.warnedAt = now();
                            logger.warn(`Member fetch gate: Discord rate-limited the member list of guild ${guild.id}; using the cache and trying again later`);
                        }
                        return 'rate-limited';
                    }
                    if (error?.code === 'GuildMembersTimeout') return 'timeout';
                    logger.warn(`Member fetch gate: member fetch failed for guild ${guild.id}: ${error?.message || error}`);
                    return 'failed';
                }),
            timeout,
        ]);
        if (outcome === 'ok') entry.lastOkAt = now();
        if (outcome === 'timeout') logger.warn(`Member fetch gate: member fetch timed out for guild ${guild.id}`);
        return outcome;
    } finally {
        clearTimeout(timer);
        releaseSlot();
    }
}

/**
 * Fills guild.members.cache with one full member fetch when that is allowed and needed.
 * Options: maxAgeMs (reuse a fetch that finished within this; never below 60 s), timeoutMs,
 * waitMs (how long to wait for a free global slot), maxMembers (a lower size cap for this
 * caller), now (clock, tests). Never throws; see the file header for the result.
 */
export async function fetchAllMembers(guild, {
    maxAgeMs = MIN_GAP_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    waitMs = DEFAULT_WAIT_MS,
    maxMembers = Infinity,
    now = Date.now,
} = {}) {
    if (!guild?.members) return result(guild, 'no-guild');
    if (cacheIsComplete(guild)) return result(guild, 'cache', { partial: false });

    const total = Number(guild.memberCount) || 0;
    if (total > Math.min(fullFetchMaxMembers(), maxMembers)) return result(guild, 'too-large');

    const guildId = String(guild.id ?? 'unknown');
    const pending = inflight.get(guildId);
    if (pending) return outcomeResult(guild, await pending, true);

    const entry = entryOf(guildId);
    const t = now();
    if (entry.lastOkAt && t - entry.lastOkAt < Math.max(maxAgeMs, MIN_GAP_MS)) return result(guild, 'fresh', { partial: false });
    if (t < entry.retryAt) return result(guild, 'rate-limited');
    if (entry.lastAttemptAt && t - entry.lastAttemptAt < MIN_GAP_MS) return result(guild, 'cooldown');

    const promise = runFetch(guild, entry, { timeoutMs, waitMs, now });
    inflight.set(guildId, promise);
    try {
        return outcomeResult(guild, await promise, false);
    } finally {
        if (inflight.get(guildId) === promise) inflight.delete(guildId);
    }
}

function outcomeResult(guild, outcome, joined) {
    if (outcome === 'ok') return result(guild, joined ? 'fresh' : 'fetched', { fetched: true, partial: false });
    return result(guild, outcome);
}

/** Tests only: forget all per-guild state, slots and waiters. */
export function resetMemberFetchGate() {
    state.clear();
    inflight.clear();
    for (const waiter of waiters.splice(0)) waiter.resolve();
    running = 0;
}

/** Tests / diagnostics: current counters. */
export function memberFetchGateStats() {
    return { running, waiting: waiters.length, inflight: inflight.size, tracked: state.size };
}
