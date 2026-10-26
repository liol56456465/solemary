// expiryService.js — once-a-minute job: lifts expired temp bans and mutes, and
// turns level-3 ladder bans unappealable once their appeal window closes.
// Runs at startup too, so anything that expired while the bot was down is
// handled immediately.

import { logger } from '../../utils/logger.js';
import { Mutex } from '../../utils/mutex.js';
import { query, T, isEnforcementDbAvailable } from './db.js';
import { OPEN_STATUSES } from './caseService.js';
import { removeMutedRole } from './muteService.js';
import { logEnforcement } from './enforcementService.js';

const BATCH_SIZE = 50;
const UNKNOWN_BAN = 10026;
let running = false;

async function expireCase(row, status = 'expired') {
    await query(
        `UPDATE ${T.cases} SET status = $2 WHERE id = $1 AND status = ANY($3)`,
        [row.id, status, OPEN_STATUSES]
    );
}

async function liftExpired(client, guild, row) {
    const target = { id: row.target_user_id, username: row.target_username };

    if (row.type === 'ban') {
        try {
            await guild.members.unban(row.target_user_id, `Temporary ban ${row.case_code} expired`);
        } catch (error) {
            if (error?.code !== UNKNOWN_BAN) {
                throw error;
            }
            // Already unbanned by hand — just close the record.
        }
        await expireCase(row);
        await logEnforcement(client, guild.id, 'unban', {
            target, moderatorLabel: `${client.user.username} (automatic)`,
            extra: [{ name: 'Reason', value: `Temporary ban \`${row.case_code}\` expired` }],
        });
        return;
    }

    if (row.type === 'mute') {
        await removeMutedRole(guild, row.target_user_id, `Mute ${row.case_code} expired`);
        await expireCase(row);
        await logEnforcement(client, guild.id, 'unmute', {
            target, moderatorLabel: `${client.user.username} (automatic)`,
            extra: [{ name: 'Reason', value: `Mute \`${row.case_code}\` expired` }],
        });
    }
}

export async function runEnforcementExpiry(client) {
    // node-cron fires every minute regardless; skip a tick while the previous one still runs.
    if (running || !client.isReady() || !isEnforcementDbAvailable()) {
        return;
    }
    running = true;

    try {
        const { rows } = await query(
            `SELECT * FROM ${T.cases}
             WHERE status = ANY($1) AND expires_at IS NOT NULL AND expires_at <= NOW()
               AND type IN ('ban', 'mute')
             ORDER BY expires_at ASC LIMIT $2`,
            [OPEN_STATUSES, BATCH_SIZE]
        );

        for (const row of rows) {
            const guild = client.guilds.cache.get(row.guild_id);
            if (!guild) continue;
            try {
                // Same lock as the panel, so an expiry never races a manual action on this user.
                await Mutex.runExclusive(`enforcement:${row.guild_id}:${row.target_user_id}`, () =>
                    liftExpired(client, guild, row));
            } catch (error) {
                logger.warn(`Could not lift expired ${row.type} ${row.case_code}; will retry next minute: ${error.message}`);
            }
        }

        const closed = await query(
            `UPDATE ${T.cases} SET unappealable = TRUE
             WHERE type = 'ban' AND unappealable = FALSE AND appeal_deadline IS NOT NULL AND appeal_deadline <= NOW()
             RETURNING case_code`
        );
        if (closed.rowCount > 0) {
            logger.info(`Appeal window closed for ${closed.rowCount} ladder ban(s): ${closed.rows.map((r) => r.case_code).join(', ')}`);
        }
    } finally {
        running = false;
    }
}
