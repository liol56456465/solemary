// appealStatusService.js: keeping the member informed while an appeal waits.
//
//   claimAppeal        "I'm looking at it" on the staff dossier: records who took it (once)
//                      and DMs the member that someone is reviewing it (no staff name).
//   remindStaleAppeals hourly: an appeal still pending after the configured quiet time
//                      (staleAppealReminderMs, 2 days unless changed) gets one DM to the member
//                      that it is still open. Staff get their own reminder from
//                      staleAppealService.js, so this one does not post in the staff channel.
//
// Columns on mod_appeals (schema v6): claimed_by, claimed_by_username, claimed_at, reminded_at.

import { logger } from '../../utils/logger.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { query as defaultQuery, T } from './db.js';

export const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
const staleAfter = () => (Number(enforcementConfig.staleAppealReminderMs) > 0 ? Number(enforcementConfig.staleAppealReminderMs) : STALE_AFTER_MS);

/** The DM a member gets when someone on the staff team takes their appeal. */
export function claimedDm(caseCode) {
    return `Someone on the staff team is now looking at your appeal for case \`${caseCode}\`. You'll get another DM when it's decided.`;
}

/** The DM a member gets when their appeal has waited 2 days. */
export function stillOpenDm(caseCode) {
    return `Your appeal for case \`${caseCode}\` is still open. Nobody has forgotten it; staff just haven't decided yet. You'll get a DM when they do.`;
}

async function dm(client, userId, content) {
    try {
        const user = await client.users.fetch(userId);
        await user.send({ content, allowedMentions: { parse: [] } });
        return true;
    } catch {
        return false;
    }
}

/**
 * Marks the pending appeal of a case as taken by `admin`. Returns
 * { status: 'claimed', dmDelivered } | { status: 'already', by } | { status: 'none' }.
 */
export async function claimAppeal({ client, admin, caseCode, query = defaultQuery }) {
    const { rows: [row] } = await query(
        `UPDATE ${T.appeals} SET claimed_by = $2, claimed_by_username = $3, claimed_at = NOW()
         WHERE case_code = $1 AND kind = 'appeal' AND status = 'pending' AND claimed_at IS NULL
         RETURNING user_id, case_code`,
        [caseCode, admin.id, admin.username],
    );
    if (!row) {
        const { rows: [pending] } = await query(
            `SELECT claimed_by_username FROM ${T.appeals} WHERE case_code = $1 AND kind = 'appeal' AND status = 'pending'`,
            [caseCode],
        );
        return pending ? { status: 'already', by: pending.claimed_by_username || 'someone' } : { status: 'none' };
    }
    const dmDelivered = await dm(client, row.user_id, claimedDm(caseCode));
    return { status: 'claimed', dmDelivered };
}

/** Hourly. Each stale appeal's member is told once (reminded_at set first). Never throws. */
export async function remindStaleAppeals(client, { query = defaultQuery, now = Date.now() } = {}) {
    try {
        const { rows } = await query(
            `UPDATE ${T.appeals} SET reminded_at = NOW()
             WHERE id IN (
                 SELECT id FROM ${T.appeals}
                 WHERE kind = 'appeal' AND status = 'pending' AND reminded_at IS NULL AND created_at <= $1
                 ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED
             ) RETURNING case_code, user_id`,
            [new Date(now - staleAfter())],
        );
        for (const row of rows) await dm(client, row.user_id, stillOpenDm(row.case_code));
        return rows.length;
    } catch (error) {
        logger.error(`Appeal reminders: ${error.message}`);
        return 0;
    }
}
