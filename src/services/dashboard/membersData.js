// membersData.js — the Members list of the dashboard: every member of the main server from the
// member cache, with the warn ladder and active mutes from the database, filtered, sorted and
// paged. listMembers is pure (no Discord or database calls), so it is tested directly.

import { query, T } from '../enforcement/db.js';

export const MEMBERS_PAGE_SIZE = 50;
export const JOINED_FILTERS = { '': 'Any time', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', older: 'Over 30 days ago' };
export const STATE_FILTERS = {
    '': 'Everyone', sanction: 'Muted now', warned: 'Has counted warns', noroles: 'No roles', humans: 'People only', bots: 'Bots only',
};
export const SORTS = { joined_desc: 'Newest first', joined_asc: 'Oldest first', name: 'Name A–Z' };
const JOINED_MS = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };

/**
 * Warn ladder and active mutes for the whole guild (two small queries):
 * { ladder: Map(userId → { level, warns }), muted: Set(userId) }.
 */
export async function memberStandings(guildId) {
    const [ladder, muted] = await Promise.all([
        query(`SELECT user_id, level, warns_since_level FROM ${T.ladder} WHERE guild_id = $1 AND (level > 0 OR warns_since_level > 0)`, [guildId]),
        query(`SELECT DISTINCT target_user_id FROM ${T.cases}
               WHERE guild_id = $1 AND type = 'mute' AND status IN ('active', 'appeal_pending') AND voided_at IS NULL
                 AND is_test = FALSE AND (expires_at IS NULL OR expires_at > NOW())`, [guildId]),
    ]);
    return {
        ladder: new Map(ladder.rows.map((r) => [r.user_id, { level: Number(r.level), warns: Number(r.warns_since_level) }])),
        muted: new Set(muted.rows.map((r) => r.target_user_id)),
    };
}

/** The member's roles without @everyone, highest first: [{ id, name }]. */
function rolesOf(member, guildId) {
    const roles = member.roles?.cache ? [...member.roles.cache.values()] : [];
    return roles.filter((r) => r.id !== guildId).sort((a, b) => (b.position || 0) - (a.position || 0)).map((r) => ({ id: r.id, name: r.name }));
}

/** One list row from a cached member. */
export function memberRow(member, guildId, standings) {
    const user = member.user || {};
    const id = user.id || member.id;
    const ladder = standings?.ladder?.get(id) || { level: 0, warns: 0 };
    return {
        id,
        username: user.username || id,
        displayName: member.nickname || user.globalName || user.username || id,
        bot: Boolean(user.bot),
        avatarUrl: typeof member.displayAvatarURL === 'function' ? member.displayAvatarURL({ size: 64 }) : null,
        joinedAt: member.joinedTimestamp || null,
        roles: rolesOf(member, guildId),
        level: ladder.level,
        warns: ladder.warns,
        muted: Boolean(standings?.muted?.has(id)),
    };
}

/**
 * Filter, sort and page the cached members. options: { q, role, joined, state, sort, page, pageSize, now }.
 * Returns { rows, total, page, pages, cached, memberCount }.
 */
export function listMembers(guild, standings, { q = '', role = '', joined = '', state = '', sort = 'joined_desc', page = 0, pageSize = MEMBERS_PAGE_SIZE, now = Date.now() } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    const all = [...(guild?.members?.cache?.values?.() || [])].map((m) => memberRow(m, guild.id, standings));
    const rows = all.filter((row) => {
        if (needle && ![row.username, row.displayName, row.id].some((v) => String(v).toLowerCase().includes(needle))) return false;
        if (role && !row.roles.some((r) => r.id === role)) return false;
        if (joined === 'older') { if (!row.joinedAt || now - row.joinedAt < JOINED_MS['30d']) return false; }
        else if (JOINED_MS[joined] && (!row.joinedAt || now - row.joinedAt > JOINED_MS[joined])) return false;
        if (state === 'sanction' && !row.muted) return false;
        if (state === 'warned' && !(row.warns > 0 || row.level > 0)) return false;
        if (state === 'noroles' && row.roles.length) return false;
        if (state === 'humans' && row.bot) return false;
        if (state === 'bots' && !row.bot) return false;
        return true;
    });
    const byName = (a, b) => a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' });
    if (sort === 'name') rows.sort(byName);
    else if (sort === 'joined_asc') rows.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || byName(a, b));
    else rows.sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0) || byName(a, b));
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const current = Math.min(Math.max(0, page), pages - 1);
    return {
        rows: rows.slice(current * pageSize, current * pageSize + pageSize),
        total: rows.length, page: current, pages,
        cached: all.length, memberCount: guild?.memberCount ?? null,
    };
}
