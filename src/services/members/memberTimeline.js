// memberTimeline.js: one member's history in date order for the dashboard member page.
// Joins and leaves (member_events, 90 days), cases given and when they were lifted or voided
// (mod_cases), appeals filed and decided (mod_appeals), verification steps
// (verification_audit). Newest first. Staff-only page; nothing here is new data.

import { pgConfig } from '../../config/database/postgres.js';
import { query as defaultQuery } from '../enforcement/db.js';

export const TIMELINE_LIMIT = 60;

/** [{ at: Date, kind, text, code? }], newest first, at most `limit`. Throws on a database error. */
// Staff reports are for administrators only (like the Inbox): includeReports must be true to
// list them; moderators get appeals only.
export async function memberTimeline(guildId, userId, { limit = TIMELINE_LIMIT, query = defaultQuery, includeReports = false } = {}) {
    const t = pgConfig.tables;
    const [events, cases, appeals, verification] = await Promise.all([
        query(`SELECT kind, created_at FROM ${t.member_events} WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`, [guildId, userId, limit]),
        query(`SELECT case_code, type, name, reason, moderator_username, created_at, revoked_at, voided_at, is_auto
               FROM ${t.mod_cases} WHERE guild_id = $1 AND target_user_id = $2 AND is_test IS NOT TRUE ORDER BY created_at DESC LIMIT $3`, [guildId, userId, limit]),
        query(`SELECT case_code, kind, status, created_at, decided_at, decided_by_username FROM ${t.mod_appeals}
               WHERE guild_id = $1 AND user_id = $2 AND (kind <> 'report' OR $4::boolean) ORDER BY created_at DESC LIMIT $3`, [guildId, userId, limit, Boolean(includeReports)]),
        query(`SELECT action, created_at FROM ${t.verification_audit} WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`, [guildId, userId, limit]),
    ]);
    const out = [];
    for (const r of events.rows) out.push({ at: new Date(r.created_at), kind: r.kind, text: r.kind === 'join' ? 'Joined the server' : 'Left the server' });
    for (const r of cases.rows) {
        out.push({ at: new Date(r.created_at), kind: 'case', code: r.case_code, text: `${r.type} by ${r.is_auto ? 'automod or the ladder' : r.moderator_username}: ${r.reason}` });
        if (r.voided_at) out.push({ at: new Date(r.voided_at), kind: 'voided', code: r.case_code, text: `${r.type} voided` });
        else if (r.revoked_at) out.push({ at: new Date(r.revoked_at), kind: 'lifted', code: r.case_code, text: `${r.type} lifted` });
    }
    for (const r of appeals.rows) {
        if (r.kind === 'report' && !includeReports) continue; // second guard, after the SQL filter
        const what = r.kind === 'report' ? 'Staff report' : 'Appeal';
        out.push({ at: new Date(r.created_at), kind: r.kind, code: r.kind === 'appeal' ? r.case_code : null, text: `${what} filed` });
        if (r.decided_at) out.push({ at: new Date(r.decided_at), kind: r.kind, code: r.kind === 'appeal' ? r.case_code : null, text: `${what} ${r.status}${r.decided_by_username ? ` by ${r.decided_by_username}` : ''}` });
    }
    for (const r of verification.rows) out.push({ at: new Date(r.created_at), kind: 'verification', text: `Verification: ${String(r.action).replace(/_/g, ' ')}` });
    return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
