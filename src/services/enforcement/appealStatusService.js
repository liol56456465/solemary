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
import { SettingsUnavailableError, guildIdFor, isHomeGuild, resolveSetting } from '../settings/guildSettings.js';
import { query as defaultQuery, T } from './db.js';

export const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * The quiet time before a pending appeal of this server gets the "still open" DM. Home servers
 * use the main server's setting (as before); any other server its own. Throws
 * SettingsUnavailableError when another server's settings could not be read.
 */
export function staleAfter(guildId) {
    const settingsGuild = isHomeGuild(guildId) ? guildIdFor('main') || guildId : guildId;
    const ms = Number(resolveSetting(settingsGuild, 'staleAppealReminderMs'));
    return ms > 0 ? ms : STALE_AFTER_MS;
}

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

/**
 * Hourly. Each stale appeal's member is told once (reminded_at set first), with each server's
 * own quiet time. A server whose settings cannot be read is skipped this run. Never throws.
 */
export async function remindStaleAppeals(client, { query = defaultQuery, now = Date.now() } = {}) {
    let guilds;
    try {
        ({ rows: guilds } = await query(
            `SELECT DISTINCT guild_id FROM ${T.appeals}
             WHERE kind = 'appeal' AND status = 'pending' AND reminded_at IS NULL`,
        ));
    } catch (error) {
        logger.error(`Appeal reminders: ${error.message}`);
        return 0;
    }
    let reminded = 0;
    for (const { guild_id: guildId } of guilds) {
        try {
            const { rows } = await query(
                `UPDATE ${T.appeals} SET reminded_at = NOW()
                 WHERE id IN (
                     SELECT id FROM ${T.appeals}
                     WHERE kind = 'appeal' AND status = 'pending' AND reminded_at IS NULL AND created_at <= $1
                       AND guild_id = $2
                     ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED
                 ) RETURNING case_code, user_id`,
                [new Date(now - staleAfter(guildId)), guildId],
            );
            for (const row of rows) await dm(client, row.user_id, stillOpenDm(row.case_code));
            reminded += rows.length;
        } catch (error) {
            if (error instanceof SettingsUnavailableError) logger.warn(`Appeal reminders: skipped guild ${guildId} this run (${error.message})`);
            else logger.error(`Appeal reminders (guild ${guildId}): ${error.message}`);
        }
    }
    return reminded;
}
