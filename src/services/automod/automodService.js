// automodService.js — checks every message in the main server against the rules,
// acts on the most severe hit, and posts a review card for moderators.
//
// Order for one message: skip (bots, exempt channels, administrators) → filters →
// the most severe hit is acted on: raid joiners during a lockdown are kicked,
// everyone else gets the next step of that rule's ladder (or, in monitor mode,
// nothing but the card) → new-member limits for messages that broke no rule.

import { PermissionFlagsBits } from 'discord.js';
import { AUTOMOD_RULES, automodConfig } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { query, T, isEnforcementDbAvailable } from '../enforcement/db.js';
import { executeSystemAction, isAdministrator } from '../enforcement/enforcementService.js';
import { formatDuration } from '../enforcement/format.js';
import { getAutomodSettings, isChannelExempt } from './automodSettings.js';
import { isRaidJoiner } from './raidService.js';
import { postReviewCard } from './reviewCards.js';
import {
    countMentions,
    detectCrossChannelSpam,
    detectNonEnglish,
    detectSpam,
    findBlockedWord,
    findForbiddenCharacters,
    findInsult,
    findInviteCodes,
    findNsfwDomain,
    findPersonalInfo,
    findScam,
    findSexualWord,
    hasLinkOrAttachment,
    isCapsFlood,
} from './filters.js';

const history = new Map();        // guildId:userId → [{ at, text, channelId }]
const cooldowns = new Map();      // guildId:userId:group → until
const harassment = new Map();     // guildId:authorId:targetId → [at]
const lastPost = new Map();       // guildId:userId → at (new-member slowmode)
const inviteGuilds = new Map();   // invite code → guild id | null
const handledMessages = new Set(); // message ids already acted on (edits re-run the checks)

const STAFF_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
];

export function isStaff(member) {
    if (!member) return false;
    if (member.guild?.ownerId === member.id) return true;
    return STAFF_PERMISSIONS.some((flag) => member.permissions?.has(flag));
}

/** Messages kept in memory are trimmed to the longest window any check needs. */
function remember(map, key, entry, windowMs, now) {
    const list = (map.get(key) || []).filter((item) => now - (item.at ?? item) <= windowMs);
    list.push(entry);
    map.set(key, list);
    return list;
}

function pruneMaps(now) {
    for (const [key, list] of history) {
        if (!list.length || now - list[list.length - 1].at > automodConfig.historyWindowMs) history.delete(key);
    }
    for (const [key, until] of cooldowns) if (until <= now) cooldowns.delete(key);
    for (const [key, list] of harassment) {
        if (!list.length || now - list[list.length - 1] > automodConfig.harassmentWindowMs) harassment.delete(key);
    }
    for (const [key, at] of lastPost) if (now - at > automodConfig.newMemberSlowmodeMs) lastPost.delete(key);
    if (handledMessages.size > 5000) handledMessages.clear();
    if (inviteGuilds.size > 1000) inviteGuilds.clear();
}

let lastPrune = 0;

async function inviteIsForeign(client, code) {
    if (!inviteGuilds.has(code)) {
        const invite = await client.fetchInvite(code).catch(() => null);
        inviteGuilds.set(code, invite?.guild?.id || null);
    }
    const guildId = inviteGuilds.get(code);
    return guildId !== enforcementConfig.mainGuildId && guildId !== enforcementConfig.supportGuildId;
}

/** The user ids a message is aimed at: mentioned users and the author of the replied-to message. */
async function targetsOf(message) {
    const ids = new Set(message.mentions?.users?.keys() || []);
    if (message.reference?.messageId) {
        const replied = message.mentions?.repliedUser?.id
            || (await message.fetchReference().catch(() => null))?.author?.id;
        if (replied) ids.add(replied);
    }
    ids.delete(message.author.id);
    ids.delete(message.client.user.id);
    return [...ids];
}

