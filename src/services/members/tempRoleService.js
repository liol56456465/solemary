// tempRoleService.js — temporary roles: a role given until a set time (dashboard Members).
// The role is added in Discord and a row is kept in member_temp_roles; the expiry cron
// (once a minute, with the other expiry jobs) takes the role off and deletes the row; a member
// who leaves and rejoins before the end gets the role back. Giving the same role again
// replaces the end time; taking the role off by hand from the dashboard ends the row too.

import { query, T } from '../enforcement/db.js';
import { logger } from '../../utils/logger.js';

export const TEMP_ROLE_LENGTHS = {
    '1h': { label: '1 hour', ms: 3_600_000 },
    '1d': { label: '1 day', ms: 86_400_000 },
    '3d': { label: '3 days', ms: 3 * 86_400_000 },
    '7d': { label: '7 days', ms: 7 * 86_400_000 },
    '30d': { label: '30 days', ms: 30 * 86_400_000 },
};
const EXPIRY_BATCH = 50;

/** Gives the role in Discord, then stores (or replaces) its end time. */
export async function addTempRole({ member, guildId = member.guild.id, role, ms, by, reason = null, auditReason = null, now = Date.now() }) {
    const expiresAt = new Date(now + ms);
    if (!member.roles.cache.has(role.id)) await member.roles.add(role.id, auditReason || undefined);
    await query(
        `INSERT INTO ${T.tempRoles} (guild_id, user_id, role_id, expires_at, given_by, given_by_username, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (guild_id, user_id, role_id) DO UPDATE SET expires_at = EXCLUDED.expires_at,
           given_by = EXCLUDED.given_by, given_by_username = EXCLUDED.given_by_username, reason = EXCLUDED.reason`,
        [guildId, member.id || member.user?.id, role.id, expiresAt, by.id, by.username, reason],
    );
    return expiresAt;
}

/** The member's running temporary roles: [{ role_id, expires_at, given_by_username, reason }]. */
export async function listTempRoles(guildId, userId) {
    const { rows } = await query(
        `SELECT role_id, expires_at, given_by_username, reason FROM ${T.tempRoles}
         WHERE guild_id = $1 AND user_id = $2 ORDER BY expires_at`, [guildId, userId]);
    return rows;
}

/** Forgets a temporary role (the role itself is handled by the caller). */
export async function endTempRole(guildId, userId, roleId) {
    await query(`DELETE FROM ${T.tempRoles} WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`, [guildId, userId, roleId]);
}

/**
 * Takes expired temporary roles off and deletes their rows (batch of 50 per run). A member who
 * left keeps nothing to remove; a role that no longer exists or is above the bot is just
 * forgotten (logged). Returns the number of rows handled.
 */
export async function runTempRoleExpiry(client, now = new Date()) {
    const { rows } = await query(
        `SELECT guild_id, user_id, role_id FROM ${T.tempRoles} WHERE expires_at <= $1 ORDER BY expires_at LIMIT ${EXPIRY_BATCH}`, [now]);
    for (const row of rows) {
        const guild = client.guilds.cache.get(row.guild_id);
        if (guild) {
            const member = await guild.members.fetch({ user: row.user_id }).catch(() => null);
            if (member?.roles.cache.has(row.role_id)) {
                await member.roles.remove(row.role_id, 'Temporary role ended').catch((error) => {
                    logger.warn(`Temporary role ${row.role_id} could not be removed from ${row.user_id}: ${error.message}`);
                });
            }
        }
        await endTempRole(row.guild_id, row.user_id, row.role_id);
    }
    return rows.length;
}

/** On join: gives back temporary roles that have not ended yet. */
export async function reapplyTempRolesOnJoin(member, now = new Date()) {
    const { rows } = await query(
        `SELECT role_id FROM ${T.tempRoles} WHERE guild_id = $1 AND user_id = $2 AND expires_at > $3`, [member.guild.id, member.id, now]);
    for (const row of rows) {
        if (!member.guild.roles.cache.has(row.role_id)) continue;
        await member.roles.add(row.role_id, 'Temporary role (rejoined before it ended)').catch((error) => {
            logger.warn(`Temporary role ${row.role_id} could not be given back to ${member.id}: ${error.message}`);
        });
    }
    return rows.length;
}
