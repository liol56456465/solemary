// supportAutoJoin.js — puts a member into the Support server with the guilds.join authorization
// they gave when they verified in Mewvo's main server (owner, 2026-11-10): right after they
// verify, and right after they are banned from the main server (so the ban DM, the appeal and
// the Banned role in Support keep working). The Banned role itself is added by the existing
// Support join handler while a ban is active.
//
// Only for the main server: a ban or a verification in any other server never adds anyone to
// Support. Never throws and never delays the caller: a missing token, a missing bot in Support
// or a Discord error is only logged.

import { enforcementConfig } from '../config/enforcement.js';
import { logger } from '../utils/logger.js';
import { addMemberWithStoredToken } from './oauthVerification.js';

/**
 * @returns {Promise<'added'|'already'|'no_token'|'skipped'|'failed'>}
 */
export async function joinSupportQuietly(client, userId, { guildId, why = 'verify', addMember = addMemberWithStoredToken,
    mainGuildId = enforcementConfig.mainGuildId, supportGuildId = enforcementConfig.supportGuildId } = {}) {
    if (!supportGuildId || !mainGuildId || guildId !== mainGuildId) return 'skipped';
    if (!client?.guilds?.cache?.has?.(supportGuildId)) return 'skipped';
    try {
        const result = await addMember(client, supportGuildId, userId);
        if (result === 'added') logger.info(`Added ${userId} to the Support server (${why})`);
        return result;
    } catch (error) {
        logger.warn(`Could not add ${userId} to the Support server (${why}): ${error.message}`);
        return 'failed';
    }
}
