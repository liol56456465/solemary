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
//
// The server's custom rules (customRules.js) are one more check: their hits have rule key
// "custom-<id>" and carry their own definition (label, group "custom:<id>", one step or
// none for delete-only), so the same path above handles them. They follow the global mode.

import { PermissionFlagsBits } from 'discord.js';
import { AUTOMOD_RULES, automodConfig } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { query, T, isEnforcementDbAvailable } from '../enforcement/db.js';
import { executeSystemAction, isAdministrator } from '../enforcement/enforcementService.js';
import { getAutomodSettings, isChannelExempt } from './automodSettings.js';
import { isRaidJoiner, noteIncidentEvent } from './raidService.js';
import { getProbation } from './probationService.js';
import { noteMoodSignals } from './moodService.js';
import { getUserLevelData } from '../leveling/leveling.js';
import {
    hasTrustedRole, headsUpAllowedFor, headsUpApplies, isTrustedMember, ladderIndex, relaxForTrusted, resolveRuleMode, sameHeadsUpFamily,
    secondChanceEligible, secondChanceNotice, trustMatters,
} from './policy.js';
import { dueHeadsUps, finishHeadsUp, giveHeadsUp, peekHeadsUp, pendingHeadsUpRule, takeHeadsUp } from './headsUp.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { noteRepeatHit, postReviewCard } from './reviewCards.js';
import * as reasons from './reasons.js';
import { customRuleDefinition, customRuleKey, findCustomRuleHit, resetCustomRulesCache, ruleDefinition } from './customRules.js';
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
    return inviteGuildIsForeign(inviteGuilds.get(code));
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

/** Whether an invite's guild id points outside our two servers (null: it advertises nothing). */
export function inviteGuildIsForeign(guildId) {
    // A code that doesn't resolve (expired, mistyped, lookup failed) advertises nothing.
    if (!guildId) return false;
    return guildId !== enforcementConfig.mainGuildId && guildId !== enforcementConfig.supportGuildId;
}

/**
 * All rules the message breaks: [{ rule, evidence, detail, forceLastStep? }].
 * `evidence` is the plain-English reason shown on the review card (reasons.js); it never
 * repeats a blocked or sexual word. `detail` is the technical match, for the log only.
 * `member` is the author's guild member.
 *
 * Live path: records the message in the per-member history (spam, cross-channel) and
 * counts insults per target (harassment), then builds the hits with collectHits.
 */
export async function evaluateMessage(message, member, now = Date.now()) {
    const text = message.content || '';
    const key = `${message.guildId}:${message.author.id}`;
    const recent = remember(history, key, { at: now, text: text.trim().toLowerCase(), channelId: message.channelId }, automodConfig.historyWindowMs, now);
    const timing = {
        newAccount: now - message.author.createdTimestamp < automodConfig.adBotAccountAgeMs,
        newJoiner: member?.joinedTimestamp && now - member.joinedTimestamp < automodConfig.adBotJoinAgeMs,
        crossChannel: detectCrossChannelSpam(recent, now),
        channelCount: () => crossChannelCount(recent, now),
        harassmentTimes: (target) => remember(harassment, `${message.guildId}:${message.author.id}:${target}`, now, automodConfig.harassmentWindowMs, now),
        spam: () => detectSpam(recent, now),
    };
    return collectHits(message, member, {
        isForeignInvite: (code) => inviteIsForeign(message.client, code),
        matchCustom: (value) => findCustomRuleHit(value, message.guildId, now),
        timing,
    });
}

/**
 * Content checks only: the hits one message's own content produces, with no history.
 * Reads and writes none of the live state (history, harassment counts, invite cache,
 * cooldowns, custom rule cache), so the automod test run (backtest.js) can call it on old
 * messages. Skipped: spam, the ad-bot pattern (new account or joiner plus invites or the
 * same text in several channels) and harassment over time (an insult aimed at someone is
 * always Disrespect here). Everything else gives the same hits as evaluateMessage.
 * options: { isForeignInvite(code) → Promise<boolean>, matchCustom(text) → { rule, word } | null }.
 */
