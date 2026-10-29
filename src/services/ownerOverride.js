// ownerOverride.js — OWNER_IDS are the emergency key: they may run admin-only commands and
// dashboard actions without Administrator. Every such use is recorded as an "owner override"
// (who, what, when): a warning line in the bot log (always kept) and an entry in the server's
// mod log. Recording never blocks or fails the action itself.

import { logger } from '../utils/logger.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';

/**
 * via: 'slash' | 'context menu' | 'prefix' | 'button' | 'dashboard'.
 * action: what ran, e.g. "/case edit" or "automod/panic".
 * reason: what was overridden, when it is not the usual missing Administrator
 *   (e.g. "decided an appeal on a case they issued (independent appeal review is on)").
 */
export async function recordOwnerOverride({ client, guildId, userId, username = null, action, via, reason = null, now = new Date() }) {
    const who = `${username || 'unknown'} (${userId})`;
    const why = reason ? String(reason).slice(0, 300) : 'without Administrator';
    logger.warn(`Owner override: ${who} ran ${action} via ${via} at ${now.toISOString()} ${why}`);
    if (!client || !guildId) return;
    try {
        await logEvent({
            client, guildId, eventType: EVENT_TYPES.MODERATION_OWNER_OVERRIDE,
            data: {
                title: 'Owner override',
                userId,
                lines: [
                    `**User:** <@${userId}> ${who}`,
                    `**Action:** ${String(action).slice(0, 200)} (${via})`,
                    `**Time:** <t:${Math.floor(now.getTime() / 1000)}:F>`,
                    `Run by a bot owner (OWNER_IDS) ${why}.`,
                ],
            },
        });
    } catch (error) {
        logger.warn(`Owner override not posted to the mod log: ${error.message}`);
    }
}

/** Fire and forget, for paths that must answer Discord within 3 seconds. */
export function noteOwnerOverride(details) {
    recordOwnerOverride(details).catch(() => {});
}
