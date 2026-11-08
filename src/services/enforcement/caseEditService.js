// caseEditService.js — /case edit | void | history.
//
// Edits change a case's reason or (for open bans and mutes) its duration, and keep
// every change in mod_case_edits. Voiding marks a case as a mistake: it is lifted
// like an accepted appeal (unban/unmute, warn revoked, ladder stepped back), then
// stamped voided_at so it no longer counts anywhere. The row keeps status 'revoked'.
// Both run under the same per-user lock as the panel, expiry and appeals.

import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { query, withTransaction, T } from './db.js';
import { getCaseByCode, setEndDmDelivered, OPEN_STATUSES } from './caseService.js';
import { createRejoinInvite, lockFor, postModLog, sendCaseDm } from './enforcementService.js';
import { liftCase, liftNoteText } from './appealService.js';
import { liftExpired } from './expiryService.js';
import { syncWarnRolesQuietly } from './warnRoleService.js';
import { syncBannedRoleQuietly } from './bannedRoleService.js';
import { durationIn } from './dmTemplates.js';
import { botText, textForGuild } from '../../utils/botText.js';
import { dateStamp, formatDuration, parseDuration, truncate } from './format.js';

// `i18n` ({ code, params }): /case shows the error in the reader's language (commands/Enforcement/case.js).
function userError(message, i18n = null) {
    const error = createError(message, ErrorTypes.VALIDATION, message, { expected: true });
    if (i18n) error.i18n = i18n;
    return error;
}

async function loadCase(guildId, caseCode) {
    const record = await getCaseByCode(caseCode, guildId);
    if (!record || record.guild_id !== guildId) {
        throw userError(`No case with code \`${caseCode}\` in this server.`, { code: 'noCase', params: { code: caseCode } });
    }
    return record;
}

/** Display text for a stored duration value (ms as text, or null = permanent); `lang` for the bot's words. */
export function describeDuration(value, { lang = 'en' } = {}) {
    if (lang !== 'en') return durationIn(value == null ? null : Number(value), lang);
    return value == null ? 'Permanent' : formatDuration(Number(value));
}

/**
 * A typed new duration for /case edit and the dashboard: "permanent" (perm, forever)
 * → null; a duration (30m, 24h, 7d, 2w, 1mo) → ms; blank → undefined (unchanged).
 * Anything else throws a user error.
 */
export function parseEditDuration(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return undefined;
    if (/^(perm|permanent|forever)$/i.test(raw)) return null;
    const ms = parseDuration(raw);
    if (ms == null) throw userError('Duration must look like 30m, 24h, 7d, 2w, 1mo (or "permanent" for a ban).', { code: 'badDuration', params: {} });
    return ms;
}