/**
 * All rules the message breaks: [{ rule, evidence, forceLastStep? }].
 * `member` is the author's guild member.
 */
export async function evaluateMessage(message, member, now = Date.now()) {
    const hits = [];
    const text = message.content || '';
    const key = `${message.guildId}:${message.author.id}`;
    const recent = remember(history, key, { at: now, text: text.trim().toLowerCase(), channelId: message.channelId }, automodConfig.historyWindowMs, now);

    const scam = findScam(text);
    if (scam) hits.push({ rule: 'scam', evidence: scam });

    const nsfw = findNsfwDomain(text);
    if (nsfw) hits.push({ rule: 'nsfw', evidence: `link to ${nsfw}` });

    const foreignInvites = [];
    for (const code of findInviteCodes(text)) {
        if (await inviteIsForeign(message.client, code)) foreignInvites.push(code);
    }
    const newAccount = now - message.author.createdTimestamp < automodConfig.adBotAccountAgeMs;
    const newJoiner = member?.joinedTimestamp && now - member.joinedTimestamp < automodConfig.adBotJoinAgeMs;
    const crossChannel = detectCrossChannelSpam(recent, now);
    if ((newAccount || newJoiner) && (foreignInvites.length || crossChannel)) {
        hits.push({
            rule: 'advertising',
            evidence: `advertising bot pattern: ${newAccount ? 'new account' : 'joined under a day ago'}, ${foreignInvites.length ? `invite ${foreignInvites[0]}` : 'same message in several channels'}`,
            forceLastStep: true,
        });
    } else if (foreignInvites.length) {
        hits.push({ rule: 'advertising', evidence: `invite to another server (${foreignInvites[0]})` });
    }

    const personal = findPersonalInfo(text);
    if (personal) hits.push({ rule: 'privacy', evidence: `contains ${personal}` });

    const blocked = findBlockedWord(text);
    if (blocked) hits.push({ rule: 'language', evidence: `blocked word "${blocked}"` });

    const sexual = findSexualWord(text);
    const insult = findInsult(text);
    const targets = (sexual || insult) ? await targetsOf(message) : [];
    if (sexual && targets.length) {
        hits.push({ rule: 'sexual', evidence: `"${sexual}" aimed at <@${targets[0]}>` });
    } else if (sexual) {
        hits.push({ rule: 'language', evidence: `sexual word "${sexual}"` });
    }
    if (insult && targets.length) {
        const target = targets[0];
        const times = remember(harassment, `${message.guildId}:${message.author.id}:${target}`, now, automodConfig.harassmentWindowMs, now);
        hits.push(times.length >= automodConfig.harassmentRepeats
            ? { rule: 'harassment', evidence: `${times.length} insults aimed at <@${target}> within ${formatDuration(automodConfig.harassmentWindowMs)} (latest: "${insult}")` }
            : { rule: 'disrespect', evidence: `insult "${insult}" aimed at <@${target}>` });
    }

    const mentions = countMentions(message);
    const canPingEveryone = member?.permissions?.has(PermissionFlagsBits.MentionEveryone);
    if (!isStaff(member) && (mentions.total >= automodConfig.mentionLimit || (mentions.everyone && !canPingEveryone))) {
        hits.push({ rule: 'mentions', evidence: mentions.everyone && !canPingEveryone ? 'tried to ping @everyone/@here' : `${mentions.total} mentions in one message` });
    }

    const spam = detectSpam(recent, now);
    if (spam) hits.push({ rule: 'spam', evidence: spam === 'flood' ? `${automodConfig.spamMessages}+ messages in ${automodConfig.spamWindowMs / 1000}s` : `same message ${automodConfig.duplicateMessages}+ times` });

    if (isCapsFlood(text)) hits.push({ rule: 'caps', evidence: 'mostly capital letters' });

    const characters = findForbiddenCharacters(text);
    if (characters) hits.push({ rule: 'characters', evidence: characters });

    const language = characters ? null : detectNonEnglish(text);
    if (language) hits.push({ rule: 'english', evidence: `written in another language (${language})` });

    return hits;
}

