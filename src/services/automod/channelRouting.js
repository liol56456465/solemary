// channelRouting.js — which staff channel each kind of bot post goes to.
//
//   review  AUTOMOD_REVIEW_CHANNEL_ID  things that need a decision (automod cards, member
//                                      reports, held verifications)
//   modlog  MOD_LOG_CHANNEL_ID         a one-line record of every enforcement action
//   alerts  BOT_ALERTS_CHANNEL_ID      raids, staff guard, mass-action guard, auto slowmode,
//                                      digests and weekly reports, system problems
//
// review and alerts fall back to the mod log channel, so a server with only
// MOD_LOG_CHANNEL_ID set still gets everything in one place.

import { automodConfig } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';

/** postModLog kinds that are alerts rather than a record of an enforcement action. */
export const ALERT_KINDS = new Set([
    'raid', 'staff', 'massguard', 'automod', 'automod-report', 'slowmode', 'digest', 'system',
]);

/** Enforcement actions: posted in the mod log as one line. */
export const ACTION_KINDS = new Set(['ban', 'kick', 'mute', 'warn', 'unban', 'unmute', 'removewarn']);

/** 'alerts' | 'modlog' for a postModLog kind. Unknown kinds stay in the mod log. */
export function channelPurposeFor(kind) {
    return ALERT_KINDS.has(kind) ? 'alerts' : 'modlog';
}

/** The channel id for a purpose, with the fallbacks applied. `ids` is for tests. */
export function resolveChannelId(purpose, ids = currentChannelIds()) {
    const modLog = ids.modLogChannelId || null;
    if (purpose === 'review') return ids.reviewChannelId || modLog;
    if (purpose === 'alerts') return ids.alertsChannelId || modLog;
    return modLog;
}

export function currentChannelIds() {
    return {
        reviewChannelId: automodConfig.reviewChannelId,
        alertsChannelId: automodConfig.alertsChannelId,
        modLogChannelId: enforcementConfig.modLogChannelId,
    };
}

/** A text channel in the main server for a purpose, or null. */
export async function fetchStaffChannel(client, purpose) {
    const channelId = resolveChannelId(purpose);
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    if (!channelId || !guild) return null;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    return channel?.isTextBased?.() ? channel : null;
}

const ACTION_LINE = {
    ban: ['🔨', 'Ban'],
    kick: ['👢', 'Kick'],
    mute: ['🔇', 'Mute'],
    warn: ['⚠️', 'Warning'],
    unban: ['✅', 'Unban'],
    unmute: ['🔊', 'Unmute'],
    removewarn: ['🧹', 'Warning removed'],
};

const oneLine = (text) => String(text ?? '').replace(/\s*\n+\s*/g, ' ').trim();

/**
 * The mod log line for an enforcement action, from the fields logEnforcement builds:
 * "🔨 **Ban** · alice (123) · by Bob · `k3f9a` alice ban 1 · 7 days (ends …) · “Spam” · DM: Not delivered".
 */
export function formatModLogLine(kind, fields = []) {
    const [emoji, label] = ACTION_LINE[kind] || ['•', kind];
    const parts = [`${emoji} **${label}**`];
    for (const field of fields) {
        if (!field?.value) continue;
        const value = oneLine(field.value);
        switch (field.name) {
            case 'User': parts.push(value); break;
            case 'Moderator': parts.push(`by ${value}`); break;
            case 'Case': parts.push(value.replace(' — ', ' ')); break;
            case 'Reason': parts.push(`“${value}”`); break;
            case 'Duration': parts.push(value); break;
            default: parts.push(`${field.name}: ${value}`);
        }
    }
    const line = parts.join(' · ');
    return line.length > 4000 ? `${line.slice(0, 3999)}…` : line;
}
