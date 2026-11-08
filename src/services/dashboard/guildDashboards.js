// guildDashboards.js — one dashboard instance per server (multi-server B3, docs/multi-server-b3.md
// section 0). routes.js createDashboard({ guildId }) binds every handler to one server; this
// registry builds those instances on first use and keeps them in a bounded LRU (500 servers,
// dropped after 2 h without a request). A dropped instance is rebuilt on the next request:
// it holds no state of its own that matters (sessions, OAuth states, rate limiters, the audit
// store, the confirm-token store and member search are shared and passed in by routes.js).
//
// Isolation by construction: a request under /dashboard/<A>/… only ever reaches the instance
// bound to A, so a case code, member id or rule id from server B is looked up in A (and not
// found). The shared confirm-token store is scoped per server (scopedConfirms), so a preview
// made in server A can never be confirmed in server B.

export const MAX_GUILD_DASHBOARDS = 500;
export const GUILD_DASHBOARD_IDLE_MS = 2 * 60 * 60 * 1000;

/**
 * A small LRU map with a timeout: get(key) refreshes the entry (idle timeout), or with
 * `absolute` keeps the time it was set (dropped `ttlMs` after set, however often it is read).
 * Above `max` the least recently used goes first. Expired entries are swept on set and, at most
 * once per `sweepMs`, on get too (so entries nobody asks for again do not stay in memory).
 */
export function createLruCache({ max = 1000, ttlMs = Infinity, now = () => Date.now(), absolute = false, sweepMs = 60 * 1000 } = {}) {
    const entries = new Map(); // key → { value, at }
    let swept = 0;
    function sweep(at) {
        swept = at;
        if (Number.isFinite(ttlMs)) for (const [key, entry] of entries) if (at - entry.at >= ttlMs) entries.delete(key);
        while (entries.size > max) entries.delete(entries.keys().next().value);
    }
    return {
        get(key) {
            const at = now();
            if (Number.isFinite(ttlMs) && at - swept >= sweepMs) sweep(at);
            const entry = entries.get(key);
            if (!entry) return undefined;
            if (at - entry.at >= ttlMs) {
                entries.delete(key);
                return undefined;
            }
            entries.delete(key);
            entries.set(key, { value: entry.value, at: absolute ? entry.at : at });
            return entry.value;
        },
        set(key, value) {
            const at = now();
            entries.delete(key);
            entries.set(key, { value, at });
            sweep(at);
            return value;
        },
        delete: (key) => entries.delete(key),
        has: (key) => entries.has(key),
        size: () => entries.size,
        keys: () => [...entries.keys()],
        clear: () => entries.clear(),
    };
}

/**
 * The confirm-token store (confirmTokens.js) seen from one server: every subject is prefixed
 * with `<guildId>:`, so a token issued in one server's instance never matches in another.
 */
export function scopedConfirms(store, guildId) {
    const prefix = `${guildId}:`;
    return {
        issue: ({ subject, ...rest }, ...more) => store.issue({ ...rest, subject: `${prefix}${subject}`, scope: String(guildId) }, ...more),
        consume: (token, { subject, ...rest } = {}, ...more) => store.consume(token, { ...rest, subject: `${prefix}${subject}` }, ...more),
        size: () => store.size(),
        guildId: String(guildId),
    };
}

/**
 * The registry: get(guildId) → the instance for that server (built by `build(guildId)` once,
 * then cached). The caller validates the id first (snowflake, bot in the server, not blacklisted).
 */
export function createGuildDashboards({ build, max = MAX_GUILD_DASHBOARDS, idleMs = GUILD_DASHBOARD_IDLE_MS, now } = {}) {
    if (typeof build !== 'function') throw new TypeError('createGuildDashboards needs a build(guildId) function');
    const cache = createLruCache({ max, ttlMs: idleMs, now });
    return {
        get(guildId) {
            const id = String(guildId);
            return cache.get(id) ?? cache.set(id, build(id));
        },
        /** The cached instance without building one (null when none). */
        peek: (guildId) => cache.get(String(guildId)) ?? null,
        forget: (guildId) => cache.delete(String(guildId)),
        size: () => cache.size(),
        ids: () => cache.keys(),
    };
}