/** Earlier automod cases in this rule group within the repeat window. */
async function countOffences(guildId, userId, group) {
    const { rows } = await query(
        `SELECT COUNT(*)::int AS count FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = $2 AND reason_key = $3 AND is_test = FALSE
           AND created_at > NOW() - ($4::bigint * INTERVAL '1 millisecond')`,
        [guildId, userId, `automod:${group}`, automodConfig.repeatWindowMs]
    );
    return rows[0]?.count || 0;
}

/** Runs a punishment step through the normal enforcement path, as the bot. */
export async function applyStep({ guild, targetUser, step, rule, reason }) {
    return executeSystemAction({
        guild,
        targetUser,
        flow: {
            type: step.type,
            reason,
            reasonSource: 'prebuilt',
            reasonKey: `automod:${AUTOMOD_RULES[rule]?.group || rule}`,
            durationMs: step.durationMs ?? null,
            unappealable: false,
            name: `${targetUser.username} ${step.type}`,
            nameIsDefault: true,
        },
    });
}

function excerpt(message) {
    const text = message.content || '';
    const files = message.attachments?.size ? ` [${message.attachments.size} attachment(s)]` : '';
    return `${text}${files}` || '(no text)';
}

async function deleteQuietly(message) {
    await message.delete().catch((error) => {
        if (error?.code !== 10008) logger.warn(`Automod could not delete message ${message.id}: ${error.message}`);
    });
}

async function actOn(message, member, hit, settings) {
    const rule = AUTOMOD_RULES[hit.rule];
    const { guild } = message;
    const targetUser = message.author;
    const group = rule.group;
    const cooldownKey = `${guild.id}:${targetUser.id}:${group}`;
    const card = {
        guild, rule: hit.rule, evidence: hit.evidence, targetUser,
        channelId: message.channelId, messageUrl: message.url, content: excerpt(message),
    };

    if (settings.mode === 'monitor') {
        const offences = await countOffences(guild.id, targetUser.id, group);
        const step = rule.steps[hit.forceLastStep ? rule.steps.length - 1 : Math.min(offences, rule.steps.length - 1)];
        await postReviewCard({ ...card, monitor: true, suggested: step, offence: offences + 1 });
        return false;
    }

    if (rule.deleteMessage) await deleteQuietly(message);

    if ((cooldowns.get(cooldownKey) || 0) > Date.now()) return rule.deleteMessage;
    cooldowns.set(cooldownKey, Date.now() + automodConfig.ruleCooldownMs);

    if (await isRaidJoiner(guild.id, targetUser.id)) {
        if (!rule.deleteMessage) await deleteQuietly(message);
        const step = { type: 'kick' };
        const result = await applyStep({ guild, targetUser, step, rule: hit.rule, reason: `Automod: ${rule.label} during a join raid` })
            .catch((error) => ({ error }));
        await postReviewCard({ ...card, step, result, raid: true });
        return true;
    }

    const offences = await countOffences(guild.id, targetUser.id, group);
    const step = rule.steps[hit.forceLastStep ? rule.steps.length - 1 : Math.min(offences, rule.steps.length - 1)];
    const result = await applyStep({ guild, targetUser, step, rule: hit.rule, reason: `Automod: ${rule.label}` })
        .catch((error) => ({ error }));
    if (result.error) {
        logger.warn(`Automod ${hit.rule} on ${targetUser.id}: ${result.error.userMessage || result.error.message}`);
    }
    await postReviewCard({ ...card, step, result, offence: offences + 1 });
    return rule.deleteMessage;
}

