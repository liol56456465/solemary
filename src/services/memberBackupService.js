// memberBackupService.js — re-adds verified members to a server with the guilds.join
// authorization they gave when they verified (for when the main server is lost or nuked).
//
// One restore runs at a time. Members are added one by one; discord.js waits out
// Discord's rate limits. Members with an active ban in the main server are skipped.
// Progress is shown by editing one message; the owner gets a DM summary at the end.
//
// Purpose limit (privacy): members authorized guilds.join to be kept in Mewvo's own
// servers, so a restore only goes into the main server, the support server, or a server
// listed in MEMBER_RESTORE_GUILD_IDS (comma-separated; e.g. a replacement main server).

import { enforcementConfig } from '../config/enforcement.js';
import { logger } from '../utils/logger.js';
import { getActiveCase } from './enforcement/caseService.js';
import { isEnforcementDbAvailable } from './enforcement/db.js';
import { addMemberWithStoredToken, listStoredTokenUsers } from './oauthVerification.js';

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

/** Why a restore into `guildId` is refused, or null when it is one of Mewvo's own servers. */
export function restoreRefusal(guildId, config = enforcementConfig, env = process.env) {
    if (allowedRestoreGuildIds(config, env).has(String(guildId || ''))) return null;
    return 'Members can only be restored into Mewvo\'s own servers (the main server and the support server). '
        + 'They verified to be kept in those, not added elsewhere. For a replacement server, add its ID to '
        + 'MEMBER_RESTORE_GUILD_IDS and restart the bot.';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many members could be restored, and how many of them are in this guild already. */
export async function backupSummary(guild) {
    const userIds = await listStoredTokenUsers();
    const present = guild ? userIds.filter((id) => guild.members.cache.has(id)).length : 0;
    return { stored: userIds.length, inGuild: present };
}

/**
 * Restores members into `target`. `report(text)` is called with progress lines.
 * Resolves with { added, already, skippedBanned, noToken, failed, total }.
 */
export async function restoreMembers(client, target, report) {
    const refusal = restoreRefusal(target?.id);
    if (refusal) throw new Error(refusal);
    if (running) throw new Error(`A restore into ${running.guildId} is already running (${running.done}/${running.total}).`);
    // Claim the slot before the first await, or two quick restores both get past the check.
    running = { guildId: target.id, startedAt: Date.now(), done: 0, total: 0 };
    let userIds;
    try {
        userIds = await listStoredTokenUsers();
    } catch (error) {
        running = null;
        throw error;
    }
    const counts = { added: 0, already: 0, skippedBanned: 0, noToken: 0, failed: 0, total: userIds.length };
    running.total = userIds.length;

    try {
        for (const userId of userIds) {
            running.done += 1;
            try {
                if (isEnforcementDbAvailable() && await getActiveCase(enforcementConfig.mainGuildId, userId, 'ban')) {
                    counts.skippedBanned += 1;
                } else {
                    const outcome = await addMemberWithStoredToken(client, target.id, userId);
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
            await sleep(PAUSE_BETWEEN_MS);
        }
        return counts;
    } finally {
        running = null;
    }
}
