import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { fetchAllMembers } from '../../utils/memberFetchGate.js';
import { getLevelingConfig, getUserLevelData, setLevelRoleReward } from './leveling.js';
import { planRewardRoles, rewardModeOf, sortedRewards } from './levelBoosts.js';
import { getRoleAssignmentProblem } from '../../utils/roleSafety.js';
import { botText } from '../../utils/botText.js';

import { getUserLevelPrefix } from '../../utils/database/keys.js';

async function listLevelUserIds(client, guildId) {
    if (!client.db?.list) return [];

    const prefixes = [getUserLevelPrefix(guildId), `${guildId}:leveling:users:`];
    const userIds = new Set();

    for (const prefix of prefixes) {
        // A failed list throws (the caller counts the guild as failed), never "nobody has a level".
        let keys = await client.db.list(prefix);
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
 * removeUnearned (default false), reason (audit log reason), log (default true: one summary
 * line per call; the startup sync passes false and logs one line per server).
 * Returns { added: roleId[], removed: roleId[], skipped: [{roleId, problem}], errors }.
 */
export async function syncLevelRolesForMember(client, member, { config = null, level = null, removeUnearned = false, reason = 'Level reward', log = true } = {}) {
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
    };
    const errorNotes = [];

    for (const roleId of plan.add) {
        const role = await resolveRole(guild, roleId);
        if (!role) { skip(roleId, 'the role no longer exists'); continue; }
        if (!canManageRoles) { skip(roleId, 'I am missing the Manage Roles permission'); continue; }
        const problem = getRoleAssignmentProblem(role, me);
        if (problem) { skip(roleId, problem.replace(/\*\*/g, '')); continue; }
        try {
            await member.roles.add(role, reason);
            summary.added.push(roleId);
        } catch (error) {
            summary.errors += 1;
            errorNotes.push(`give ${roleId}: ${error.message}`);
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
        } catch (error) {
            summary.errors += 1;
            errorNotes.push(`take ${roleId}: ${error.message}`);
        }
    }

    if (log) logRoleSyncSummary(summary, { memberId: member.id, guildId: guild.id, level: memberLevel, errorNotes });
    return summary;
}

/**
 * One log line per sync (not one per role): info when roles changed, warn when some were
 * skipped or failed (with the first few reasons). Nothing when nothing happened.
 */
export function roleSyncLogLine(summary, { memberId, guildId, level, errorNotes = [] }) {
    const { added, removed, skipped, errors } = summary;
    if (!added.length && !removed.length && !skipped.length && !errors) return null;
    const problems = [...skipped.map((s) => `${s.roleId}: ${s.problem}`), ...errorNotes];
    const text = `Level reward roles for ${memberId} in guild ${guildId} (level ${level}): `
        + `${added.length} given, ${removed.length} taken off, ${skipped.length} skipped, ${errors} failed`
        + (problems.length ? ` — ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}` : '');
    return { level: skipped.length || errors ? 'warn' : 'info', text };
}

function logRoleSyncSummary(summary, details) {
    const line = roleSyncLogLine(summary, details);
    if (line) logger[line.level](line.text);
}

/** One short line for a command reply or dashboard message; '' when nothing happened. */
export function roleSyncNote(summary, { lang = 'en' } = {}) {
    if (!summary) return '';
    const tr = botText(lang);
    const gave = summary.added.length ? tr.tp('leveling.roleSync.gave', summary.added.length) : null;
    const tookOff = summary.removed.length ? tr.tp('leveling.roleSync.tookOff', summary.removed.length) : null;
    let note = '';
    if (gave && tookOff) note = tr.t('leveling.roleSync.both', { gave, tookOff });
    else if (gave || tookOff) note = tr.t('leveling.roleSync.single', { action: gave || tookOff });
    if (summary.skipped.length || summary.errors) {
        const first = summary.skipped[0]?.problem;
        note += `${note ? ' ' : ''}${first ? tr.t('leveling.roleSync.problemWith', { problem: first }) : tr.t('leveling.roleSync.problem')}`;
    }
    return note;
}

const FULL_FETCH_TIMEOUT_MS = 15_000;

/**
 * Fills the guild's member cache through the member fetch gate. True when the cache is complete
 * (fetched now, recently, or already >= 90% of memberCount); false when the gate refused (too
 * big, rate-limited, busy) or the fetch failed or timed out (the cache may then be partial).
 */
async function fillMemberCache(guild, timeoutMs = FULL_FETCH_TIMEOUT_MS) {
    const { partial, reason } = await fetchAllMembers(guild, { timeoutMs, maxAgeMs: 5 * 60_000 });
    if (partial) logger.warn(`Level role sync: no complete member list for guild ${guild.id} (${reason})`);
    return !partial;
}

/**
 * Startup sync of level reward roles. Level data is kept when members leave, so stored ids
 * include former members: the member cache is filled once (one full fetch through the member fetch gate) and
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
            const guildTotals = { added: 0, removed: 0, skipped: 0, errors: 0, firstProblem: null };

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
                    log: false,
                });
                guildTotals.added += result.added.length;
                guildTotals.removed += result.removed.length;
                guildTotals.skipped += result.skipped.length;
                guildTotals.errors += result.errors;
                if (!guildTotals.firstProblem && result.skipped.length) guildTotals.firstProblem = result.skipped[0].problem;
                summary.rolesReAwarded += result.added.length;
                summary.rolesRemoved += result.removed.length;
                summary.rolesSkipped += result.skipped.length;
                summary.errors += result.errors;
            }
            if (guildTotals.added || guildTotals.removed || guildTotals.skipped || guildTotals.errors) {
                const text = `Level role sync for guild ${guild.id}: ${guildTotals.added} given, ${guildTotals.removed} taken off, `
                    + `${guildTotals.skipped} skipped, ${guildTotals.errors} failed`
                    + (guildTotals.firstProblem ? ` (first problem: ${guildTotals.firstProblem})` : '');
                if (guildTotals.skipped || guildTotals.errors) logger.warn(text);
                else logger.info(text);
            }
        } catch (error) {
            summary.errors += 1;
            logger.warn(`Level role sync failed for guild ${guild.id}:`, error.message);
        }
    }

    return summary;
}
