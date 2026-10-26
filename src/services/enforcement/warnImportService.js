// warnImportService.js — copies legacy KV warnings into mod_cases as history.
//
// Imported rows have is_imported = TRUE: they show in /background but never count
// toward the warn count or the ladder. The KV data is left untouched, and
// import_key makes the import idempotent, so it is safe to run on every start.

import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../../utils/logger.js';
import { query, T, isEnforcementDbAvailable, isUniqueViolation } from './db.js';
import { insertCase } from './caseService.js';

const WARN_KEY = /^guild:(\d+):warnings:(\d+)$/;

export async function importLegacyWarnings(client) {
    if (!isEnforcementDbAvailable()) {
        return { imported: 0, skipped: 0 };
    }

    const { rows } = await query(
        `SELECT key, value FROM ${pgConfig.tables.temp_data} WHERE key LIKE 'guild:%:warnings:%' AND (expires_at IS NULL OR expires_at > NOW())`
    );

    const existing = await query(`SELECT import_key FROM ${T.cases} WHERE import_key IS NOT NULL`);
    const done = new Set(existing.rows.map((row) => row.import_key));
    let imported = 0;
    let skipped = 0;

    for (const { key, value } of rows) {
        const match = key.match(WARN_KEY);
        const warnings = Array.isArray(value) ? value : value?.value;
        if (!match || !Array.isArray(warnings)) continue;
        const [, guildId, userId] = match;

        const user = await client.users.fetch(userId).catch(() => null);
        const username = user?.username || userId;

        for (const [index, warning] of warnings.entries()) {
            if (!warning) continue;
            const importKey = `${guildId}:${userId}:${warning.id ?? index}`;
            if (done.has(importKey)) {
                skipped += 1;
                continue;
            }

            const moderator = warning.moderatorId
                ? await client.users.fetch(warning.moderatorId).catch(() => null)
                : null;

            const record = {
                guildId,
                targetUserId: userId,
                targetUsername: username,
                moderatorId: warning.moderatorId || 'unknown',
                moderatorUsername: moderator?.username || warning.moderatorId || 'unknown',
                type: 'warn',
                name: `${username} imported warn ${index + 1}`.slice(0, 100),
                reason: String(warning.reason || 'No reason recorded').slice(0, 1000),
                reasonSource: 'custom',
                createdAt: warning.timestamp ? new Date(warning.timestamp) : null,
                isImported: true,
                importKey,
                dmDelivered: true,
                status: warning.status === 'deleted' ? 'revoked' : 'active',
            };

            try {
                try {
                    await insertCase(null, record);
                } catch (error) {
                    // Two users can share a username; fall back to an ID-based name.
                    if (error?.message !== 'Duplicate case name') throw error;
                    await insertCase(null, { ...record, name: `${userId} imported warn ${index + 1}` });
                }
                done.add(importKey);
                imported += 1;
            } catch (error) {
                if (isUniqueViolation(error, 'import_key')) {
                    skipped += 1;
                    continue;
                }
                logger.warn(`Could not import warning ${importKey}: ${error.message}`);
            }
        }
    }

    if (imported > 0) {
        logger.info(`Imported ${imported} legacy warning(s) into mod_cases (${skipped} already imported)`);
    }
    return { imported, skipped };
}
