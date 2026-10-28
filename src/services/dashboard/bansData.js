// bansData.js — the Banned page: everyone banned in the main server (Discord's ban list) joined
// with the open ban case, if the bot made the ban. listBans is pure (no Discord or database).

import { query, T } from '../enforcement/db.js';

export const BANS_PAGE_SIZE = 50;
export const BAN_FILTERS = {
    '': 'Everyone banned', case: 'With a case', nocase: 'Banned outside the bot',
    temporary: 'Temporary', permanent: 'Permanent', appeal: 'Appeal pending',
};

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
