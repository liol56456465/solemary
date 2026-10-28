// joinGate.js — optional checks on members joining the main server (/automod joingate).
//
// Checks (each off / flag / kick, all off by default):
//   avatar   no profile picture
//   links    username or display name contains an invite or link (discord.gg/…, http…, x.com)
//   botname  username looks generated: letters followed by 5+ digits ("alex483920"), or
//            12+ characters mixing letters and digits at random ("k3j9x0q2m7pz")
//   age      account younger than N days (default: the OAuth verification guard's
//            minimum, MIN_ACCOUNT_AGE_MS, so both agree)
// "flag" posts one compact line in the review channel with Kick / Dismiss buttons;
// "kick" DMs the member why and how to come back, then kicks (no case: they broke no
// rule). If several checks hit, the strongest action wins.
//
// Bots, and members who already verified with "Verify with Discord" (stored OAuth
// tokens: they passed the verification guard, account age included), are exempt.
// Profile bios are not visible to bots, so "invite in bio" can't be checked.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SnowflakeUtil } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { createEmbed } from '../../utils/embeds.js';
import { deleteFromDb, getFromDb, setInDb } from '../../utils/database.js';
import { MIN_ACCOUNT_AGE_MS } from '../verificationGuard.js';
import { formatDuration } from '../enforcement/format.js';
import { getAutomodSettings } from './automodSettings.js';
import { reviewChannel } from './reviewCards.js';
import { STATUS_COLORS } from './reviewFormat.js';

const DAY = 24 * 60 * 60 * 1000;
export const JOIN_GATE_ACTIONS = ['off', 'flag', 'kick'];
export const DEFAULT_GATE_DAYS = Math.round(MIN_ACCOUNT_AGE_MS / DAY);
const FLAG_TTL_SECONDS = 14 * 24 * 60 * 60;

export const JOIN_GATE_CHECKS = {
    avatar: { label: 'No profile picture', comeBack: 'after setting a profile picture' },
    links: { label: 'Link or invite in their name', comeBack: 'after removing the link from your username and display name' },
    botname: { label: 'Generated-looking username', comeBack: 'with a username that does not look automatically generated' },
    age: { label: 'New account', comeBack: 'once your account is older' },
};

export const DEFAULT_JOIN_GATE = Object.freeze({ avatar: 'off', links: 'off', botname: 'off', age: 'off', ageDays: DEFAULT_GATE_DAYS });

/** Stored join gate settings (any shape) → a complete object. */
export function normalizeJoinGate(stored) {
    const value = stored && typeof stored === 'object' ? stored : {};
    const out = {};
    for (const check of Object.keys(JOIN_GATE_CHECKS)) {
        out[check] = JOIN_GATE_ACTIONS.includes(value[check]) ? value[check] : 'off';
    }
    const days = Math.round(Number(value.ageDays));
    out.ageDays = Number.isFinite(days) && days >= 1 ? Math.min(days, 365) : DEFAULT_GATE_DAYS;
    return out;
}

const LINK_PATTERNS = [
    /discord(?:app)?\s*\.\s*(?:gg|com\s*\/\s*invite|me)\s*\//i,
    /\.gg\s*\/\s*\w/i,
    /https?:\/\//i,
    /\bwww\./i,
    /\b(?:t\.me|bit\.ly|x\.com|tiktok\.com|youtube\.com|youtu\.be|twitch\.tv|onlyfans\.com)\b/i,
    /\b[a-z0-9-]{2,}\.(?:com|net|gg|xyz|ru|shop|store|link|click|site)\b/i,
];

/** True when a name contains an invite or link. */
export function nameHasLink(name) {
    if (!name) return false;
    return LINK_PATTERNS.some((pattern) => pattern.test(String(name)));
}

/**
 * True for usernames that look machine-made. Conservative on purpose: real
 * usernames often have a few digits ("sam_2004"), so only these count:
 * letters then 5+ digits, or 12+ letters-and-digits with 4+ letter↔digit switches.
 */
export function looksGenerated(username) {
    const name = String(username || '').toLowerCase();
    if (/^[a-z]{3,}\d{5,}$/.test(name)) return true;
    if (/^[a-z0-9]{12,}$/.test(name)) {
        const switches = (name.match(/[a-z](?=\d)|\d(?=[a-z])/g) || []).length;
        const digits = (name.match(/\d/g) || []).length;
        if (switches >= 4 && digits >= 3) return true;
    }
    return false;
}

const STRENGTH = { off: 0, flag: 1, kick: 2 };

/**
 * The checks a user fails. user: { id, username, globalName, avatar }.
 * Returns { action: 'off'|'flag'|'kick', hits: [{ check, action, reason }] }.
 */
export function evaluateJoinGate(user, gate, now = Date.now()) {
    const settings = normalizeJoinGate(gate);
    const hits = [];
    const add = (check, reason) => {
        if (settings[check] !== 'off') hits.push({ check, action: settings[check], reason });
    };
    if (!user.avatar) add('avatar', 'no profile picture');
    const linked = [user.username, user.globalName].find((name) => nameHasLink(name));
    if (linked) add('links', `link in their name ("${String(linked).slice(0, 40)}")`);
    if (looksGenerated(user.username)) add('botname', `generated-looking username ("${user.username}")`);
    const ageMs = now - SnowflakeUtil.timestampFrom(user.id);
    if (ageMs < settings.ageDays * DAY) {
        add('age', `account is ${formatDuration(Math.max(ageMs, 60 * 1000))} old (minimum ${settings.ageDays} day${settings.ageDays === 1 ? '' : 's'})`);
    }
    const action = hits.reduce((best, hit) => (STRENGTH[hit.action] > STRENGTH[best] ? hit.action : best), 'off');
    return { action, hits };
}

