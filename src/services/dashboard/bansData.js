// bansData.js — the Banned page: everyone banned in the main server (Discord's ban list) joined
// with the open ban case, if the bot made the ban. listBans is pure (no Discord or database).

import { query, T } from '../enforcement/db.js';

export const BANS_PAGE_SIZE = 50;
export const BAN_FILTERS = {
    '': 'Everyone banned', case: 'With a case', nocase: 'Banned outside the bot',
    temporary: 'Temporary', permanent: 'Permanent', appeal: 'Appeal pending',
};

export const BAN_FETCH_PAGE = 1000; // Discord's maximum per request
export const BAN_LIST_CAP = 10_000; // ten requests at most; the page says when the list was cut
export const BAN_CACHE_TTL_MS = 60 * 1000;

/** The highest snowflake of a page (the `after` cursor for the next one). */
function maxId(ids) {
    let max = null;
    for (const id of ids) if (max === null || BigInt(id) > BigInt(max)) max = id;
    return max;
}

/**
 * Discord's ban list of a guild, paged with `after` (1,000 per request) up to `cap`:
 * { bans: [GuildBan], truncated } (truncated: there may be more than `cap`).
 */
export async function fetchBanList(guild, { cap = BAN_LIST_CAP, pageSize = BAN_FETCH_PAGE } = {}) {
    const bans = [];
    let after;
    for (;;) {
        const limit = Math.min(pageSize, cap - bans.length);
        if (limit <= 0) return { bans, truncated: true };
        const page = await guild.bans.fetch({ limit, cache: false, ...(after ? { after } : {}) });
        const entries = [...(page?.entries?.() || [])];
        for (const [, ban] of entries) bans.push(ban);
        if (entries.length < limit) return { bans, truncated: false };
        const next = maxId(entries.map(([id]) => id));
        if (!next || next === after) return { bans, truncated: false };
        after = next;
        if (bans.length >= cap) {
            // Exactly `cap` read: one more request of one ban tells whether anything is left.
            const more = await guild.bans.fetch({ limit: 1, cache: false, after });
            return { bans, truncated: Boolean(more?.size) };
        }
    }
}

/**
 * A per-guild TTL cache of fetchBanList (shared by the Banned page and the member search):
 * get(guild) → { bans, truncated, at }; invalidate(guildId) after a ban or unban from the
 * dashboard. Concurrent misses share one fetch. A failed fetch is not cached (it throws).
 */
export function createBanCache({ ttlMs = BAN_CACHE_TTL_MS, cap = BAN_LIST_CAP, now = () => Date.now(), fetchList = fetchBanList } = {}) {
    const entries = new Map(); // guildId → { at, value } | { pending }
    return {
        async get(guild) {
            const hit = entries.get(guild.id);
            if (hit?.value && now() - hit.at < ttlMs) return hit.value;
            if (hit?.pending) return hit.pending;
            const pending = fetchList(guild, { cap }).then((result) => {
                const value = { ...result, at: now() };
                entries.set(guild.id, { at: value.at, value });
                return value;
            }, (error) => {
                entries.delete(guild.id);
                throw error;
            });
            entries.set(guild.id, { ...(hit || {}), pending });
            return pending;
        },
        invalidate(guildId) {
            entries.delete(guildId);
        },
    };
}

/** The open ban case per banned member: Map(userId → case row). Test and voided cases excluded. */
export async function activeBanCases(guildId) {
    const { rows } = await query(
        `SELECT DISTINCT ON (target_user_id) target_user_id, case_code, name, reason, status, created_at, expires_at,
                is_auto, ladder_level_after, moderator_username
         FROM ${T.cases}
         WHERE guild_id = $1 AND type = 'ban' AND status IN ('active', 'appeal_pending') AND voided_at IS NULL
           AND is_test = FALSE AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY target_user_id, created_at DESC`,
        [guildId]
    );
    return new Map(rows.map((row) => [row.target_user_id, row]));
}

/**
 * Filter, sort (newest case first, then name) and page the bans.
 * bans: [{ user: { id, username, globalName, avatarUrl }, reason }]; cases: Map from activeBanCases.
 */
export function listBans(bans, cases, { q = '', filter = '', page = 0, pageSize = BANS_PAGE_SIZE } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    const rows = bans.map((ban) => {
        const record = cases.get(ban.user.id) || null;
        return {
            id: ban.user.id,
            username: ban.user.username || ban.user.id,
            displayName: ban.user.globalName || ban.user.username || ban.user.id,
            avatarUrl: ban.user.avatarUrl || null,
            reason: record?.reason || ban.reason || null,
            record,
            permanent: record ? !record.expires_at : null,
        };
    }).filter((row) => {
        if (needle && ![row.username, row.displayName, row.id].some((v) => String(v).toLowerCase().includes(needle))) return false;
        if (filter === 'case' && !row.record) return false;
        if (filter === 'nocase' && row.record) return false;
        if (filter === 'temporary' && !(row.record && !row.permanent)) return false;
        if (filter === 'permanent' && !(row.record && row.permanent)) return false;
        if (filter === 'appeal' && row.record?.status !== 'appeal_pending') return false;
        return true;
    });
    rows.sort((a, b) => (new Date(b.record?.created_at || 0) - new Date(a.record?.created_at || 0))
        || a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }));
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const current = Math.min(Math.max(0, page), pages - 1);
    return { rows: rows.slice(current * pageSize, current * pageSize + pageSize), total: rows.length, page: current, pages, banned: bans.length };
}
