// automodLog.js — the Automod log (owner, 2026-11-13: "it should show everything the automod did;
// the moderation will only be when a staff himself does it").
//
// A plain information record (no buttons) for everything automod did: a deleted message and its
// rule, an automatic warn / mute / ban / kick (with the case code), a heads-up given and how it
// ended, a friendly notice, an immune member's message kept, watch-mode flags, Discord AutoMod
// blocks, report-reaction removals, join gate kicks and flags, raid lockdowns, staff guard actions,
// auto slowmode and extra-watch periods. The review cards with their buttons stay in the review
// channel, unchanged; the case lines of automatic punishments go here too (postModLog `automated`).
//
// Posted with loggingService.logEvent (category 'automod' → the Logging page's Automod channel or
// its Advanced forum), so the ignore lists, event toggles, the 403 backoff and forum mode apply.
// Not set: nothing is posted (no fallback to the main log). Every record names the member it is
// about (their forum post in Advanced mode); records about no member (a lockdown) go to "Server logs".
// Home servers (main + support) post in the main server's log, like the mod log and review cards.
//
// Bursts: review-card hits of the same member, rule and kind within automodConfig.burstWindowMs
// are one record (like the card), except a hit that took a new action (a new case), which always
// gets its own. Records are English, like the mod log lines. Never throws, never delays automod.

import { automodConfig } from '../../config/automod.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { truncate } from '../enforcement/format.js';
import { logEvent } from '../loggingService.js';
import { staffGuildId } from './channelRouting.js';
import { ruleDefinition } from './customRules.js';
import { describeStep, outcomeLabel, spoilerExcerpt, stepVerb, stripLeadingEmoji } from './reviewFormat.js';

export const AUTOMOD_LOG_TYPES = Object.freeze([
    'action', 'flag', 'headsup', 'notice', 'native', 'report', 'joingate', 'raid', 'staffguard', 'slowmode', 'probation',
]);

const EXCERPT_CHARS = 300;
const SNOWFLAKE = /^\d{17,20}$/;

let sink = (args) => logEvent(args);

/** Test hook: replace where records go (no argument restores logEvent). */
export function setAutomodLogSinkForTest(fn = null) {
    sink = fn || ((args) => logEvent(args));
}

