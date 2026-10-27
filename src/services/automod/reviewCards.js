// reviewCards.js — the staff review card posted for every automod decision and
// member report, and what its buttons do. Administrators in the main server only.
// How a card looks is in reviewFormat.js; the in-memory card list in reviewRegistry.js.
//
//   amreview:keep:<code>[,<code>…]       keep the automatic action(s)
//   amreview:undo:<code>[,<code>…]       reverse them (unban/unmute/remove warn, DM the user)
//   amreview:change:<code>[,<code>…]     (select) reverse them and apply another punishment
//   amreview:apply:<rule>:<userId>       (select) apply a punishment (monitor mode, reports, failed actions)
//   amreview:delete:<channelId>:<msgId>  delete a reported message
//   amreview:dismiss                     close the card without acting
//   amreview:tune:<rule>                 (alerts) switch a rule to monitor (automodTuning.js)
//
// Cards go to the review channel (AUTOMOD_REVIEW_CHANNEL_ID, falls back to the mod log).
// Low-severity hits are one compact line with an Undo button. Repeated hits of the same
// rule by the same member within automodConfig.burstWindowMs update the open card
// ("3 messages", latest excerpt, every case on the buttons) instead of posting another.
// Grouping lives in memory: after a restart the next hit starts a new card.

import { AUTOMOD_RULES, REVIEW_ACTIONS } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { Mutex } from '../../utils/mutex.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { truncate } from '../enforcement/format.js';
import { getCaseByCode } from '../enforcement/caseService.js';
import { createRejoinInvite, executeAction, sendDm } from '../enforcement/enforcementService.js';
import { liftCase } from '../enforcement/appealService.js';
import { fetchStaffChannel } from './channelRouting.js';
import {
    CLOSE_STATUS, REPORT_RULE, buildCardPayload, cardTier, closedTitle, describeStep, stripLeadingEmoji,
} from './reviewFormat.js';
import { burstKey, findOpenBurst, markClosed, recordHit, registerCard } from './reviewRegistry.js';
import { switchRuleToMonitor } from './automodTuning.js';

export { describeStep };

// Burst updates are coalesced: at most one edit per card in this interval.
const RENDER_DELAY_MS = 1500;

function userError(message) {
    return createError(message, ErrorTypes.VALIDATION, message, { expected: true });
}

/** The staff channel for review cards: AUTOMOD_REVIEW_CHANNEL_ID, else the mod log channel. */
export async function reviewChannel(client) {
    return fetchStaffChannel(client, 'review');
}

/** One automatic action as the card keeps it. */
function actionFrom(p) {
    const record = p.result?.record || p.result?.banRecord || null;
    return {
        step: p.step,
        caseCode: record?.case_code || null,
        failed: p.result?.error ? (p.result.error.userMessage || p.result.error.message || 'unknown error') : null,
        limitBanCode: p.result?.record && p.result?.banRecord ? p.result.banRecord.case_code : null,
    };
}

/** Card parameters (see postReviewCard) → the card's state. */
export function entryFrom(p, now = Date.now()) {
    const kind = p.report ? 'report' : p.monitor ? 'monitor' : 'action';
    const rule = AUTOMOD_RULES[p.rule];
    const deleted = p.deleted ?? (kind === 'report' ? Boolean(p.report.removed) : kind === 'action' && Boolean(rule?.deleteMessage));
    const entry = {
        rule: p.rule,
        kind,
        guildId: p.guild?.id || null,
        userId: p.targetUser.id,
        username: p.targetUser.username,
        channelId: p.channelId || null,
        evidence: p.evidence,
        offence: p.offence || null,
        raid: Boolean(p.raid),
        count: 1,
        firstAt: now,
        lastAt: now,
        latest: { content: p.content, messageUrl: p.messageUrl || null, deleted },
        actions: kind === 'action' && p.step ? [actionFrom(p)] : [],
        suggested: p.suggested || null,
        report: p.report || null,
        open: true,
        noGroup: Boolean(p.raid || p.noGroup),
        tier: p.tier || null,
    };
    entry.key = burstKey(entry);
    entry.tier = cardTier(entry);
    return entry;
}