/** Autocomplete: cases in this guild whose code or name matches, newest first. */
export async function searchCases(guildId, text, limit = 25) {
    const pattern = `%${String(text || '').replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const { rows } = await query(
        `SELECT case_code, name, type, target_username, voided_at FROM ${T.cases}
         WHERE guild_id = $1 AND (case_code ILIKE $2 OR name ILIKE $2 OR target_username ILIKE $2)
         ORDER BY created_at DESC LIMIT $3`,
        [guildId, pattern, limit]
    );
    return rows;
}

export async function getCaseEdits(caseCode, limit = 25) {
    const { rows } = await query(
        `SELECT * FROM ${T.caseEdits} WHERE case_code = $1 ORDER BY edited_at DESC, id DESC LIMIT $2`,
        [caseCode, limit]
    );
    return rows;
}

export async function countCaseEdits(caseCode) {
    const { rows } = await query(`SELECT COUNT(*)::int AS count FROM ${T.caseEdits} WHERE case_code = $1`, [caseCode]);
    return rows[0]?.count || 0;
}

/**
 * Edits a case. `reason` undefined = unchanged. `durationMs` undefined = unchanged,
 * null = permanent (bans only). The new end is created_at + duration; an end that is
 * already past is lifted by the expiry job on its next run.
 * Returns { before, after, changes: [{ field, oldValue, newValue }] }.
 */
export async function editCase(client, { guildId, caseCode, editor, reason, durationMs }) {
    const found = await loadCase(guildId, caseCode);

    const result = await lockFor(guildId, found.target_user_id, () => withTransaction(async (db) => {
        const { rows: [row] } = await db.query(`SELECT * FROM ${T.cases} WHERE id = $1 FOR UPDATE`, [found.id]);
        if (!row) throw userError(`No case with code \`${caseCode}\` in this server.`, { code: 'noCase', params: { code: caseCode } });
        if (row.voided_at) throw userError(`\`${caseCode}\` was removed (a mistake) and can no longer be edited.`, { code: 'editVoided', params: { code: caseCode } });

        const changes = [];
        let newReason = row.reason;
        let newDuration = row.duration_ms;
        let newExpires = row.expires_at;

        if (reason !== undefined && reason !== row.reason) {
            newReason = reason;
            changes.push({ field: 'reason', oldValue: row.reason, newValue: reason });
        }

        if (durationMs !== undefined) {
            if (row.type !== 'ban' && row.type !== 'mute') {
                throw userError(`Only bans and mutes have a duration; \`${caseCode}\` is a ${row.type}.`, { code: 'noDurationType', params: { code: caseCode, type: row.type } });
            }
            if (row.is_auto) {
                throw userError('Automatic warn-ladder bans keep their ladder duration. Remove the case (if it was a mistake) or unban instead.', { code: 'ladderDuration', params: {} });
            }
            if (row.is_imported) {
                throw userError('Imported cases cannot change duration.', { code: 'importedDuration', params: {} });
            }
            if (!OPEN_STATUSES.includes(row.status)) {
                throw userError(`\`${caseCode}\` has already ended (${row.status}); only open bans and mutes can change duration.`, { code: 'endedDuration', params: { code: caseCode, status: row.status } });
            }
            if (durationMs === null && row.type === 'mute') {
                throw userError('A mute needs a duration (e.g. 30m, 24h, 7d).', { code: 'muteNeedsDuration', params: {} });
            }
            const oldMs = row.duration_ms == null ? null : Number(row.duration_ms);
            if (durationMs !== oldMs) {
                newDuration = durationMs;
                newExpires = durationMs == null ? null : new Date(new Date(row.created_at).getTime() + durationMs);
                changes.push({
                    field: 'duration',
                    oldValue: oldMs == null ? null : String(oldMs),
                    newValue: durationMs == null ? null : String(durationMs),
                });
            }
        }

        if (changes.length === 0) {
            throw userError('Nothing to change: give a new reason or duration that differs from the current one.', { code: 'nothingToChange', params: {} });
        }

        const { rows: [after] } = await db.query(
            `UPDATE ${T.cases} SET reason = $2, duration_ms = $3, expires_at = $4 WHERE id = $1 RETURNING *`,
            [row.id, newReason, newDuration, newExpires]
        );
        for (const change of changes) {
            await db.query(
                `INSERT INTO ${T.caseEdits} (case_code, edited_by, edited_by_username, field, old_value, new_value)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [row.case_code, editor.id, editor.username, change.field, change.oldValue, change.newValue]
            );
        }
        return { before: row, after, changes };
    }));

    if (!result.after.is_test && client) {
        // A staff-channel post: the server's language (utils/botText.js mixed rule).
        const tr = textForGuild(result.after.guild_id, { userId: result.after.target_user_id, purpose: 'public' });
        const lang = tr.lang;
        await postModLog(client, 'caseedit', [
            { name: tr.t('staff.case.log.case'), value: `\`${result.after.case_code}\` · ${truncate(result.after.name, 200)} (${result.after.type})` },
            { name: tr.t('staff.case.log.user'), value: `${result.after.target_username} (${result.after.target_user_id})` },
            { name: tr.t('staff.case.log.editedBy'), value: `${editor.username} (${editor.id})` },
            ...result.changes.map((change) => ({
                name: change.field === 'reason' ? tr.t('staff.case.log.reason') : tr.t('staff.case.log.duration'),
                value: truncate(change.field === 'reason'
                    ? `${change.oldValue} → ${change.newValue}`
                    : `${describeDuration(change.oldValue, { lang })} → ${describeDuration(change.newValue, { lang })}${result.after.expires_at ? tr.t('staff.case.log.endsSuffix', { date: dateStamp(result.after.expires_at) }) : ''}`, 1024),
            })),
        ], { guildId: result.after.guild_id, title: tr.t('staff.case.log.editedTitle') });
    }
    return result;
}

async function isBanned(guild, userId) {
    if (!guild) return false;
    return Boolean(await guild.bans.fetch({ user: userId, force: true }).catch(() => null));
}

/**
 * Voids a case: lifts what is still in effect (via liftCase), then marks it voided.
 * Cases that already ended are only marked (an old ladder step is not rewound).
 * Returns { record, notes, dmDelivered }.
 */
