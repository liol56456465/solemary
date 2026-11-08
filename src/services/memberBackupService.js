// memberBackupService.js — re-adds verified members to a server with the guilds.join
// authorization they gave when they verified (for when the main server is lost or nuked).
//
// One restore runs at a time. Members are added one by one; discord.js waits out
// Discord's rate limits. Members with an active ban in the target's server (Mewvo's own
// servers: the main server) are skipped. Progress is shown by editing one message; the owner
// gets a DM summary at the end.
//
// Purpose limit (privacy, multi-server B1): a member's guilds.join authorization is only used
// for the server(s) they verified in (oauth_verified_guilds, schema v12):
//   - Mewvo's own servers (main, support, MEMBER_RESTORE_GUILD_IDS = e.g. a replacement main
//     server; comma-separated): members verified in any of them, plus tokens from before v12
//     (they all came from Mewvo's own servers).
//   - any other server: only members verified in that very server (restorableUserIds). A
//     verification there never makes anyone restorable into Mewvo's main or support server.
//     Restores into other servers are still refused (restoreRefusal; Privacy Policy).

import { enforcementConfig } from '../config/enforcement.js';
import { logger } from '../utils/logger.js';
import { getActiveCase } from './enforcement/caseService.js';
import { isEnforcementDbAvailable } from './enforcement/db.js';
import { addMemberWithStoredToken, listStoredTokenUsers, verifiedGuildsOf } from './oauthVerification.js';

const PROGRESS_EVERY = 25;
const PAUSE_BETWEEN_MS = 300;

let running = null; // { guildId, startedAt, done, total }

export function getRestoreState() {
    return running;
}

const SNOWFLAKE = /^\d{17,20}$/;

/** The servers a restore may target: main + support guild, plus MEMBER_RESTORE_GUILD_IDS. */
export function allowedRestoreGuildIds(config = enforcementConfig, env = process.env) {
    const extra = String(env.MEMBER_RESTORE_GUILD_IDS || '').split(',').map((id) => id.trim());
    return new Set([config.mainGuildId, config.supportGuildId, ...extra]
        .map((id) => String(id || '').trim())
        .filter((id) => SNOWFLAKE.test(id)));
}

/**
 * Why a restore into `guildId` is refused, or null when it is one of Mewvo's own servers. Other
 * servers stay refused for now (the Privacy Policy promises restores only for Mewvo's own
 * servers); restorableUserIds already scopes them to their own verifications for when that opens.
 */
export function restoreRefusal(guildId, config = enforcementConfig, env = process.env) {
    if (allowedRestoreGuildIds(config, env).has(String(guildId || ''))) return null;
    return 'Members can only be restored into Mewvo\'s own servers (the main server and the support server). '
        + 'They verified to be kept in those, not added elsewhere. For a replacement server, add its ID to '
        + 'MEMBER_RESTORE_GUILD_IDS and restart the bot.';
}

/**
 * Whether a member with these verified servers may be added to `targetId`. `verified` is the
 * Set from verifiedGuildsOf, or undefined for a token stored before v12 (home servers only).
 */
export function mayRestoreInto(verified, targetId, homeIds) {
    const target = String(targetId || '');
    if (!verified) return homeIds.has(target);
    if (homeIds.has(target)) return [...verified].some((id) => homeIds.has(id));
    return verified.has(target);
}

/** The members with a stored token who may be restored into `targetId`. Throws on a database error. */
export async function restorableUserIds(targetId, {
    config = enforcementConfig, env = process.env, listUsers = listStoredTokenUsers, verifiedOf = verifiedGuildsOf,
} = {}) {
    const userIds = await listUsers();
    const verified = await verifiedOf(userIds);
    const homeIds = allowedRestoreGuildIds(config, env);
    return userIds.filter((id) => mayRestoreInto(verified.get(id), targetId, homeIds));
}

/** The server whose active bans skip a member: the main server for Mewvo's own servers, else the target itself. */
export function banGuildFor(targetId, config = enforcementConfig, env = process.env) {
    return allowedRestoreGuildIds(config, env).has(String(targetId)) ? (config.mainGuildId || String(targetId)) : String(targetId);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How many members could be restored into this guild (`guildId` when the guild itself is not
 * reachable), and how many of them are in it already.
 */
export async function backupSummary(guild, guildId = guild?.id ?? enforcementConfig.mainGuildId, options = {}) {
    const userIds = await restorableUserIds(guildId, options);
    const present = guild ? userIds.filter((id) => guild.members.cache.has(id)).length : 0;
    return { stored: userIds.length, inGuild: present };
}

/**
 * Restores members into `target`. `report(text)` is called with progress lines.
 * Resolves with { added, already, skippedBanned, noToken, failed, total }.
 */
export async function restoreMembers(client, target, report, options = {}) {
    const refusal = restoreRefusal(target?.id, options.config, options.env);
    if (refusal) throw new Error(refusal);
    const { addMember = addMemberWithStoredToken, activeBan = getActiveCase, dbAvailable = isEnforcementDbAvailable, pauseMs = PAUSE_BETWEEN_MS } = options;
    if (running) throw new Error(`A restore into ${running.guildId} is already running (${running.done}/${running.total}).`);
    // Claim the slot before the first await, or two quick restores both get past the check.
    running = { guildId: target.id, startedAt: Date.now(), done: 0, total: 0 };
    let userIds;
    try {
        userIds = await restorableUserIds(target.id, options);
    } catch (error) {
        running = null;
        throw error;
    }
    const counts = { added: 0, already: 0, skippedBanned: 0, noToken: 0, failed: 0, total: userIds.length };
    running.total = userIds.length;
    const banGuildId = banGuildFor(target.id, options.config, options.env);

    try {
        for (const userId of userIds) {
            running.done += 1;
            try {
                if (dbAvailable() && await activeBan(banGuildId, userId, 'ban')) {
                    counts.skippedBanned += 1;
                } else {
                    const outcome = await addMember(client, target.id, userId);
                    if (outcome === 'added') counts.added += 1;
                    else if (outcome === 'already') counts.already += 1;
                    else counts.noToken += 1;
                }
            } catch (error) {
                counts.failed += 1;
                logger.warn(`Restore of ${userId} into ${target.id} failed: ${error.message}`);
                // Missing permission or the bot left: nothing after this will work either.
                if (error.code === 50013 || error.code === 10004) throw error;
            }

            if (running.done % PROGRESS_EVERY === 0) {
                await report(`Restoring into **${target.name}**: ${running.done}/${counts.total} processed, ${counts.added} added.`).catch(() => {});
            }
            if (pauseMs) await sleep(pauseMs);
        }
        return counts;
    } finally {
        running = null;
    }
}