/** Folds another hit of the same burst into an open card. `p` may have no step (cooldown). */
export function mergeHit(entry, p, now = Date.now()) {
    const next = entryFrom(p, now);
    entry.count += 1;
    entry.lastAt = now;
    entry.latest = next.latest;
    entry.evidence = next.evidence || entry.evidence;
    entry.channelId = next.channelId || entry.channelId;
    if (next.offence) entry.offence = next.offence;
    if (next.suggested) entry.suggested = next.suggested;
    if (next.actions.length) entry.actions.push(...next.actions);
    // Once a card is full it stays full; a compact line becomes a card when a serious action joins.
    const tier = cardTier({ ...entry, tier: null });
    entry.tier = entry.tier === 'full' ? 'full' : tier;
    return entry;
}

function scheduleRender(entry) {
    if (entry.renderTimer || !entry.message) return;
    entry.renderTimer = setTimeout(async () => {
        entry.renderTimer = null;
        if (!entry.open) return;
        await entry.message.edit({ ...buildCardPayload(entry), allowedMentions: { parse: [] } })
            .catch((error) => logger.warn(`Could not update review card ${entry.messageId}: ${error.message}`));
    }, RENDER_DELAY_MS);
    entry.renderTimer.unref?.();
}

function logHit(p) {
    if (p.detail) logger.info(`Automod ${p.rule} on ${p.targetUser.id}: ${p.detail}`);
}

/**
 * Posts a card, or updates the open card of the same burst. p: { guild, rule, evidence,
 * targetUser, channelId, messageUrl, content, step?, result?, offence?, monitor?, suggested?,
 * raid?, report?: { reporter, messageId, removed }, deleted?, detail?, tier?, noGroup? }.
 * `evidence` is a plain-English phrase (reasons.js); `detail` goes to the log only.
 * Returns the card message, or null.
 */
export async function postReviewCard(p) {
    logHit(p);
    if (!p.report) recordHit({ rule: p.rule, channelId: p.channelId, monitor: Boolean(p.monitor) });
    const key = entryFrom(p).key;
    const run = async () => {
        const now = Date.now();
        const open = findOpenBurst(key, now);
        if (open) {
            mergeHit(open, p, now);
            scheduleRender(open);
            return open.message;
        }
        const channel = await reviewChannel(p.guild.client);
        if (!channel) {
            logger.warn(`Automod review card not posted (no review channel): ${p.rule} on ${p.targetUser.id}`);
            return null;
        }
        const entry = entryFrom(p, now);
        const message = await channel.send({ ...buildCardPayload(entry), allowedMentions: { parse: [] } }).catch((error) => {
            logger.warn(`Automod review card failed: ${error.message}`);
            return null;
        });
        if (!message) return null;
        registerCard(Object.assign(entry, { messageId: message.id, cardChannelId: channel.id, url: message.url, message }));
        return message;
    };
    return key ? Mutex.runExclusive(`amcard:${key}`, run) : run();
}

/**
 * A hit automod did not act on (the same rule again within the cooldown): counted on
 * the open card of the burst, if there is one. Never posts a new card.
 */
export async function noteRepeatHit(p) {
    logHit(p);
    recordHit({ rule: p.rule, channelId: p.channelId, monitor: false });
    const key = entryFrom(p).key;
    if (!key) return;
    await Mutex.runExclusive(`amcard:${key}`, async () => {
        const open = findOpenBurst(key);
        if (!open) return;
        mergeHit(open, p);
        scheduleRender(open);
    });
}

/**
 * Closes a card: shows who reviewed it and how (title, color), adds the details as a
 * "Review" field and removes the controls. opts: { status, by, verb } — status is a
 * key of CLOSE_STATUS (kept, undone, changed, applied, dismissed, deleted, approved,
 * denied, failed). Without a status only the field is added.
 */