/** "<@id> name (`id`)" for a member line. */
export function memberLine(user) {
    if (!user?.id) return 'unknown';
    return `<@${user.id}> ${user.username || ''} (\`${user.id}\`)`.replace(/\s+\(/, ' (');
}

/**
 * Posts one Automod log record. record: { type (AUTOMOD_LOG_TYPES), title, fields: [{ name, value }],
 * subject: { id, username } | null, channelId?, excerpt? (shown as "Message text") }. `guildId`: the
 * server automod acted in. Resolves the posted message or null; never throws.
 */
export async function logAutomod(client, guildId, { type, title, fields = [], subject = null, channelId = null, excerpt = null } = {}) {
    try {
        if (!client || !guildId || !AUTOMOD_LOG_TYPES.includes(type)) return null;
        const subjectId = subject?.id && SNOWFLAKE.test(String(subject.id)) ? String(subject.id) : null;
        const data = {
            title: truncate(title || 'Automod', 256),
            fields: fields.filter((field) => field?.value).map((field) => ({ name: field.name, value: truncate(field.value, 1024) })),
            ...(subjectId ? { userId: subjectId, username: subject.username || null } : {}),
            ...(channelId ? { channelId } : {}),
            ...(excerpt ? { section: { title: 'Message text', body: excerpt } } : {}),
        };
        return await sink({ client, guildId: staffGuildId(guildId), eventType: `automod.${type}`, data });
    } catch (error) {
        logger.warn(`Automod log record (${type}) failed: ${error.message}`);
        return null;
    }
}

/** The rule's name as staff see it ("Spam", "Discord AutoMod: Bad words"). */
function ruleNameOf(p) {
    return stripLeadingEmoji(String(p.ruleLabel || ruleDefinition(p.rule, null, p.guild?.id)?.label || p.rule || 'a rule'));
}

/** What automod did with an automatic step: "Warned (case `k3f9a`)", "Mute 1 hour failed: …". */
function stepOutcome(step, result) {
    if (result?.error) return `${describeStep(step)} failed: ${result.error.userMessage || result.error.message || 'unknown error'}`;
    const code = result?.record?.case_code;
    const parts = [`${outcomeLabel(step)}${code ? ` (case \`${code}\`)` : ''}`];
    const ban = result?.banRecord;
    if (result?.record && ban?.case_code && ban.case_code !== code) parts.push(`warning limit reached: banned (case \`${ban.case_code}\`)`);
    return parts.join('; ');
}

/**
 * A review card hit (postReviewCard's parameters) → its record, or null for member reports
 * (a person's report is not automod; report reactions log themselves). Pure.
 */
export function automodHitRecord(p) {
    if (!p || p.report || !p.targetUser?.id) return null;
    const rule = ruleNameOf(p);
    const native = String(p.rule || '').startsWith('native:');
    const definition = ruleDefinition(p.rule, null, p.guild?.id);
    const deleted = Boolean(p.deleted ?? definition?.deleteMessage);
    let type = p.logKind || (native ? 'native' : p.monitor ? 'flag' : 'action');
    if (!AUTOMOD_LOG_TYPES.includes(type)) type = 'action';

    let done;
    if (p.note?.title) done = stripLeadingEmoji(p.note.title);
    else if (p.monitor) done = `Watch mode, nothing done${p.suggested ? ` (the rule would ${stepVerb(p.suggested)})` : ''}`;
    else if (p.step) done = `${p.raid ? 'Raid joiner: ' : ''}${stepOutcome(p.step, p.result)}`;
    else done = deleted ? 'Message deleted' : 'Flagged for staff';

    const fields = [
        { name: 'Member', value: memberLine(p.targetUser) },
        { name: 'Rule', value: rule },
        p.channelId ? { name: 'Channel', value: `<#${p.channelId}>` } : null,
        p.evidence ? { name: 'Why', value: String(p.evidence) } : null,
        { name: 'Done', value: done },
        p.channelId || p.content ? { name: 'Message', value: deleted ? 'Deleted' : p.messageUrl ? `Kept · [jump to message](${p.messageUrl})` : 'Kept' } : null,
        p.offence ? { name: 'Offence', value: `#${p.offence} for this rule` } : null,
        p.probation?.until ? { name: 'Extra watch', value: `until <t:${Math.floor(Number(p.probation.until) / 1000)}:D>` } : null,
    ].filter(Boolean);
    // Personal info is never copied into another channel.
    const excerpt = p.rule === 'privacy' || !String(p.content ?? '').trim() ? null : spoilerExcerpt(p.content, EXCERPT_CHARS);
    return {
        type,
        title: `${native ? '' : 'Automod: '}${rule}`,
        fields,
        subject: { id: p.targetUser.id, username: p.targetUser.username || null },
        channelId: p.channelId || null,
        excerpt,
    };
}

// burst key → time of the last hit (sliding, like the review card's window).
const recentHits = new BoundedMap(5000);

/** True when this hit gets its own record (a new burst, no grouping, or a new action). Updates the window. */
export function shouldLogHit(key, p, now = Date.now()) {
    if (!key) return true;
    const last = recentHits.get(key);
    recentHits.set(key, now);
    return !last || now - last > automodConfig.burstWindowMs || Boolean(p?.step);
}

/**
 * One review card hit (reviewCards.postReviewCard): its record, unless it is a repeat inside a
 * burst. `key`: the card's burst key (null: never grouped). Resolves the message or null.
 */
export function logAutomodHit(p, { key = null, now = Date.now() } = {}) {
    try {
        const record = automodHitRecord(p);
        if (!record || !p.guild?.id || !shouldLogHit(key, p, now)) return Promise.resolve(null);
        return logAutomod(p.guild.client, p.guild.id, record);
    } catch (error) {
        logger.warn(`Automod log record failed: ${error.message}`);
        return Promise.resolve(null);
    }
}

/** Test hook. */
export function resetAutomodLogState() {
    recentHits.clear();
}
