// automodService.js — checks every message in the main server against the rules,
// acts on the most severe hit, and posts a review card for moderators
// (reviewCards.js: a compact line for light hits, a full card for serious ones,
// grouped per member and rule during a burst).
//
// Order for one message: skip (bots, exempt channels, administrators) → filters →
// each hit gets its rule's mode (policy.js: on / monitor / off; off hits are dropped) →
// the most severe remaining hit is acted on: raid joiners during a lockdown are kicked,
// everyone else gets the next step of that rule's ladder (or, when the rule is in
// monitor mode, nothing but the card) → new-member limits for messages that broke no
// rule that is on or monitored.

import { PermissionFlagsBits } from 'discord.js';
import { AUTOMOD_RULES, automodConfig } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { query, T, isEnforcementDbAvailable } from '../enforcement/db.js';
import { executeSystemAction, isAdministrator } from '../enforcement/enforcementService.js';
import { getAutomodSettings, isChannelExempt } from './automodSettings.js';
import { isRaidJoiner } from './raidService.js';
import { getProbation } from './probationService.js';
import { noteMoodSignals } from './moodService.js';
import { getUserLevelData } from '../leveling/leveling.js';
import {
    hasTrustedRole, isTrustedMember, ladderIndex, relaxForTrusted, resolveRuleMode, secondChanceEligible, secondChanceNotice, trustMatters,
} from './policy.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { noteRepeatHit, postReviewCard } from './reviewCards.js';
import * as reasons from './reasons.js';
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
const levelCache = new Map();     // guildId:userId → { level, expiresAt } (trusted members)

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
    for (const [key, entry] of levelCache) if (entry.expiresAt <= now) levelCache.delete(key);
}

let lastPrune = 0;

async function inviteIsForeign(client, code) {
    if (!inviteGuilds.has(code)) {
        const invite = await client.fetchInvite(code).catch(() => null);
        inviteGuilds.set(code, invite?.guild?.id || null);
    }
    const guildId = inviteGuilds.get(code);
    // A code that doesn't resolve (expired, mistyped, lookup failed) advertises nothing.
    if (!guildId) return false;
    return guildId !== enforcementConfig.mainGuildId && guildId !== enforcementConfig.supportGuildId;
}

// Each code costs one API call; more than this in one message is advertising anyway.
const MAX_INVITE_LOOKUPS = 3;

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
 * All rules the message breaks: [{ rule, evidence, detail, forceLastStep? }].
 * `evidence` is the plain-English reason shown on the review card (reasons.js); it never
 * repeats a blocked or sexual word. `detail` is the technical match, for the log only.
 * `member` is the author's guild member.
 */
