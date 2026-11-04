import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { getLevelingConfig, getUserLevelData, setLevelRoleReward } from './leveling.js';
import { planRewardRoles, rewardModeOf, sortedRewards } from './levelBoosts.js';
import { getRoleAssignmentProblem } from '../../utils/roleSafety.js';

import { getUserLevelPrefix } from '../../utils/database/keys.js';

async function listLevelUserIds(client, guildId) {
    if (!client.db?.list) return [];

    const prefixes = [getUserLevelPrefix(guildId), `${guildId}:leveling:users:`];
    const userIds = new Set();

    for (const prefix of prefixes) {
        let keys = await client.db.list(prefix).catch(() => []);
        if (!Array.isArray(keys)) {
            keys = typeof keys === 'object' && keys !== null ? Object.keys(keys) : [];
        }

        for (const key of keys) {
            if (!key.startsWith(prefix)) continue;
            const userId = key.slice(prefix.length);
            if (/^\d{17,19}$/.test(userId)) userIds.add(userId);
        }
    }

    return [...userIds];
}

async function resolveRole(guild, roleId) {
    return guild.roles.cache.get(roleId) || (await guild.roles.fetch?.(roleId).catch(() => null)) || null;
}

/** Why the bot cannot take this role off a member, or null. */
function removalProblem(role, me) {
    if (role.managed) return `${role.name} is managed by an integration`;
    const highest = me?.roles?.highest;
    if (!highest || role.position >= highest.position) return `${role.name} is not below my highest role`;
    return null;
}

/**
 * Gives a member the reward roles their level earns and, by reward mode, takes off the ones
 * they should not hold ("highest only": lower reward roles; removeUnearned: roles above the
 * level). Role hierarchy and missing Manage Roles are logged and skipped; a failed Discord call
 * is logged and counted. Never throws for Discord errors. A failed config or level read
 * (database) throws, so callers catch and log it.
 *
 * options: config (leveling config, read when missing), level (read when missing),
 * removeUnearned (default false), reason (audit log reason).
 * Returns { added: roleId[], removed: roleId[], skipped: [{roleId, problem}], errors }.
 */
export async function syncLevelRolesForMember(client, member, { config = null, level = null, removeUnearned = false, reason = 'Level reward' } = {}) {
    const summary = { added: [], removed: [], skipped: [], errors: 0 };
    const guild = member?.guild;
    if (!guild || member.user?.bot) return summary;

    const cfg = config || (await getLevelingConfig(client, guild.id));
    if (!cfg || cfg.enabled === false) return summary;
    if (!cfg.roleRewards || Object.keys(cfg.roleRewards).length === 0) return summary;

    const memberLevel = Number.isFinite(level) ? level : (await getUserLevelData(client, guild.id, member.id)).level;
    const plan = planRewardRoles({
        roleRewards: cfg.roleRewards,
        level: memberLevel,
        mode: rewardModeOf(cfg),
        heldRoleIds: [...(member.roles?.cache?.keys?.() || [])],
        removeUnearned,
    });
    if (plan.add.length === 0 && plan.remove.length === 0) return summary;

    const me = guild.members?.me;
    const canManageRoles = Boolean(me?.permissions?.has?.(PermissionFlagsBits.ManageRoles));
    const skip = (roleId, problem) => {
        summary.skipped.push({ roleId, problem });
        logger.warn(`Level reward role ${roleId} not changed for ${member.id} in guild ${guild.id}: ${problem}`);
    };

    for (const roleId of plan.add) {
        const role = await resolveRole(guild, roleId);
        if (!role) { skip(roleId, 'the role no longer exists'); continue; }
        if (!canManageRoles) { skip(roleId, 'I am missing the Manage Roles permission'); continue; }
        const problem = getRoleAssignmentProblem(role, me);
        if (problem) { skip(roleId, problem.replace(/\*\*/g, '')); continue; }
        try {
            await member.roles.add(role, reason);
            summary.added.push(roleId);
            logger.info(`Gave level reward role ${role.name} to ${member.id} in guild ${guild.id} (level ${memberLevel})`);
        } catch (error) {
            summary.errors += 1;
            logger.warn(`Could not give level reward role ${roleId} to ${member.id} in guild ${guild.id}: ${error.message}`);
        }
    }

    // "Highest only": if the top earned role was not given (missing, above the bot, managed,
    // a Discord error), the lower earned ones stay, so the member is never left with none.
    // Roles above the level (removeUnearned) still come off.
    // (summary.added, not member.roles.cache: discord.js updates the cache only on the gateway event.)
    const keepEarned = rewardModeOf(cfg) === 'highest'
        && plan.add.some((id) => !summary.added.includes(id))
        ? new Set(sortedRewards(cfg.roleRewards).filter(([l]) => l <= memberLevel).map(([, id]) => id))
        : null;

    for (const roleId of plan.remove) {
        if (keepEarned?.has(roleId)) { skip(roleId, 'kept because the highest reward role could not be given'); continue; }
        const role = await resolveRole(guild, roleId);
        if (!role) continue;
        if (!canManageRoles) { skip(roleId, 'I am missing the Manage Roles permission'); continue; }
        const problem = removalProblem(role, me);
        if (problem) { skip(roleId, problem); continue; }
        try {
            await member.roles.remove(role, reason);
            summary.removed.push(roleId);
            logger.info(`Took level reward role ${role.name} from ${member.id} in guild ${guild.id} (level ${memberLevel})`);
        } catch (error) {
            summary.errors += 1;
            logger.warn(`Could not take level reward role ${roleId} from ${member.id} in guild ${guild.id}: ${error.message}`);
        }
    }

    return summary;
}

