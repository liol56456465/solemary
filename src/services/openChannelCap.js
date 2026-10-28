// openChannelCap.js — a ceiling on staff channels that members can open themselves: staff
// reports and modmail together (OPEN_CHANNEL_CAP, default 20). Without it a handful of alt
// accounts could fill a category (Discord allows 50 channels) and stop real conversations.
// At the cap, new ones are refused with a clear message and staff get an alert (at most once
// an hour). Appeals are never counted and never refused.

import { enforcementConfig } from '../config/enforcement.js';
import { Mutex } from '../utils/mutex.js';
import { logger } from '../utils/logger.js';
import { query, T } from './enforcement/db.js';
import { linkedChannelIds } from './modmailLinks.js';

export const CAP_REFUSAL = 'Staff are handling a lot of conversations right now, so a new one cannot be opened. Please try again later. (Ban and mute appeals are not affected.)';
const ALERT_EVERY_MS = 60 * 60_000;
let lastAlertAt = 0;

/** Open staff reports + modmail channels that still exist in this server. */
export async function countOpenStaffChannels(guild) {
    const { rows } = await query(
        `SELECT channel_id FROM ${T.appeals} WHERE kind = 'report' AND guild_id = $1 AND channel_id IS NOT NULL`, [guild.id]);
    const ids = new Set([...rows.map((r) => r.channel_id), ...await linkedChannelIds(guild.id)]);
    return [...ids].filter((id) => guild.channels.cache.has(id)).length;
}

/**
 * Runs `open()` (which creates the channel) only while under the cap, one at a time per
 * server so two requests at 19 cannot both get in. Returns { refused: message } at the cap.
 */
export async function withOpenChannelSlot(guild, kind, open, { now = Date.now(), alert = alertStaff } = {}) {
    return Mutex.runExclusive(`open-staff-channel:${guild.id}`, async () => {
        const cap = enforcementConfig.openChannelCap;
        const count = await countOpenStaffChannels(guild);
        if (count >= cap) {
            logger.warn(`Open-channel cap reached in ${guild.id}: ${count}/${cap}; a new ${kind} was refused`);
            if (now - lastAlertAt >= ALERT_EVERY_MS) {
                lastAlertAt = now;
                await alert(guild, kind, count, cap).catch((error) => logger.warn(`Open-channel cap alert failed: ${error.message}`));
            }
            return { refused: CAP_REFUSAL };
        }
        return open();
    });
}

async function alertStaff(guild, kind, count, cap) {
    const { postModLog } = await import('./enforcement/enforcementService.js');
    await postModLog(guild.client, 'system', [
        { name: 'Open staff reports + modmail', value: `${count} of ${cap}` },
        { name: 'Refused', value: `A new ${kind}. Members are told to try again later; appeals still open normally.` },
        { name: 'What to do', value: 'Close finished report and modmail channels, or raise the cap in the dashboard (Enforcement & appeals).' },
    ], { title: '📥 Staff channel cap reached' });
}

/** Tests only. */
export function resetOpenChannelCapForTests() {
    lastAlertAt = 0;
}