export function contentHits(message, member, { isForeignInvite = async () => false, matchCustom = () => null } = {}) {
    return collectHits(message, member, { isForeignInvite, matchCustom, timing: null });
}

/**
 * Builds the hit list in a fixed order (worstHit keeps the first of equal severity).
 * `timing`: the live history helpers, or null for content only.
 */
async function collectHits(message, member, { isForeignInvite, matchCustom, timing }) {
    const hits = [];
    const text = message.content || '';

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
            if (await isForeignInvite(code)) foreignInvites.push(code);
        }
    }
    if (timing && (timing.newAccount || timing.newJoiner) && (foreignInvites.length || timing.crossChannel)) {
        const { newAccount } = timing;
        const channelCount = timing.channelCount();
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
        const times = timing ? timing.harassmentTimes(target) : null;
        hits.push(times && times.length >= automodConfig.harassmentRepeats
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

    const spam = timing ? timing.spam() : null;
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

    // The server's own word filters (customRules.js; only the rules the owner's plan allows).
    const custom = matchCustom(text);
    if (custom) hits.push(customHit(custom));

    return hits;
}

/** A custom rule match ({ rule, word }) → a hit for the pipeline. */
export function customHit({ rule, word }) {
    return {
        rule: customRuleKey(rule.id),
        evidence: reasons.customRuleReason(rule.name),
        detail: `custom rule "${rule.name}" matched "${word}"`,
        definition: customRuleDefinition(rule),
        ruleLabel: rule.name,
    };
}

/** The rule a hit belongs to: a built-in rule, or the custom rule the hit carries. */
function definitionOf(hit) {
    return hit.definition || ruleDefinition(hit.rule);
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
/** The case reason_key: "automod:<group>" (custom rules pass their group, "custom:<id>"). */
export function reasonKeyFor(rule, group = null) {
    return `automod:${group || AUTOMOD_RULES[rule]?.group || rule}`;
}

export async function applyStep({ guild, targetUser, step, rule, reason, contestable = false, group = null }) {
    return executeSystemAction({
        guild,
        targetUser,
        flow: {
            type: step.type,
            reason,
            reasonSource: 'prebuilt',
            reasonKey: reasonKeyFor(rule, group),
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
    await postReviewCard({ ...card, note: { title: 'Friendly notice (first small offence)' }, deleted });
    return true;
}

// Side effects of actOn, replaceable in tests (setAutomodDepsForTest).
const defaultDeps = {
    countOffences: (...args) => countOffences(...args),
    applyStep: (...args) => applyStep(...args),
    postReviewCard: (...args) => postReviewCard(...args),
    noteRepeatHit: (...args) => noteRepeatHit(...args),
    deleteQuietly: (...args) => deleteQuietly(...args),
    isRaidJoiner: (...args) => isRaidJoiner(...args),
    noteIncidentEvent: (...args) => noteIncidentEvent(...args),
    giveSecondChance: (...args) => giveSecondChance(...args),
    giveHeadsUp: (...args) => giveHeadsUp(...args),
    getAutomodSettings: (...args) => getAutomodSettings(...args),
    getProbation: (...args) => getProbation(...args),
};
let deps = { ...defaultDeps };

/** Test hook: replace some side effects of actOn (no argument restores all). */
export function setAutomodDepsForTest(overrides = null) {
    deps = overrides ? { ...defaultDeps, ...overrides } : { ...defaultDeps };
}

/**
 * Raid timeline: what automod did that left no case (delete only, or a step that failed),
 * only while a lockdown runs; actions with a case come from mod_cases. Not awaited; never throws.
 */
function noteIncident(guildId, userId, detail) {
    Promise.resolve()
        .then(() => deps.noteIncidentEvent(guildId, { kind: 'automod', targetId: userId, detail }))
        .catch((error) => logger.warn(`Raid timeline: automod event failed: ${error.message}`));
}

/**
 * Acts on one hit. `hit.mode` is the rule's effective mode ('on' | 'monitor'; 'off'
 * hits never get here). `probation`: the member's running probation record or null.
 * A custom rule with the delete action has no steps: the message is deleted and the
 * card posted, no case.
 * Heads-up first (headsUp.js): for the rules policy.headsUpApplies allows, the member's
 * first hit within 30 days gets a DM and two minutes to fix it instead of the action;
 * the message then stays (personal info is deleted at once) and is not marked handled,
 * so an edit is checked again. `skipHeadsUp`: the per-minute check acting after the wait.
 */
export async function actOn(message, member, hit, settings, probation = null, { skipHeadsUp = false } = {}) {
    const rule = definitionOf(hit);
    const { guild } = message;
    const targetUser = message.author;
    const group = rule.group;
    const cooldownKey = `${guild.id}:${targetUser.id}:${group}`;
    const card = {
        guild, rule: hit.rule, evidence: hit.evidence, detail: hit.detail, targetUser,
        channelId: message.channelId, messageUrl: message.url, content: excerpt(message), probation,
        ...(hit.ruleLabel ? { ruleLabel: hit.ruleLabel } : {}),
    };
    const punishes = rule.steps.length > 0;
    const stepFor = (offences) => rule.steps[ladderIndex({
        offences, stepCount: rule.steps.length, forceLastStep: hit.forceLastStep, probation: Boolean(probation),
    })];

    if (hit.mode === 'monitor') {
        if (!punishes) {
            await deps.postReviewCard({ ...card, monitor: true, suggested: null, deleted: false });
            return false;
        }
        const offences = await deps.countOffences(guild.id, targetUser.id, group);
        await deps.postReviewCard({ ...card, monitor: true, suggested: stepFor(offences), offence: offences + 1, deleted: false });
        return false;
    }

    if (!skipHeadsUp && headsUpApplies({ hit, settings, probation: Boolean(probation) })) {
        const given = await deps.giveHeadsUp(message, hit, { card, deleteMessage: () => deps.deleteQuietly(message) });
        if (given === 'pending') {
            handledMessages.delete(message.id);
            return false;
        }
        if (given === 'removed') return true;
    }

    if (rule.deleteMessage) await deps.deleteQuietly(message);

    if ((cooldowns.get(cooldownKey) || 0) > Date.now()) {
        // Same rule again right after acting: no new punishment, but the open card counts it.
        await deps.noteRepeatHit({ ...card, deleted: rule.deleteMessage });
        return rule.deleteMessage;
    }
    cooldowns.set(cooldownKey, Date.now() + automodConfig.ruleCooldownMs);

    // Read-only decision: on a database error treat them as an ordinary member.
    if (await deps.isRaidJoiner(guild.id, targetUser.id).catch(() => false)) {
        if (!rule.deleteMessage) await deps.deleteQuietly(message);
        const step = { type: 'kick' };
        const result = await deps.applyStep({ guild, targetUser, step, rule: hit.rule, group, reason: `Automod: ${rule.label} during a join raid` })
            .catch((error) => ({ error }));
        // A kick that worked is a case (merged into the timeline from mod_cases); only a failure is noted.
        if (result.error) noteIncident(guild.id, targetUser.id, `${hit.ruleLabel || rule.label}: message deleted, kick of a raid joiner failed`);
        await deps.postReviewCard({ ...card, step, result, raid: true, deleted: true });
        return true;
    }

    if (!punishes) {
        // Delete only: the card lets a moderator apply a punishment if one is needed.
        noteIncident(guild.id, targetUser.id, `${hit.ruleLabel || rule.label}: message deleted`);
        await deps.postReviewCard({ ...card, deleted: true });
        return true;
    }

    const offences = await deps.countOffences(guild.id, targetUser.id, group);
    if (await deps.giveSecondChance(message, hit, { settings, offences, card, probation })) return rule.deleteMessage;
    const step = stepFor(offences);
    const result = await deps.applyStep({
        guild, targetUser, step, rule: hit.rule, group, reason: `Automod: ${rule.label}`, contestable: Boolean(rule.deleteMessage),
    })
        .catch((error) => ({ error }));
    if (result.error) {
        logger.warn(`Automod ${hit.rule} on ${targetUser.id}: ${result.error.userMessage || result.error.message}`);
    }
    if (result.error) noteIncident(guild.id, targetUser.id, `${hit.ruleLabel || rule.label}: ${rule.deleteMessage ? 'message deleted, ' : ''}${step.type} failed`);
    await deps.postReviewCard({ ...card, step, result, offence: offences + 1, deleted: Boolean(rule.deleteMessage) });
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

/**
 * How a message with hits is handled. Personal info together with another rule: no
 * heads-up at all, the message is deleted at once and the worst hit is acted on as usual
 * (personal info never stays up, and the other rule is never downgraded or forgotten).
 * Otherwise a heads-up only when every hit allows one and the message had none yet.
 */
export function headsUpPlan(hits, settings, { probation = false, hadHeadsUp = false } = {}) {
    const rules = new Set(hits.map((hit) => hit.rule));
    if (rules.has('privacy') && rules.size > 1) return { hit: worstHit(hits), skipHeadsUp: true, deleteFirst: true };
    const skipHeadsUp = hadHeadsUp || !headsUpAllowedFor(hits, settings, Boolean(probation));
    return { hit: worstHit(hits), skipHeadsUp, deleteFirst: false };
}

export function worstHit(hits) {
    return hits.reduce((a, b) => (definitionOf(b).severity > definitionOf(a).severity ? b : a));
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

        let detected = await evaluateMessage(message, member, now);
        // An edit of a message that already had its heads-up never gets a second one.
        const hadHeadsUp = edited && Boolean(pendingHeadsUpRule(message.guild.id, message.id));
        if (edited) {
            detected = await checkEditedHeadsUp(message, detected);
            if (detected === null) return false;
        }
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
            const plan = headsUpPlan(hits, settings, { probation, hadHeadsUp });
            if (plan.deleteFirst) await deps.deleteQuietly(message);
            return await actOn(message, member, plan.hit, settings, probation, { skipHeadsUp: plan.skipHeadsUp });
        }
        if (edited || isStaff(member)) return false;
        return await applyNewMemberLimits(message, member, now);
    } catch (error) {
        logger.error(`Automod failed on message ${message?.id}: ${error.message}`, { error });
        return false;
    }
}

// ── Heads-up first: resolving the wait ────────────────────────────────────────

/**
 * An edit of a message with a waiting heads-up. Still breaking only that rule: keep
 * waiting (null, so the caller stops). No longer breaking it: fixed. Breaking it and
 * another rule: the heads-up is closed as acted and every hit goes on, the heads-up
 * rule's included (the caller skips a new heads-up). A database error leaves the
 * heads-up for the per-minute check.
 */
export async function checkEditedHeadsUp(message, detected) {
    const rule = pendingHeadsUpRule(message.guild.id, message.id);
    if (!rule) return detected;
    const same = (hit) => sameHeadsUpFamily(hit.rule, rule) && !hit.slur;
    const stillBad = detected.some(same);
    // Still breaking only that rule: keep waiting. Breaking it AND another rule: every hit
    // goes on (the heads-up rule's included), so it is acted on now, never dropped.
    if (stillBad && detected.every(same)) return null;
    try {
        const record = await takeHeadsUp(message.guild.id, message.id);
        if (record) await finishHeadsUp(message.client, record, stillBad ? 'acted' : 'edited', stillBad ? 'the edit broke another rule' : null);
    } catch (error) {
        logger.warn(`Automod heads-up for edited message ${message.id} not resolved (${error.message}); the per-minute check retries`);
    }
    return detected;
}

/**
 * Whether a message still breaks the rule of its waiting heads-up, without touching the
 * spam / harassment history: the hit to act on, or null. `record`: the waiting record.
 */
export async function recheckHeadsUp(message, record) {
    const text = message.content || '';
    const { rule } = record;
    const stored = { ...record.hit, rule };
    if (String(rule).startsWith('custom-')) {
        const found = findCustomRuleHit(text, message.guildId);
        return found && customRuleKey(found.rule.id) === rule ? customHit(found) : null;
    }
    if (rule === 'disrespect' || rule === 'harassment') {
        return findInsult(text) && (await targetsOf(message)).length ? stored : null;
    }
    if (rule === 'sexual') return findSexualWord(text) ? stored : null;
    if (rule === 'language') return findSexualWord(text) || findBlockedWord(text) ? stored : null;
    return null;
}

async function dropHeadsUp(client, guildId, messageId, why) {
    logger.warn(`Automod heads-up ${messageId} dropped: ${why}`);
    const record = await takeHeadsUp(guildId, messageId);
    if (record) await finishHeadsUp(client, record, 'dropped', why);
}

async function checkDueHeadsUp(client, { guildId, messageId }) {
    const record = await peekHeadsUp(guildId, messageId);
    if (!record) return dropHeadsUp(client, guildId, messageId, 'the waiting record expired');
    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) return dropHeadsUp(client, guildId, messageId, 'the bot is not in that server');
    const channel = guild.channels.cache.get(record.channelId) || await guild.channels.fetch(record.channelId).catch(() => null);
    if (!channel?.messages?.fetch) return dropHeadsUp(client, guildId, messageId, 'the channel is gone or not readable');

    let message;
    try {
        message = await channel.messages.fetch(messageId);
    } catch (error) {
        if (error?.code !== 10008) return dropHeadsUp(client, guildId, messageId, `could not read the message (${error.message})`);
        message = null;
    }
    if (!message) {
        const taken = await takeHeadsUp(guildId, messageId);
        if (taken) await finishHeadsUp(client, taken, 'deleted');
        return undefined;
    }

    const hit = await recheckHeadsUp(message, record);
    if (!hit) {
        const taken = await takeHeadsUp(guildId, messageId);
        if (taken) await finishHeadsUp(client, taken, 'edited');
        return undefined;
    }
    const member = await guild.members.fetch(record.userId).catch(() => null);
    if (member && isAdministrator(member)) return dropHeadsUp(client, guildId, messageId, 'the member is an administrator now');
    const settings = await deps.getAutomodSettings(guildId);
    const [moded] = settings.enabled ? applyRuleModes([hit], settings, channel) : [];
    // Claim it before acting, so an edit or delete at the same moment cannot resolve it too.
    const taken = await takeHeadsUp(guildId, messageId);
    if (!taken) return undefined;
    if (!moded) return finishHeadsUp(client, taken, 'dropped', 'automod or the rule is off now');
    const probation = await deps.getProbation(guildId, record.userId).catch(() => null);
    handledMessages.add(messageId);
    await actOn(message, member, moded, settings, probation, { skipHeadsUp: true });
    return finishHeadsUp(client, taken, 'acted');
}

/**
 * Per-minute check (app.js cron): every heads-up whose two minutes are over. Message gone
 * → fixed; edited clean → fixed; still breaking the rule → the usual action (actOn without
 * the heads-up); channel gone or unreadable → dropped with a warning in the log.
 */
export async function runHeadsUpChecks(client, now = Date.now()) {
    const due = await dueHeadsUps(now);
    for (const item of due) {
        try {
            await checkDueHeadsUp(client, item);
        } catch (error) {
            logger.warn(`Automod heads-up check for message ${item.messageId} failed: ${error.message}`);
        }
    }
    return due.length;
}

/** Test hook: how many entries each live map holds (the test run must not change them). */
export function automodStateSizes() {
    return {
        history: history.size, cooldowns: cooldowns.size, harassment: harassment.size, lastPost: lastPost.size,
        inviteGuilds: inviteGuilds.size, handledMessages: handledMessages.size, levelCache: levelCache.size,
    };
}

/** Test hook: forget all in-memory state. */
export function resetAutomodState() {
    for (const map of [history, cooldowns, harassment, lastPost, inviteGuilds, levelCache]) map.clear();
    handledMessages.clear();
    resetCustomRulesCache();
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