/** New-member limits: no links or attachments and one message per slowmode interval. */
async function applyNewMemberLimits(message, member, now) {
    if (!member?.joinedTimestamp || now - member.joinedTimestamp >= automodConfig.newMemberMs) return false;

    let reason = null;
    if (hasLinkOrAttachment(message)) {
        reason = 'New members can post links and files after their first 3 days here.';
    } else {
        const key = `${message.guildId}:${message.author.id}`;
        if (now - (lastPost.get(key) || 0) < automodConfig.newMemberSlowmodeMs) {
            reason = `New members can send one message every ${automodConfig.newMemberSlowmodeMs / 1000} seconds for their first 3 days.`;
        } else {
            lastPost.set(key, now);
        }
    }
    if (!reason) return false;

    await deleteQuietly(message);
    const notice = await message.channel.send({
        content: `<@${message.author.id}> ${reason}`,
        allowedMentions: { users: [message.author.id] },
    }).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => {}), 8000).unref?.();
    return true;
}

/**
 * Runs automod on a new or edited message. Returns true when the message was
 * removed, so callers skip the rest of their processing (commands, XP).
 */
export async function moderateMessage(message, { edited = false } = {}) {
    try {
        if (!message.guild || message.guild.id !== enforcementConfig.mainGuildId) return false;
        if (message.author?.bot || message.webhookId || message.system) return false;
        if (!isEnforcementDbAvailable()) return false;
        if (edited && handledMessages.has(message.id)) return false;

        const settings = await getAutomodSettings(message.guild.id);
        if (!settings.enabled || await isChannelExempt(message.guild.id, message.channel)) return false;

        const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
        if (!member || isAdministrator(member)) return false;

        const now = Date.now();
        if (now - lastPrune > 60 * 1000) {
            pruneMaps(now);
            lastPrune = now;
        }

        const hits = await evaluateMessage(message, member, now);
        if (hits.length) {
            handledMessages.add(message.id);
            const worst = hits.reduce((a, b) => (AUTOMOD_RULES[b.rule].severity > AUTOMOD_RULES[a.rule].severity ? b : a));
            return await actOn(message, member, worst, settings);
        }
        if (edited || isStaff(member)) return false;
        return await applyNewMemberLimits(message, member, now);
    } catch (error) {
        logger.error(`Automod failed on message ${message?.id}: ${error.message}`, { error });
        return false;
    }
}

/** Test hook: forget all in-memory state. */
export function resetAutomodState() {
    for (const map of [history, cooldowns, harassment, lastPost, inviteGuilds]) map.clear();
    handledMessages.clear();
}

const AUTOMOD_PERMISSIONS = [
    ['ManageMessages', 'Manage Messages (delete messages)'],
    ['ManageRoles', 'Manage Roles (mutes, warning roles, staff guard)'],
    ['KickMembers', 'Kick Members'],
    ['BanMembers', 'Ban Members'],
    ['ManageNicknames', 'Manage Nicknames (reset impersonating nicknames)'],
    ['ViewAuditLog', 'View Audit Log (staff guard)'],
    ['ManageGuild', 'Manage Server (raid lockdown verification level)'],
    ['ManageChannels', 'Manage Channels (auto slowmode, server snapshots)'],
    ['ManageWebhooks', 'Manage Webhooks (anti-nuke webhook cleanup)'],
];

/** One startup line: what automod can't do with the bot's current permissions. */
export async function describeAutomodReadiness(client) {
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    if (!guild) return 'skipped: the bot is not in the main server';
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me) return 'skipped: could not read my permissions';

    const missing = AUTOMOD_PERMISSIONS.filter(([flag]) => !me.permissions.has(PermissionFlagsBits[flag])).map(([, label]) => label);
    const settings = await getAutomodSettings(guild.id).catch(() => null);
    const state = settings ? `${settings.enabled ? 'on' : 'off'}, ${settings.mode}` : 'settings unavailable';
    return missing.length ? `${state}; missing permissions: ${missing.join(', ')}` : `${state}; all permissions present`;
}
