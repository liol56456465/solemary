// caseErase.js — "Erase a case" for a privacy request (GDPR Art. 17), Owner area only
// (dashboard /owner/erase). It only runs when a bot owner confirms it on the dashboard.
//
// What happens to the case:
//   - An active ladder warn (type warn, status active / appeal_pending, not imported, not a
//     test case) stays as a row so the warn ladder does not silently change: its reason, name,
//     revoke / void reasons, prebuilt reason key and tags, the note texts, the edit history
//     values and its appeals' text are replaced with REMOVED; its evidence rows are deleted.
//   - Any other case is deleted with its notes, evidence, edit history and appeals.
// Refused (nothing changes): an unknown code; an appeal still pending (decide it first); a ban
// or mute not lifted yet, even past its end (the expiry job and the Banned role need the case).
// Dashboard audit rows of the case (module 'cases', key '<code>.…') keep who/when; their values
// are replaced with REMOVED.
// Images re-hosted in the evidence channel are Discord messages: the caller deletes them
// after the commit (evidenceMessages), best effort.
// Everything runs in one transaction with the case row locked (SELECT ... FOR UPDATE).

import { pgConfig } from '../../config/database/postgres.js';
import { OPEN_STATUSES } from '../enforcement/caseService.js';
import { normalizeCaseCode } from '../enforcement/format.js';
import { markOwnDelete } from '../logTamperService.js';

export const REMOVED = '[removed on request]';

/** Whether a case stays (anonymised) or goes, or why it cannot be erased now. */
export function erasePlan(row, { pendingAppeal = false, now = Date.now() } = {}) {
    if (!row) return { mode: null, refusal: 'There is no case with that code.' };
    const open = OPEN_STATUSES.includes(row.status);
    if (pendingAppeal || row.status === 'appeal_pending') {
        return { mode: null, refusal: 'An appeal of this case is still pending. Decide it first, then erase the case.' };
    }
    // Open = not lifted yet, even past expires_at: the expiry job lifts it in Discord first and
    // closes the case after, so a deleted open case would leave the member banned / muted.
    const inForce = open && !row.is_test && (row.type === 'ban' || row.type === 'mute');
    if (inForce) {
        return { mode: null, refusal: `This ${row.type} is still in force. Lift it first (the bot needs the case to end it), then erase the case.` };
    }
    const ladderWarn = row.type === 'warn' && open && !row.is_imported && !row.is_test;
    return { mode: ladderWarn ? 'anonymise' : 'delete', refusal: null };
}

async function load(run, code, tables, { lock = false } = {}) {
    const { rows: [row] } = await run(`SELECT * FROM ${tables.mod_cases} WHERE case_code = $1${lock ? ' FOR UPDATE' : ''}`, [code]);
    if (!row) return { row: null, counts: null, pendingAppeal: false };
    const { rows: [c] } = await run(
        `SELECT (SELECT COUNT(*)::int FROM ${tables.mod_case_notes} WHERE case_code = $1) AS notes,
                (SELECT COUNT(*)::int FROM ${tables.mod_case_evidence} WHERE case_code = $1) AS evidence,
                (SELECT COUNT(*)::int FROM ${tables.mod_case_edits} WHERE case_code = $1) AS edits,
                (SELECT COUNT(*)::int FROM ${tables.mod_appeals} WHERE case_code = $1) AS appeals,
                EXISTS (SELECT 1 FROM ${tables.mod_appeals} WHERE case_code = $1 AND kind = 'appeal' AND status = 'pending') AS pending`,
        [code]);
    return { row, counts: { notes: c.notes, evidence: c.evidence, edits: c.edits, appeals: c.appeals }, pendingAppeal: c.pending };
}

/**
 * For the confirm page: { code, case, counts, mode, refusal }. code null = not a case code.
 * Throws on a database error.
 */
export async function previewCaseErase(rawCode, { query, tables = pgConfig.tables, now = Date.now() }) {
    const code = normalizeCaseCode(String(rawCode || ''));
    if (!code) return { code: null, case: null, counts: null, mode: null, refusal: 'That is not a case code (5 to 7 letters and digits).' };
    const { row, counts, pendingAppeal } = await load(query, code, tables);
    const plan = erasePlan(row, { pendingAppeal, now });
    return { code, case: row, counts, ...plan };
}