export async function closeCard(message, outcome, { status = null, by = null, verb = null } = {}) {
    markClosed(message.id, status || 'closed');
    if (!message.embeds?.length) {
        // A compact line: strike it through and say who handled it.
        const [emoji, defaultVerb] = CLOSE_STATUS[status] || ['✔️', 'Reviewed'];
        const line = stripLeadingEmoji(message.content || '');
        const content = truncate(`${emoji} ${verb || defaultVerb}${by ? ` by ${by}` : ''} — ~~${line}~~\n-# ${outcome}`, 2000);
        await message.edit({ content, components: [], allowedMentions: { parse: [] } }).catch((error) =>
            logger.warn(`Could not update review line ${message.id}: ${error.message}`));
        return;
    }
    const [embed] = message.embeds;
    const data = embed?.toJSON?.() || {};
    const fields = [...(data.fields || []), { name: 'Review', value: truncate(outcome, 1024) }];
    const update = { ...data, fields };
    if (status && CLOSE_STATUS[status]) {
        update.title = closedTitle(data.title, status, by || 'a moderator', verb);
        update.color = CLOSE_STATUS[status][2];
    }
    await message.edit({ embeds: [update], components: [] }).catch((error) =>
        logger.warn(`Could not update review card ${message.id}: ${error.message}`));
}

function flowFor(step, { reason, reasonKey, targetUser }) {
    return {
        type: step.type,
        reason,
        reasonSource: 'custom',
        reasonKey,
        durationMs: step.durationMs ?? null,
        unappealable: false,
        name: `${targetUser.username} ${step.type}`,
        nameIsDefault: true,
    };
}

async function reverse(client, record, admin, verb) {
    if (record.status === 'revoked') return { notes: [`\`${record.case_code}\` was already lifted.`] };
    if (record.type === 'kick') {
        const guild = client.guilds.cache.get(record.guild_id);
        const invite = guild ? await createRejoinInvite(guild, `Automod kick ${record.case_code} ${verb}`) : null;
        return { notes: ['A kick cannot be undone; the user was sent an invite back.'], invite };
    }
    const notes = await liftCase(client, record, admin, {
        reason: `Automod decision ${verb} by ${admin.username}`,
        via: 'automod review',
    });
    const guild = client.guilds.cache.get(record.guild_id);
    const invite = record.type === 'ban' && guild ? await createRejoinInvite(guild, `Automod ban ${record.case_code} ${verb}`) : null;
    return { notes, invite };
}

async function dmReversal(client, record, invite, replacement = null) {
    const user = await client.users.fetch(record.target_user_id).catch(() => null);
    if (!user) return false;
    const lines = [
        `**A moderator reviewed an automatic action against you in ${enforcementConfig.serverName}** (case ${record.case_code}).`,
        replacement ? `It was changed to: ${replacement}.` : 'It was reversed.',
        invite ? `Rejoin: ${invite}` : null,
    ].filter(Boolean);
    return sendDm(user, lines.join('\n'));
}

/** "a,b,c" → the existing case records, in order. Throws when none exist. */
async function recordsFor(codesArg) {
    const codes = String(codesArg || '').split(',').map((code) => code.trim()).filter(Boolean);
    const records = [];
    for (const code of codes) {
        const record = await getCaseByCode(code);
        if (record) records.push(record);
    }
    if (!records.length) throw userError(`Case \`${codes.join(', ') || '?'}\` no longer exists.`);
    return records;
}

const codeList = (records) => records.map((record) => `\`${record.case_code}\``).join(', ');

/**
 * Handles a review card component. Returns the confirmation text for the moderator.
 * `interaction.member` must be an administrator in the main server (checked by the caller).
 */
