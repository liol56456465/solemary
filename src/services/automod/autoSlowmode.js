// autoSlowmode.js — turns slowmode on in a channel that suddenly gets very busy
// (a fight, a spam wave, a raid) and off again once it calms down.
//
// Busy: BUSY_MESSAGES messages from at least BUSY_AUTHORS people within BUSY_WINDOW_MS.
// Only channels without slowmode are touched, and only slowmode the bot set itself is
// removed, after CALM_MS without another busy burst. State is kept in the key-value
// store so a restart still lifts it.

import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { getAutomodSettings, isChannelExempt } from './automodSettings.js';

const BUSY_MESSAGES = 15;
const BUSY_AUTHORS = 3;
const BUSY_WINDOW_MS = 10 * 1000;
const SLOWMODE_SECONDS = 5;
const CALM_MS = 3 * 60 * 1000;
const STATE_KEY = 'automod:slowmode';

const recent = new Map(); // channelId → [{ at, authorId }]
let active = null; // channelId → { guildId, since, lastBusy }

// A failed load throws and is retried next time: caching an empty map here would
// save it over the stored state on the next change.
async function loadActive() {
    if (!active) {
        const stored = await getFromDb(STATE_KEY, null);
        active = new Map(Object.entries(stored && typeof stored === 'object' ? stored : {}));
    }
    return active;
}

async function saveActive() {
    await setInDb(STATE_KEY, Object.fromEntries(active))
        .catch((error) => logger.warn(`Auto slowmode state was not saved: ${error.message}`));
}

/** Call for every message in the main server (after automod). */
export async function trackChannelActivity(message) {
    if (message.guildId !== enforcementConfig.mainGuildId || message.author.bot) return;
    const channel = message.channel;
    if (typeof channel?.setRateLimitPerUser !== 'function' || channel.isThread?.()) return;

    const now = Date.now();
    const list = (recent.get(channel.id) || []).filter((entry) => now - entry.at <= BUSY_WINDOW_MS);
    list.push({ at: now, authorId: message.author.id });
    recent.set(channel.id, list);
    if (list.length < BUSY_MESSAGES || new Set(list.map((entry) => entry.authorId)).size < BUSY_AUTHORS) return;

    const settings = await getAutomodSettings(message.guildId);
    if (!settings.enabled || await isChannelExempt(message.guildId, channel)) return;

    const state = await loadActive();
    const existing = state.get(channel.id);
    if (existing) {
        existing.lastBusy = now;
        return;
    }
    if (channel.rateLimitPerUser > 0) return; // a moderator already set slowmode; leave it alone

    recent.delete(channel.id);
    const ok = await channel.setRateLimitPerUser(SLOWMODE_SECONDS, 'Automod: channel flooded').then(() => true).catch((error) => {
        logger.warn(`Auto slowmode in ${channel.id} failed: ${error.message}`);
        return false;
    });
    if (!ok) return;
    state.set(channel.id, { guildId: channel.guild.id, since: now, lastBusy: now });
    await saveActive();
    await channel.send({ content: `Slowmode is on for a few minutes because this channel got very busy (${SLOWMODE_SECONDS}s between messages).` }).catch(() => {});
    await postModLog(message.client, 'slowmode', [
        { name: 'Channel', value: `<#${channel.id}>` },
        { name: 'Why', value: `${list.length} messages from ${new Set(list.map((e) => e.authorId)).size} people in ${BUSY_WINDOW_MS / 1000}s` },
        { name: 'Ends', value: `after ${CALM_MS / 60000} quiet minutes` },
    ], { title: '🐢 Auto slowmode on' });
}

/** Lifts slowmode the bot set once the channel has been calm; run every minute. */
export async function liftCalmSlowmodes(client) {
    const state = await loadActive();
    if (!state.size) return;
    const now = Date.now();
    let changed = false;
    for (const [channelId, entry] of state) {
        if (now - entry.lastBusy < CALM_MS) continue;
        const channel = client.guilds.cache.get(entry.guildId)?.channels.cache.get(channelId);
        // Only undo our own value; a moderator may have changed it meanwhile.
        if (channel && channel.rateLimitPerUser === SLOWMODE_SECONDS) {
            await channel.setRateLimitPerUser(0, 'Automod: channel calm again').catch(() => {});
        }
        state.delete(channelId);
        changed = true;
    }
    if (changed) await saveActive();
}