export async function voidCase(client, { guildId, caseCode, admin, reason, lang = 'en' }) {
    const found = await loadCase(guildId, caseCode);
    const mainGuild = client.guilds.cache.get(guildId) || null;

    return lockFor(guildId, found.target_user_id, async () => {
        let record = await loadCase(guildId, caseCode);
        if (record.voided_at) throw userError(`\`${caseCode}\` is already removed.`, { code: 'alreadyRemoved', params: { code: caseCode } });

        // A ban/mute past its end that the expiry job has not reached yet: lift it the
        // normal way first, or the voided row would leave the user banned/muted.
        if (OPEN_STATUSES.includes(record.status) && (record.type === 'ban' || record.type === 'mute')
            && record.expires_at && new Date(record.expires_at) <= new Date() && mainGuild) {
            await liftExpired(client, mainGuild, record);
            record = await loadCase(guildId, caseCode);
        }

        const wasOpen = OPEN_STATUSES.includes(record.status);
        const bannedBefore = !record.is_test && await isBanned(mainGuild, record.target_user_id);
        const notes = [];
        // This service's own notes: `notes` (returned) in the caller's language, the mod log in the server's.
        const logTr = textForGuild(record.guild_id, { userId: record.target_user_id, purpose: 'public' });
        const replyTr = botText(lang);
        const logNotes = [];

        if (wasOpen) {
            const lifted = await liftCase(client, record, admin, {
                reason: `Removed (a mistake) by ${admin.username}: ${reason}`,
                via: 'case remove',
                entries: true,
            });
            notes.push(...lifted.map((entry) => liftNoteText(entry, replyTr.lang)));
            logNotes.push(...lifted.map((entry) => liftNoteText(entry, logTr.lang)));
        } else if (record.status === 'expired') {
            notes.push(replyTr.t('staff.case.remove.alreadyEnded'));
            logNotes.push(logTr.t('staff.case.remove.alreadyEnded'));
        } else {
            notes.push(replyTr.t('staff.case.remove.alreadyLifted'));
            logNotes.push(logTr.t('staff.case.remove.alreadyLifted'));
        }

        const { rows: [voided] } = await query(
            `UPDATE ${T.cases}
             SET status = 'revoked', voided_at = NOW(), voided_by = $2, void_reason = $3,
                 revoked_by = COALESCE(revoked_by, $2), revoked_at = COALESCE(revoked_at, NOW()),
                 revoke_reason = COALESCE(revoke_reason, $4)
             WHERE id = $1 AND voided_at IS NULL
             RETURNING *`,
            [record.id, admin.id, reason, `Removed (a mistake) by ${admin.username}: ${reason}`]
        );
        if (!voided) throw userError(`\`${caseCode}\` is already removed.`, { code: 'alreadyRemoved', params: { code: caseCode } });

        if (!record.is_test && mainGuild) {
            await syncWarnRolesQuietly(mainGuild, record.target_user_id);
        }
        if (!record.is_test) await syncBannedRoleQuietly(client, record.target_user_id);

        const unbanned = bannedBefore && !(await isBanned(mainGuild, record.target_user_id));
        const invite = unbanned && mainGuild ? await createRejoinInvite(mainGuild, `Case ${caseCode} removed (a mistake)`) : null;
        const user = await client.users.fetch(record.target_user_id).catch(() => null);
        const dmDelivered = user ? await sendCaseDm(user, 'enf.caseVoided', record, { guild: mainGuild ?? null, guildId: record.guild_id, reason, invite }) : false;
        if (!dmDelivered) logger.info(`Void DM for ${caseCode} to ${record.target_user_id} not delivered`);

        // The void DM is also the "ban/mute ended" notice when it lifted one.
        const liftedTimed = wasOpen && !record.is_test && (record.type === 'ban' || record.type === 'mute')
            && (!record.expires_at || new Date(record.expires_at) > new Date());
        if (liftedTimed) {
            await setEndDmDelivered([record.id], dmDelivered).catch((error) =>
                logger.warn(`Could not record end DM for ${caseCode}: ${error.message}`));
        }

        if (!record.is_test) {
            await postModLog(client, 'casevoid', [
                { name: logTr.t('staff.case.log.case'), value: `\`${record.case_code}\` · ${truncate(record.name, 200)} (${record.type})` },
                { name: logTr.t('staff.case.log.user'), value: `${record.target_username} (${record.target_user_id})` },
                { name: logTr.t('staff.case.log.removedBy'), value: `${admin.username} (${admin.id})` },
                { name: logTr.t('staff.case.log.reason'), value: truncate(reason, 1024) },
                ...(logNotes.length ? [{ name: logTr.t('staff.case.log.effect'), value: truncate(logNotes.join('\n'), 1024) }] : []),
                { name: logTr.t('staff.case.log.dm'), value: dmDelivered ? logTr.t('staff.case.log.delivered') : logTr.t('staff.case.log.notDelivered') },
            ], { guildId: record.guild_id, title: logTr.t('staff.case.log.removedTitle') });
        }
        return { record: voided, notes, dmDelivered };
    });
}
