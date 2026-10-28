// bannedRoleService.js — the "Banned" role in the support server (BANNED_ROLE_ID).
//
// A support-server member has the role exactly while they have an active ban case
// in the main server. syncBannedRole() re-derives that for one user and is called
// after every ban, unban, ban expiry and accepted appeal, and when someone joins the
// support server; reconcileBannedRoles() does it for every member at startup.

import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { query, T, isEnforcementDbAvailable } from './db.js';
import { getActiveCase, OPEN_STATUSES } from './caseService.js';

function supportGuild(client) {
    return client.guilds.cache.get(enforcementConfig.supportGuildId) || null;
}

/**
 * The banned role if the bot can manage it, else { role: null, problem } with a
 * reason fit for the log.
 */
export async function getManageableBannedRole(client) {
    const roleId = enforcementConfig.bannedRoleId;
    if (!roleId) return { role: null, problem: null };

    const guild = supportGuild(client);
    if (!guild) return { role: null, problem: `the bot is not in the support server ${enforcementConfig.supportGuildId}` };

    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return { role: null, problem: `BANNED_ROLE_ID ${roleId} is not a role in the support server` };

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has('ManageRoles')) {
        return { role: null, problem: 'the bot lacks Manage Roles in the support server' };
    }
    if (role.position >= me.roles.highest.position) {
        return {
            role: null,
            problem: `the bot's highest role (${me.roles.highest.name}, position ${me.roles.highest.position}) must be above "${role.name}" (position ${role.position})`,
        };
    }
    return { role, problem: null };
}

async function hasActiveBan(userId) {
    return Boolean(await getActiveCase(enforcementConfig.mainGuildId, userId, 'ban'));
}

/** Gives or removes the banned role for one user so it matches their ban state. */
export async function syncBannedRole(client, userId) {
    if (!enforcementConfig.bannedRoleId || !isEnforcementDbAvailable()) return;

    const { role, problem } = await getManageableBannedRole(client);
    if (!role) {
        if (problem) logger.warn(`Banned role not synced for ${userId}: ${problem}`);
        return;
    }

    const member = await role.guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const banned = await hasActiveBan(userId);
    const has = member.roles.cache.has(role.id);
    if (banned && !has) {
        await member.roles.add(role, 'Active ban in the main server');
    } else if (!banned && has) {
        await member.roles.remove(role, 'No active ban in the main server');
    }
}

/** Runs syncBannedRole and only logs failures, for callers that must not fail on it. */
export function syncBannedRoleQuietly(client, userId) {
    return syncBannedRole(client, userId).catch((error) => {
        logger.warn(`Could not sync the banned role for ${userId}: ${error.message}`);
    });
}

/** Startup: every support-server member gets the role iff they have an active ban. */
export async function reconcileBannedRoles(client) {
    if (!enforcementConfig.bannedRoleId) return { skipped: 'BANNED_ROLE_ID is not set' };
    if (!isEnforcementDbAvailable()) return { skipped: 'the database is unavailable' };

    const { role, problem } = await getManageableBannedRole(client);
    if (!role) return { skipped: problem };

    const { rows } = await query(
        `SELECT DISTINCT target_user_id FROM ${T.cases}
         WHERE guild_id = $1 AND type = 'ban' AND status = ANY($2) AND is_test = FALSE
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [enforcementConfig.mainGuildId, OPEN_STATUSES]
    );
    const bannedIds = new Set(rows.map((row) => row.target_user_id));

    const members = await role.guild.members.fetch();
    let added = 0;
    let removed = 0;
    let errors = 0;
    for (const member of members.values()) {
        if (member.user.bot) continue;
        const banned = bannedIds.has(member.id);
        const has = member.roles.cache.has(role.id);
        try {
            if (banned && !has) {
                await member.roles.add(role, 'Active ban in the main server (startup sync)');
                added += 1;
            } else if (!banned && has) {
                await member.roles.remove(role, 'No active ban in the main server (startup sync)');
                removed += 1;
            }
        } catch (error) {
            errors += 1;
            logger.warn(`Banned role sync failed for ${member.id}: ${error.message}`);
        }
    }
    return { scanned: members.size, added, removed, errors };
}