/** One short line for a command reply or dashboard message; '' when nothing happened. */
export function roleSyncNote(summary) {
    if (!summary) return '';
    const parts = [];
    if (summary.added.length) parts.push(`gave ${summary.added.length} reward role${summary.added.length === 1 ? '' : 's'}`);
    if (summary.removed.length) parts.push(`took off ${summary.removed.length} reward role${summary.removed.length === 1 ? '' : 's'}`);
    let note = parts.length ? `Mewvo ${parts.join(' and ')}.` : '';
    if (summary.skipped.length || summary.errors) {
        const first = summary.skipped[0]?.problem;
        note += `${note ? ' ' : ''}Some reward roles could not be changed${first ? ` (${first})` : ''}. See the bot log.`;
    }
    return note;
}

const FULL_FETCH_TIMEOUT_MS = 15_000;

/**
 * Fills the guild's member cache with one full member fetch. True when it finished within
 * `timeoutMs`; false when it failed or timed out (the cache may then be partial).
 */
async function fillMemberCache(guild, timeoutMs = FULL_FETCH_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    try {
        const result = await Promise.race([
            Promise.resolve().then(() => guild.members.fetch({ time: timeoutMs })).then(() => 'ok', (error) => {
                logger.warn(`Level role sync: member fetch failed for guild ${guild.id}: ${error.message}`);
                return 'failed';
            }),
            timeout,
        ]);
        if (result === 'timeout') logger.warn(`Level role sync: member fetch timed out for guild ${guild.id}`);
        return result === 'ok';
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Startup sync of level reward roles. Level data is kept when members leave, so stored ids
 * include former members: the member cache is filled once (one full fetch, with a timeout) and
 * only ids present in it are handled, with no per-id Discord request. If that fetch fails or
 * times out the guild is skipped with a warning (summary.skippedGuilds) and synced next start
 * or on level-up/rejoin.
 */
export async function reconcileLevelRoles(client, guildId = null, { fetchTimeoutMs = FULL_FETCH_TIMEOUT_MS } = {}) {
    const summary = {
        scannedGuilds: 0,
        skippedGuilds: 0,
        prunedRewardEntries: 0,
        rolesReAwarded: 0,
        rolesRemoved: 0,
        rolesSkipped: 0,
        errors: 0,
    };

    const guilds = guildId
        ? [client.guilds.cache.get(guildId)].filter(Boolean)
        : [...client.guilds.cache.values()];

    for (const guild of guilds) {
        summary.scannedGuilds += 1;

        try {
            const cfg = await getLevelingConfig(client, guild.id);
            if (cfg.enabled === false) continue;

            const rewards = { ...(cfg.roleRewards || {}) };
            if (Object.keys(rewards).length === 0) continue;


            for (const [level, roleId] of Object.entries(rewards)) {
                // discord.js returns null only for Unknown Role; any other failure (outage, rate
                // limit) throws, and then the reward must stay in the config.
                let role = guild.roles.cache.get(roleId);
                if (!role) {
                    try {
                        role = await guild.roles.fetch(roleId);
                    } catch (error) {
                        logger.warn(`Could not check level ${level} reward role ${roleId} in guild ${guild.id}; keeping it: ${error?.message || error}`);
                        continue;
                    }
                }
                if (!role) {
                    delete rewards[level];
                    await setLevelRoleReward(client, guild.id, level, null);
                    summary.prunedRewardEntries += 1;
                    logger.warn(
                        `Removed missing level ${level} reward role ${roleId} from config in guild ${guild.id}`,
                    );
                }
            }

            if (Object.keys(rewards).length === 0) continue;

            if (!(await fillMemberCache(guild, fetchTimeoutMs))) {
                summary.skippedGuilds += 1;
                logger.warn(`Level role sync skipped for guild ${guild.id}: could not load the member list`);
                continue;
            }

            const userIds = await listLevelUserIds(client, guild.id);
            const config = { ...cfg, roleRewards: rewards };

            for (const userId of userIds) {
                // Former members keep their level data but are not in the cache: skipped, no read.
                const member = guild.members.cache.get(userId);
                if (!member) continue;
                const levelData = await getUserLevelData(client, guild.id, userId);

                // Same per-member rule as rejoin and level-up (respects the reward mode).
                const result = await syncLevelRolesForMember(client, member, {
                    config,
                    level: levelData.level,
                    reason: 'Level reward (startup sync)',
                });
                summary.rolesReAwarded += result.added.length;
                summary.rolesRemoved += result.removed.length;
                summary.rolesSkipped += result.skipped.length;
                summary.errors += result.errors;
            }
        } catch (error) {
            summary.errors += 1;
            logger.warn(`Level role sync failed for guild ${guild.id}:`, error.message);
        }
    }

    return summary;
}
