// selfCooldownService.js — /cooldown: a member puts themselves in a Discord timeout
// (member.timeout) to take a break. Native timeouts expire on their own and survive
// leave/rejoin, so there is no table, no cron and no schema change.
//
// Not a moderation case: no case row, no ladder, no DM, no mass-action count.
// Mewvo has no command to end it early. Staff can still remove any timeout: in Discord's
// own member menu, and on the dashboard Users page (Timeout → off); the prompt says only
// what is true for the member ("you can't end it early").
//
// State is in memory and lost on restart by design:
// - confirm prompts: bounded, 5 minute TTL (an expired prompt says "run /cooldown again");
// - the abuse guard (3 cooldowns per member per 24 h): bounded; a restart resets it.

import { randomBytes } from 'crypto';
import { PermissionFlagsBits } from 'discord.js';
import { EVENT_TYPES, logEvent } from '../loggingService.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The duration choices (value → label, ms). Discord allows timeouts up to 28 days. */
export const COOLDOWN_DURATIONS = {
    '1h': { label: '1 hour', ms: HOUR },
    '6h': { label: '6 hours', ms: 6 * HOUR },
    '12h': { label: '12 hours', ms: 12 * HOUR },
    '1d': { label: '1 day', ms: DAY },
    '3d': { label: '3 days', ms: 3 * DAY },
    '7d': { label: '7 days', ms: 7 * DAY },
};

export const REASON_MAX = 200;
export const PROMPT_TTL_MS = 5 * 60 * 1000;
export const PROMPT_MAX_ENTRIES = 1000;
export const LIMIT_PER_WINDOW = 3;
export const LIMIT_WINDOW_MS = DAY;
export const LIMIT_MAX_MEMBERS = 5000;
export const BUTTON_PREFIX = 'selfcooldown';
export const EXPIRED_MESSAGE = 'This expired, run /cooldown again.';

const ts = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;

// ---- confirm prompts (nonce → { userId, guildId, durationKey, reason, createdAt }) ----

const prompts = new Map();

function prunePrompts(now) {
    for (const [nonce, prompt] of prompts) {
        if (now - prompt.createdAt > PROMPT_TTL_MS) prompts.delete(nonce);
    }
    while (prompts.size > PROMPT_MAX_ENTRIES) prompts.delete(prompts.keys().next().value);
}

export function createPrompt(data, now = Date.now()) {
    prunePrompts(now);
    const nonce = randomBytes(6).toString('hex');
    prompts.set(nonce, { ...data, createdAt: now });
    return nonce;
}

/** Removes the prompt and returns it (null when missing or expired), so a double click runs once. */
export function takePrompt(nonce, now = Date.now()) {
    const prompt = prompts.get(nonce);
    prompts.delete(nonce);
    if (!prompt || now - prompt.createdAt > PROMPT_TTL_MS) return null;
    return prompt;
}

// ---- abuse guard (guildId:userId → start times in the last 24 h) ----

const usage = new Map();

function recentUses(key, now) {
    const list = (usage.get(key) || []).filter((at) => now - at < LIMIT_WINDOW_MS);
    if (list.length) usage.set(key, list); else usage.delete(key);
    return list;
}

/** null when allowed, otherwise { nextAt } (when the oldest of the 3 falls out of the window). */
export function checkLimit(guildId, userId, now = Date.now()) {
    const list = recentUses(`${guildId}:${userId}`, now);
    if (list.length < LIMIT_PER_WINDOW) return null;
    return { nextAt: list[0] + LIMIT_WINDOW_MS };
}

export function recordUse(guildId, userId, now = Date.now()) {
    const key = `${guildId}:${userId}`;
    const list = recentUses(key, now);
    list.push(now);
    usage.delete(key); // re-insert so the most recently used member is the newest entry
    usage.set(key, list);
    while (usage.size > LIMIT_MAX_MEMBERS) usage.delete(usage.keys().next().value);
}

/** Tests only. */
export function resetSelfCooldownState() {
    prompts.clear();
    usage.clear();
}

// ---- eligibility ----

/**
 * Why this member can't get a cooldown, or null when they can. Pure apart from reading the
 * member objects. Order: already timed out, server owner, Administrator, bot permission,
 * role hierarchy.
 */
export function refusalFor({ guild, member, botMember, now = Date.now() }) {
    const until = member?.communicationDisabledUntilTimestamp;
    if (until && until > now) {
        return `You are already in a timeout until ${ts(until, 'F')} (${ts(until, 'R')}).`;
    }
    if (guild?.ownerId && guild.ownerId === member?.id) {
        return 'You own this server, and Discord does not allow timeouts on the server owner, so I can\'t put a cooldown on you.';
    }
    if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) {
        return 'You have the Administrator permission, and Discord does not allow timeouts on administrators, so I can\'t put a cooldown on you.';
    }
    if (!botMember?.permissions?.has?.(PermissionFlagsBits.ModerateMembers)) {
        return 'I don\'t have the Timeout Members permission in this server, so I can\'t put a cooldown on you. Ask staff to give it to me.';
    }
    const mine = botMember?.roles?.highest?.position ?? 0;
    const theirs = member?.roles?.highest?.position ?? 0;
    if (theirs >= mine) {
        return 'I can\'t put a cooldown on you because your role is above mine.';
    }
    return null;
}

/** The confirm prompt text. */
export function promptText(durationKey, reason, now = Date.now()) {
    const { label, ms } = COOLDOWN_DURATIONS[durationKey];
    const until = now + ms;
    return [
        `**Cooldown for ${label}**`,
        `You won't be able to send messages, react, or join voice until ${ts(until, 'F')} (${ts(until, 'R')}).`,
        'You can\'t end it early: /cooldown has no undo and Mewvo has no command to end it, so only start it if you\'re sure.',
        reason ? `Reason (only staff see it): ${reason}` : null,
        '',
        `You can start up to ${LIMIT_PER_WINDOW} cooldowns in 24 hours.`,
    ].filter((line) => line !== null).join('\n');
}

/** The audit log reason (Discord: 512 characters max). */
export function auditReason(reason) {
    return (`Self-cooldown via /cooldown${reason ? `: ${reason}` : ''}`).slice(0, 512);
}

/**
 * Applies the timeout and logs it. Throws when Discord refuses (nothing was applied then).
 * Returns { until }. Records the use for the abuse guard only after success.
 */
export async function applySelfCooldown({ client, guild, member, durationKey, reason, now = Date.now(), log = logEvent }) {
    const { label, ms } = COOLDOWN_DURATIONS[durationKey];
    await member.timeout(ms, auditReason(reason));
    recordUse(guild.id, member.id, now);
    const until = now + ms;
    await Promise.resolve(log({
        client,
        guildId: guild.id,
        eventType: EVENT_TYPES.MEMBER_SELF_COOLDOWN,
        data: {
            title: 'Self-cooldown started',
            lines: [
                `**User:** <@${member.id}> (${member.user?.tag || member.id})`,
                `**ID:** \`${member.id}\``,
                `**Duration:** ${label}`,
                `**Until:** ${ts(until, 'F')} (${ts(until, 'R')})`,
                `**Reason:** ${reason || '*(none given)*'}`,
                'The member put themselves in a timeout with /cooldown. Not a moderation case.',
            ],
            userId: member.id,
        },
    })).catch(() => null);
    return { until };
}
