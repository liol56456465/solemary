// invitePage.js — what the dashboard's Invites page shows (services/dashboard/modules/invites.js):
// the leaderboard, the latest joins and the invite codes, plus whether Mewvo can read invites.
// Each part is read on its own; a part whose read fails is null (the page says it could not be
// read, never shows made-up numbers).

import { canReadInvites, getInviteState, warmGuild } from './inviteCache.js';
import { Mutex } from '../../utils/mutex.js';
import { inviteLeaderboard, recentJoins } from './inviteStats.js';
import { listStoredCodes } from './inviteStore.js';
import { logger } from '../../utils/logger.js';

const CODE_LIMIT = 50;

/** The live cache's codes when loaded, else the stored copy. */
async function codesOf(guild, deps) {
    const state = getInviteState(guild.id);
    if (state?.status === 'ready') {
        return [...state.codes].filter(([, e]) => !e.deletedAt)
            .map(([code, e]) => ({ code, inviterId: e.inviterId, uses: e.uses, maxUses: e.maxUses, deleted: false }))
            .sort((a, b) => b.uses - a.uses || a.code.localeCompare(b.code))
            .slice(0, CODE_LIMIT);
    }
    return (deps.listCodes || listStoredCodes)(guild.id, { limit: CODE_LIMIT });
}

/** { canRead, cacheStatus, leaderboard, recent, codes } (a failed part: null). deps: tests. */
export async function getInvitePageData(guild, settings, deps = {}) {
    const part = async (name, read) => {
        try {
            return await read();
        } catch (error) {
            logger.warn(`Invites page: ${name} of guild ${guild?.id} not read: ${error.message}`);
            return null;
        }
    };
    return {
        canRead: canReadInvites(guild),
        cacheStatus: getInviteState(guild?.id)?.status || null,
        leaderboard: await part('leaderboard', () => (deps.leaderboard || inviteLeaderboard)(guild.id, settings, { page: 1, pageSize: 10 })),
        recent: await part('recent joins', () => (deps.recent || recentJoins)(guild.id, settings, { limit: 20 })),
        codes: await part('codes', () => codesOf(guild, deps)),
    };
}

/**
 * After the feature is turned on (or the bot joined a server): load the cache in the background,
 * under the same per-server lock as the join batches, and only when it is not loaded already
 * (a reload between a join and its batch would hide that join's use). Never throws.
 */
export function warmInviteCache(guild, { warm = warmGuild } = {}) {
    if (!guild?.id || getInviteState(guild.id)?.status === 'ready') return;
    void Mutex.runExclusive(`invites:${guild.id}`, () => warm(guild)).catch(() => {});
}