export async function evaluateMessage(message, member, now = Date.now()) {
    const hits = [];
    const text = message.content || '';
    const key = `${message.guildId}:${message.author.id}`;
    const recent = remember(history, key, { at: now, text: text.trim().toLowerCase(), channelId: message.channelId }, automodConfig.historyWindowMs, now);

    const scam = findScam(text);
    if (scam) hits.push({ rule: 'scam', evidence: reasons.scamReason(scam), detail: scam });

    const nsfw = findNsfwDomain(text);
    if (nsfw) hits.push({ rule: 'nsfw', evidence: reasons.nsfwReason(nsfw), detail: `link to ${nsfw}` });

    const inviteCodes = findInviteCodes(text);
    const foreignInvites = [];
    if (inviteCodes.length > MAX_INVITE_LOOKUPS) {
        foreignInvites.push(...inviteCodes);
    } else {
        for (const code of inviteCodes) {
            if (await inviteIsForeign(message.client, code)) foreignInvites.push(code);
        }
    }
    const newAccount = now - message.author.createdTimestamp < automodConfig.adBotAccountAgeMs;
    const newJoiner = member?.joinedTimestamp && now - member.joinedTimestamp < automodConfig.adBotJoinAgeMs;
    const crossChannel = detectCrossChannelSpam(recent, now);
    if ((newAccount || newJoiner) && (foreignInvites.length || crossChannel)) {
        const channelCount = crossChannelCount(recent, now);
        hits.push({
            rule: 'advertising',
            evidence: reasons.adBotReason({ newAccount, invite: foreignInvites[0] || null, channelCount }),
            detail: `ad-bot pattern: ${newAccount ? 'new account' : 'joined under a day ago'}; invites [${foreignInvites.join(', ')}]; same text in ${channelCount} channel(s)`,
            forceLastStep: true,
        });
    } else if (foreignInvites.length) {
        hits.push({ rule: 'advertising', evidence: reasons.inviteReason(foreignInvites[0]), detail: `foreign invites [${foreignInvites.join(', ')}]` });
    }

    const personal = findPersonalInfo(text);
    if (personal) hits.push({ rule: 'privacy', evidence: reasons.privacyReason(personal), detail: `contains ${personal}` });

    const blocked = findBlockedWord(text);
    if (blocked) hits.push({ rule: 'language', evidence: reasons.blockedWordReason(), detail: `blocked word "${blocked}"`, slur: true });

    const sexual = findSexualWord(text);
    const insult = findInsult(text);
    const targets = (sexual || insult) ? await targetsOf(message) : [];
    if (sexual && targets.length) {
        hits.push({ rule: 'sexual', evidence: reasons.sexualReason(targets[0]), detail: `sexual word "${sexual}" aimed at ${targets[0]}` });
    } else if (sexual) {
        hits.push({ rule: 'language', evidence: reasons.sexualReason(), detail: `sexual word "${sexual}"` });
    }
    if (insult && targets.length) {
        const target = targets[0];
        const times = remember(harassment, `${message.guildId}:${message.author.id}:${target}`, now, automodConfig.harassmentWindowMs, now);
        hits.push(times.length >= automodConfig.harassmentRepeats
            ? {
                rule: 'harassment',
                evidence: reasons.harassmentReason(target, times.length, automodConfig.harassmentWindowMs),
                detail: `${times.length} insults aimed at ${target}; latest "${insult}"`,
            }
            : { rule: 'disrespect', evidence: reasons.disrespectReason(target), detail: `insult "${insult}" aimed at ${target}` });
    }

    const mentions = countMentions(message);
    const canPingEveryone = member?.permissions?.has(PermissionFlagsBits.MentionEveryone);
    if (!isStaff(member) && (mentions.total >= automodConfig.mentionLimit || (mentions.everyone && !canPingEveryone))) {
        const everyone = Boolean(mentions.everyone && !canPingEveryone);
        hits.push({ rule: 'mentions', evidence: reasons.mentionsReason({ everyone, total: mentions.total }), detail: `${mentions.total} mentions, everyone=${Boolean(mentions.everyone)}` });
    }

    const spam = detectSpam(recent, now);
    if (spam) {
        hits.push({
            rule: 'spam',
            evidence: reasons.spamReason(spam, {
                messages: automodConfig.spamMessages,
                windowMs: automodConfig.spamWindowMs,
                duplicates: automodConfig.duplicateMessages,
                duplicateWindowMs: automodConfig.duplicateWindowMs,
            }),
            detail: `spam: ${spam}`,
        });
    }

    if (isCapsFlood(text)) hits.push({ rule: 'caps', evidence: reasons.capsReason(), detail: 'caps flood' });

    const characters = findForbiddenCharacters(text);
    if (characters) hits.push({ rule: 'characters', evidence: reasons.charactersReason(characters), detail: characters });

    const language = characters ? null : detectNonEnglish(text);
    if (language) hits.push({ rule: 'english', evidence: reasons.englishReason(language), detail: `detected language ${language}` });

    return hits;
}

/** In how many channels the newest text was posted within the ad-bot window. */
function crossChannelCount(recent, now) {
    const last = recent[recent.length - 1];
    if (!last?.text) return 0;
    return new Set(recent
        .filter((entry) => now - entry.at <= automodConfig.adBotWindowMs && entry.text === last.text)
        .map((entry) => entry.channelId)).size;
}

/** Earlier automod cases in this rule group within the repeat window. */
async function countOffences(guildId, userId, group) {
    const { rows } = await query(
        `SELECT COUNT(*)::int AS count FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = $2 AND reason_key = $3 AND is_test = FALSE AND voided_at IS NULL
           AND created_at > NOW() - ($4::bigint * INTERVAL '1 millisecond')`,
        [guildId, userId, `automod:${group}`, automodConfig.repeatWindowMs]
    );
    return rows[0]?.count || 0;
}