/**
 * Erases the case. Returns { code, mode, guildId, type, counts, evidenceMessages: [{ channelId,
 * messageId }] } or { refusal } when it cannot be erased now. Throws on a database error
 * (rolled back: nothing changed).
 */
export async function eraseCase(rawCode, { withTransaction, tables = pgConfig.tables, now = Date.now() }) {
    const code = normalizeCaseCode(String(rawCode || ''));
    if (!code) return { refusal: 'That is not a case code (5 to 7 letters and digits).' };
    return withTransaction(async (client) => {
        const run = (text, params) => client.query(text, params);
        const { row, counts, pendingAppeal } = await load(run, code, tables, { lock: true });
        const plan = erasePlan(row, { pendingAppeal, now });
        if (plan.refusal) return { refusal: plan.refusal };

        const { rows: evidence } = await run(
            `DELETE FROM ${tables.mod_case_evidence} WHERE case_code = $1 RETURNING store_channel_id, store_message_id`, [code]);
        // Dashboard audit rows of this case (reason edits, void reasons, evidence links): the
        // values are replaced, the rows (who did what, when) stay.
        await run(
            `UPDATE ${tables.dashboard_audit} SET old = CASE WHEN old IS NULL THEN NULL ELSE to_jsonb($2::text) END,
                    new = CASE WHEN new IS NULL THEN NULL ELSE to_jsonb($2::text) END
             WHERE module = 'cases' AND (key = $1 OR key LIKE $1 || '.%')`,
            [code, REMOVED]);
        const evidenceMessages = evidence.filter((e) => e.store_channel_id && e.store_message_id)
            .map((e) => ({ channelId: e.store_channel_id, messageId: e.store_message_id }));

        if (plan.mode === 'anonymise') {
            await run(
                `UPDATE ${tables.mod_cases} SET reason = $2, name = $3, reason_key = NULL, prebuilt_or_custom = 'custom', tags = '{}',
                        revoke_reason = CASE WHEN revoke_reason IS NULL THEN NULL ELSE $2 END,
                        void_reason = CASE WHEN void_reason IS NULL THEN NULL ELSE $2 END
                 WHERE case_code = $1`,
                [code, REMOVED, `Removed on request (${code})`]);
            await run(`UPDATE ${tables.mod_case_notes} SET text = $2 WHERE case_code = $1`, [code, REMOVED]);
            await run(
                `UPDATE ${tables.mod_case_edits} SET old_value = CASE WHEN old_value IS NULL THEN NULL ELSE $2 END,
                        new_value = CASE WHEN new_value IS NULL THEN NULL ELSE $2 END WHERE case_code = $1`,
                [code, REMOVED]);
            await run(
                `UPDATE ${tables.mod_appeals} SET body = '{}'::jsonb, note = CASE WHEN note IS NULL THEN NULL ELSE $2 END WHERE case_code = $1`,
                [code, REMOVED]);
        } else {
            // mod_appeals.case_code has no ON DELETE CASCADE: its rows go first.
            await run(`DELETE FROM ${tables.mod_appeals} WHERE case_code = $1`, [code]);
            await run(`DELETE FROM ${tables.mod_case_notes} WHERE case_code = $1`, [code]);
            await run(`DELETE FROM ${tables.mod_case_edits} WHERE case_code = $1`, [code]);
            const { rowCount } = await run(`DELETE FROM ${tables.mod_cases} WHERE case_code = $1`, [code]);
            if (rowCount !== 1) throw new Error(`Case ${code} was not deleted`);
        }
        return { code, mode: plan.mode, guildId: row.guild_id, type: row.type, counts, evidenceMessages };
    });
}

/** Deletes the re-hosted evidence images in Discord. Returns { deleted, failed }; never throws. */
export async function deleteEvidenceMessages(client, messages = []) {
    let deleted = 0;
    let failed = 0;
    for (const { channelId, messageId } of messages) {
        try {
            const channel = await client?.channels?.fetch?.(channelId);
            if (!channel?.messages?.delete) throw new Error('channel not found');
            markOwnDelete(messageId);
            await channel.messages.delete(messageId);
            deleted += 1;
        } catch (error) {
            // Already gone (Unknown Message) counts as deleted.
            if (error?.code === 10008) deleted += 1; else failed += 1;
        }
    }
    return { deleted, failed };
}
