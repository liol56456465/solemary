// memberBackupService.js — re-adds verified members to a server with the guilds.join
// authorization they gave when they verified (for when the main server is lost or nuked).
//
// One restore runs at a time. Members are added one by one; discord.js waits out
// Discord's rate limits. Members with an active ban in the main server are skipped.
// Progress is shown by editing one message; the owner gets a DM summary at the end.

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