/** Runs a punishment step through the normal enforcement path, as the bot. */
export async function applyStep({ guild, targetUser, step, rule, reason, contestable = false }) {
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
            // The DM gets a "Contest this" button when the member's message was deleted.
            contestable: Boolean(contestable),
        },
    });
}

function excerpt(message) {
    const text = message.content || '';
    const files = message.attachments?.size ? ` [${message.attachments.size} attachment(s)]` : '';
    return `${text}${files}`.trim();
}

async function deleteQuietly(message) {
    await message.delete().catch((error) => {
        if (error?.code !== 10008) logger.warn(`Automod could not delete message ${message.id}: ${error.message}`);
    });
}

const secondChanceKey = (guildId, userId, rule) => `automod:secondchance:${guildId}:${userId}:${rule}`;

/**
 * Second chance (policy.secondChanceEligible): instead of the first step, a short notice
 * in the channel (deleted after secondChanceNoticeMs, pinging only the member) and a
 * compact line in the review channel. Deleting rules have already removed the message.
 * Recorded per guild + user + rule for secondChanceWindowMs, so the next hit acts
 * normally. A failed read or write of that record means no second chance.
 * Returns true when the second chance was given.
 */
async function giveSecondChance(message, hit, { settings, offences, card, probation = null }) {
    const base = { hit, enabled: settings.secondChance, offences, alreadyUsed: false, probation: Boolean(probation) };
    if (!secondChanceEligible(base)) return false;
    const { guild, author } = message;
    const key = secondChanceKey(guild.id, author.id, hit.rule);
    const now = Date.now();
    try {
        const used = await getFromDb(key, null);
        if (!secondChanceEligible({ ...base, alreadyUsed: Boolean(used && Number(used.until) > now) })) return false;
        await setInDb(key, { at: now, until: now + automodConfig.secondChanceWindowMs, channelId: message.channelId },
            Math.ceil(automodConfig.secondChanceWindowMs / 1000));
    } catch (error) {
        logger.warn(`Automod second chance for ${author.id} skipped (${error.message}); acting normally`);
        return false;
    }

    const deleted = Boolean(AUTOMOD_RULES[hit.rule]?.deleteMessage);
    const notice = await message.channel.send({
        content: secondChanceNotice(hit.rule, author.id, deleted),
        allowedMentions: { users: [author.id] },
    }).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => {}), automodConfig.secondChanceNoticeMs).unref?.();
    await postReviewCard({ ...card, note: { emoji: '💬', title: 'Second chance' }, deleted });
    return true;
}

/**
 * Acts on one hit. `hit.mode` is the rule's effective mode ('on' | 'monitor'; 'off'
 * hits never get here). `probation`: the member's running probation record or null.
 */