/** The DM a kicked member gets. */
export function kickNotice(guildName, hits) {
    const kicked = hits.filter((hit) => hit.action === 'kick');
    const ways = [...new Set(kicked.map((hit) => JOIN_GATE_CHECKS[hit.check].comeBack))];
    return [
        `You were removed from **${guildName}** by an automatic join check: ${kicked.map((hit) => hit.reason).join('; ')}.`,
        'This is not a ban and nothing was recorded against you.',
        `You are welcome to join again ${ways.join(', and ')}.`,
    ].join('\n');
}

const flagKey = (guildId, userId) => `automod:joingate:flag:${guildId}:${userId}`;

export async function getGateFlag(guildId, userId) {
    return getFromDb(flagKey(guildId, userId), null);
}

export async function clearGateFlag(guildId, userId) {
    await deleteFromDb(flagKey(guildId, userId));
}

function gateLine(member, hits, outcome) {
    const emoji = outcome === 'kicked' ? '👢' : '🚪';
    return `${emoji} **Join gate** · <@${member.id}> ${member.user.username} (\`${member.id}\`) · ${outcome} · ${hits.map((hit) => hit.reason).join('; ')}`;
}

export function gateButtons(userId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`joingate:kick:${userId}`).setLabel('Kick').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`joingate:dismiss:${userId}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
    );
}

async function postGateLine(member, hits, outcome, color, withButtons) {
    const channel = await reviewChannel(member.client);
    if (!channel) {
        logger.warn(`Join gate ${outcome} ${member.id}, but there is no review channel`);
        return null;
    }
    return channel.send({
        embeds: [createEmbed({ description: gateLine(member, hits, outcome), color })],
        components: withButtons ? [gateButtons(member.id)] : [],
        allowedMentions: { parse: [] },
    }).catch((error) => {
        logger.warn(`Join gate line failed: ${error.message}`);
        return null;
    });
}

/** Kicks a member with the join-gate DM. Resolves true when kicked. */
export async function kickWithNotice(member, hits, reason) {
    await member.send({ content: kickNotice(member.guild.name, hits), allowedMentions: { parse: [] } }).catch(() => {});
    return member.kick(reason.slice(0, 512)).then(() => true).catch((error) => {
        logger.warn(`Join gate could not kick ${member.id}: ${error.message}`);
        return false;
    });
}

/**
 * Runs the join gate for a new member of the main server. Never throws.
 * Returns 'kicked' | 'flagged' | null.
 */
export async function checkJoinGate(member, { onKick = null } = {}) {
    try {
        const { guild, user } = member;
        if (guild.id !== enforcementConfig.mainGuildId || user.bot) return null;
        const settings = await getAutomodSettings(guild.id);
        if (!settings.enabled) return null;
        const { action, hits } = evaluateJoinGate(user, settings.joinGate);
        if (action === 'off') return null;
        // Verified with "Verify with Discord" before: already passed the verification guard.
        if (await getFromDb(`oauth:tokens:${user.id}`, null).catch(() => null)) return null;

        if (action === 'kick') {
            const kicked = await kickWithNotice(member, hits, `Join gate: ${hits.filter((h) => h.action === 'kick').map((h) => h.reason).join('; ')}`);
            if (kicked) {
                await postGateLine(member, hits, 'kicked', STATUS_COLORS.kept, false);
                await onKick?.(member.id);
                return 'kicked';
            }
            // Could not kick (role hierarchy, permissions): fall back to a flag for staff.
        }
        const message = await postGateLine(member, hits, action === 'kick' ? 'flagged (kick failed)' : 'flagged', STATUS_COLORS.waiting, true);
        if (message) {
            await setInDb(flagKey(guild.id, user.id), {
                channelId: message.channelId, messageId: message.id, hits: hits.map(({ check, reason }) => ({ check, reason })), at: Date.now(),
            }, FLAG_TTL_SECONDS).catch((error) => logger.warn(`Could not store join gate flag for ${user.id}: ${error.message}`));
        }
        return 'flagged';
    } catch (error) {
        logger.warn(`Join gate failed for ${member?.id}: ${error.message}`);
        return null;
    }
}

/** Closes a flag line: no buttons, grey or green, with who closed it and how. */
export async function closeGateLine(message, outcome) {
    const embed = message.embeds?.[0];
    const text = embed?.description || '🚪 **Join gate**';
    const closed = text.replace(/ · flagged(?: \(kick failed\))?/, ` · ${outcome}`);
    await message.edit({
        embeds: [createEmbed({ description: closed, color: outcome.startsWith('kicked') ? STATUS_COLORS.kept : STATUS_COLORS.undone })],
        components: [],
    }).catch((error) => logger.warn(`Could not close join gate line ${message.id}: ${error.message}`));
}

/** Gate settings as text for /automod joingate and /automod status. */
export function describeJoinGate(gate) {
    const settings = normalizeJoinGate(gate);
    return Object.entries(JOIN_GATE_CHECKS).map(([check, { label }]) => {
        const extra = check === 'age' ? ` (younger than ${settings.ageDays} day${settings.ageDays === 1 ? '' : 's'})` : '';
        return `${label}${extra}: **${settings[check]}**`;
    }).join(' · ');
}
