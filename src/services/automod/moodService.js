// moodService.js — mood alerts: a per-channel "heat" score from signals automod has
// already computed for each message (insults, disrespect, harassment, sexual remarks,
// caps floods; weights in config/automod.js), kept in memory over moodWindowMs.
// No extra reads per message: only messages that hit one of those rules count.
//
// When heat reaches moodThreshold with at least moodMinMembers different members, the
// bot posts one calm-down note in the channel, turns on its auto slowmode (lifted
// after a few quiet minutes, autoSlowmode.js) and posts a line in the alerts channel.
// Then nothing more in that channel for moodCooldownMs. On/off: /automod mood.

import { automodConfig } from '../../config/automod.js';
import { logger } from '../../utils/logger.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { AUTO_SLOWMODE_SECONDS, startSlowmode } from './autoSlowmode.js';
import { computeHeat, messageHeat, shouldCalmChannel } from './policy.js';

const signals = new Map();   // channelId → [{ at, userId, weight }]
const lastCalm = new Map();  // channelId → epoch ms

export const CALM_NOTE = "Let's keep it friendly — slowmode is on for a few minutes.";
export const CALM_NOTE_NO_SLOWMODE = "Let's keep it friendly, everyone.";

/**
 * Notes one message's automod hits (after rule modes). Returns true when the channel
 * was calmed down just now.
 */
export async function noteMoodSignals(message, hits, settings, now = Date.now()) {
    if (!settings?.moodAlerts) return false;
    const weight = messageHeat(hits);
    if (!weight) return false;
    const channelId = message.channelId;
    const list = (signals.get(channelId) || []).filter((event) => now - event.at <= automodConfig.moodWindowMs);
    list.push({ at: now, userId: message.author.id, weight });
    signals.set(channelId, list);
    if (signals.size > 500) prune(now);

    const heat = computeHeat(list, now);
    if (!shouldCalmChannel(heat, { lastCalmAt: lastCalm.get(channelId) || 0, now })) return false;
    lastCalm.set(channelId, now);
    signals.delete(channelId);
    await calmChannel(message.channel, heat);
    return true;
}

async function calmChannel(channel, heat) {
    const slowmode = await startSlowmode(channel, { reason: 'Automod: heated conversation' }).catch((error) => {
        logger.warn(`Mood slowmode in ${channel.id} failed: ${error.message}`);
        return null;
    });
    await channel.send({ content: slowmode ? CALM_NOTE : CALM_NOTE_NO_SLOWMODE, allowedMentions: { parse: [] } }).catch(() => {});
    await postModLog(channel.client, 'slowmode', [
        { name: 'Channel', value: `<#${channel.id}>` },
        { name: 'Why', value: `heat ${heat.score} from ${heat.members} members in ${Math.round(automodConfig.moodWindowMs / 60000)} min (insults, harassment, caps floods)` },
        { name: 'Done', value: slowmode ? `calm-down note posted; slowmode ${AUTO_SLOWMODE_SECONDS}s, lifted after a few quiet minutes` : 'calm-down note posted; slowmode was already set by a moderator or could not be set' },
    ], { title: '🌡️ Heated channel' });
}

function prune(now) {
    for (const [channelId, list] of signals) {
        if (!list.length || now - list[list.length - 1].at > automodConfig.moodWindowMs) signals.delete(channelId);
    }
    for (const [channelId, at] of lastCalm) if (now - at > automodConfig.moodCooldownMs) lastCalm.delete(channelId);
}

/** Test hook. */
export function resetMoodState() {
    signals.clear();
    lastCalm.clear();
}