async function actOn(message, member, hit, settings, probation = null) {
    const rule = AUTOMOD_RULES[hit.rule];
    const { guild } = message;
    const targetUser = message.author;
    const group = rule.group;
    const cooldownKey = `${guild.id}:${targetUser.id}:${group}`;
    const card = {
        guild, rule: hit.rule, evidence: hit.evidence, detail: hit.detail, targetUser,
        channelId: message.channelId, messageUrl: message.url, content: excerpt(message), probation,
    };
    const stepFor = (offences) => rule.steps[ladderIndex({
        offences, stepCount: rule.steps.length, forceLastStep: hit.forceLastStep, probation: Boolean(probation),
    })];

    if (hit.mode === 'monitor') {
        const offences = await countOffences(guild.id, targetUser.id, group);
        await postReviewCard({ ...card, monitor: true, suggested: stepFor(offences), offence: offences + 1, deleted: false });
        return false;
    }

    if (rule.deleteMessage) await deleteQuietly(message);

    if ((cooldowns.get(cooldownKey) || 0) > Date.now()) {
        // Same rule again right after acting: no new punishment, but the open card counts it.
        await noteRepeatHit({ ...card, deleted: rule.deleteMessage });
        return rule.deleteMessage;
    }
    cooldowns.set(cooldownKey, Date.now() + automodConfig.ruleCooldownMs);

    // Read-only decision: on a database error treat them as an ordinary member.
    if (await isRaidJoiner(guild.id, targetUser.id).catch(() => false)) {
        if (!rule.deleteMessage) await deleteQuietly(message);
        const step = { type: 'kick' };
        const result = await applyStep({ guild, targetUser, step, rule: hit.rule, reason: `Automod: ${rule.label} during a join raid` })
            .catch((error) => ({ error }));
        await postReviewCard({ ...card, step, result, raid: true, deleted: true });
        return true;
    }

    const offences = await countOffences(guild.id, targetUser.id, group);
    if (await giveSecondChance(message, hit, { settings, offences, card, probation })) return rule.deleteMessage;
    const step = stepFor(offences);
    const result = await applyStep({
        guild, targetUser, step, rule: hit.rule, reason: `Automod: ${rule.label}`, contestable: Boolean(rule.deleteMessage),
    })
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
 * Each hit with its effective mode (policy.js); hits of rules that are off are dropped.
 * When one message breaks several rules, the most severe remaining one decides
 * (worstHit), including whether it is enforced or only monitored.
 */
export function applyRuleModes(hits, settings, channel = null) {
    return hits
        .map((hit) => ({ ...hit, mode: resolveRuleMode(settings, hit.rule, channel) }))
        .filter((hit) => hit.mode !== 'off');
}

/**
 * Trusted member check (/automod trusted). Only called when a relaxable rule was hit,
 * so the level is read on such hits only, and cached for trustedLevelCacheMs. A failed
 * level read counts as not trusted: the rule then applies as usual.
 */
async function isTrusted(member, trusted) {
    const roleIds = member.roles?.cache;
    if (hasTrustedRole(roleIds, trusted)) return true;
    if (!(Number(trusted?.minLevel) > 0)) return false;
    const key = `${member.guild.id}:${member.id}`;
    const now = Date.now();
    let cached = levelCache.get(key);
    if (!cached || cached.expiresAt <= now) {
        const level = await getUserLevelData(member.client, member.guild.id, member.id)
            .then((data) => data.level)
            .catch((error) => {
                logger.warn(`Automod could not read the level of ${member.id}: ${error.message}`);
                return null;
            });
        cached = { level, expiresAt: now + (level === null ? 60 * 1000 : automodConfig.trustedLevelCacheMs) };
        levelCache.set(key, cached);
    }
    return isTrustedMember({ roleIds, level: cached.level }, trusted);
}

export function worstHit(hits) {
    return hits.reduce((a, b) => (AUTOMOD_RULES[b.rule].severity > AUTOMOD_RULES[a.rule].severity ? b : a));
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

        const detected = await evaluateMessage(message, member, now);
        let hits = applyRuleModes(detected, settings, message.channel);
        // Channel mood from the same hits (in memory, no extra reads); runs alongside.
        if (!edited && hits.length) {
            noteMoodSignals(message, hits, settings).catch((error) => logger.warn(`Mood tracking failed: ${error.message}`));
        }
        // Probation is read only when a rule was hit (cached briefly). Read-only decision:
        // on a database error treat them as not on probation.
        const probation = hits.length
            ? await getProbation(message.guild.id, message.author.id).catch((error) => {
                logger.warn(`Automod could not read probation for ${message.author.id}: ${error.message}`);
                return null;
            })
            : null;
        if (!probation && trustMatters(hits, settings.trusted) && await isTrusted(member, settings.trusted)) {
            hits = relaxForTrusted(hits, true);
        }
        if (hits.length) {
            handledMessages.add(message.id);
            return await actOn(message, member, worstHit(hits), settings, probation);
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
    for (const map of [history, cooldowns, harassment, lastPost, inviteGuilds, levelCache]) map.clear();
    handledMessages.clear();
}

const AUTOMOD_PERMISSIONS = [
    ['ManageMessages', 'Manage Messages (delete messages)'],
    ['ManageRoles', 'Manage Roles (mutes, warning roles, staff guard)'],
    ['KickMembers', 'Kick Members'],
    ['BanMembers', 'Ban Members'],
    ['ManageNicknames', 'Manage Nicknames (reset impersonating nicknames)'],
    ['ViewAuditLog', 'View Audit Log (staff guard)'],
    ['ManageGuild', 'Manage Server (raid lockdown verification level; native AutoMod events for /automod native)'],
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