export async function handleReviewAction(interaction, args) {
    const [action, ...rest] = args;
    const { client, guild } = interaction;
    const admin = interaction.user;
    const by = admin.username;
    const message = interaction.message;

    if (action === 'dismiss') {
        await closeCard(message, `Dismissed by ${by}`, { status: 'dismissed', by });
        return 'Dismissed.';
    }

    if (action === 'tune') {
        // Self-tuning suggestion (automodTuning.js); the caller re-checked admin rights on click.
        const [rule] = rest;
        const result = await switchRuleToMonitor(guild.id, rule);
        await closeCard(message, result.changed ? `${result.text} Switched by ${by}; undo with \`/automod rule\`.` : result.text,
            result.changed ? { status: 'applied', by, verb: 'Switched to monitor' } : { status: 'dismissed', by, verb: 'Closed' });
        return result.text;
    }

    if (action === 'delete') {
        const [channelId, messageId] = rest;
        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        const target = channel?.isTextBased?.() ? await channel.messages.fetch(messageId).catch(() => null) : null;
        if (target) await target.delete().catch(() => {});
        await closeCard(message, target ? `Message deleted by ${by}` : `The message was already gone (${by})`, { status: 'deleted', by });
        return target ? 'Message deleted.' : 'The message was already gone.';
    }

    if (action === 'keep' || action === 'undo' || action === 'change') {
        const records = await recordsFor(rest[0]);

        if (action === 'keep') {
            await closeCard(message, `Kept by ${by}: ${codeList(records)}`, { status: 'kept', by });
            return `Kept ${codeList(records)}.`;
        }

        if (action === 'undo') {
            const notes = [];
            let delivered = 0;
            for (const record of records) {
                const result = await reverse(client, record, admin, 'reversed');
                notes.push(...result.notes);
                if (await dmReversal(client, record, result.invite)) delivered += 1;
            }
            const dm = records.length === 1 ? (delivered ? 'delivered' : 'not delivered') : `${delivered} of ${records.length} delivered`;
            await closeCard(message, `Reversed ${codeList(records)} by ${by}. ${notes.join(' ')} DM: ${dm}.`, { status: 'undone', by });
            return `Reversed ${codeList(records)}. ${notes.join(' ')}`;
        }

        const choice = REVIEW_ACTIONS[interaction.values?.[0]];
        if (!choice) throw userError('Pick a punishment from the list.');
        const latest = records[records.length - 1];
        const targetUser = await client.users.fetch(latest.target_user_id);
        const notes = [];
        for (const record of records) notes.push(...(await reverse(client, record, admin, 'changed')).notes);
        let result;
        try {
            result = await executeAction({
                guild,
                moderator: interaction.member,
                targetUser,
                flow: flowFor(choice.step, {
                    reason: `${latest.reason} (changed by ${by})`,
                    reasonKey: latest.reason_key,
                    targetUser,
                }),
            });
        } catch (error) {
            await closeCard(message, `Reversed by ${by}, but "${choice.label}" failed: ${error.userMessage || error.message}`,
                { status: 'failed', by, verb: `Reversed, "${choice.label}" failed,` });
            throw error;
        }
        await dmReversal(client, latest, null, choice.label);
        const code = result.record?.case_code;
        await closeCard(message, `Changed to ${choice.label}${code ? ` (case \`${code}\`)` : ''} by ${by}. ${notes.join(' ')}`,
            { status: 'changed', by, verb: `Changed to ${choice.label}` });
        return `Changed to ${choice.label}${code ? ` — case \`${code}\`` : ''}.`;
    }

    if (action === 'apply') {
        const [rule, userId] = rest;
        const choice = REVIEW_ACTIONS[interaction.values?.[0]];
        if (!choice) throw userError('Pick a punishment from the list.');
        const targetUser = await client.users.fetch(userId).catch(() => null);
        if (!targetUser) throw userError('That user no longer exists.');
        const label = AUTOMOD_RULES[rule]?.label;
        const result = await executeAction({
            guild,
            moderator: interaction.member,
            targetUser,
            flow: flowFor(choice.step, {
                reason: label ? `Automod: ${label} (applied by ${by})` : `Reported message (decided by ${by})`,
                reasonKey: `automod:${AUTOMOD_RULES[rule]?.group || REPORT_RULE}`,
                targetUser,
            }),
        });
        const code = result.record?.case_code;
        await closeCard(message, `${choice.label}${code ? ` (case \`${code}\`)` : ''} applied by ${by}`,
            { status: 'applied', by, verb: `${choice.label} applied` });
        return `${choice.label} applied${code ? ` — case \`${code}\`` : ''}.`;
    }

    throw userError('Unknown review action.');
}
