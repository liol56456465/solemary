// reviewCards.js — the staff review card posted for every automod decision and
// member report, and what its buttons do. Administrators in the main server only.
// How a card looks is in reviewFormat.js; the in-memory card list in reviewRegistry.js.
//
//   amreview:keep:<code>[,<code>…]       keep the automatic action(s)
//   amreview:undo:<code>[,<code>…]       reverse them (unban/unmute/remove warn, DM the user)
//   amreview:change:<code>[,<code>…]     (select) reverse them and apply another punishment
//   amreview:apply:<rule>:<userId>[:<guildId>] (select) apply a punishment (monitor mode, reports, failed actions)
//   amreview:delete:<channelId>:<msgId>  delete a reported message
//   amreview:dismiss                     close the card without acting
//   amreview:tune:<rule>                 (alerts) switch a rule to monitor (automodTuning.js)
//   amreview:2nd:<confirm|undo>:<keeperId>:<codes>  second opinion on a kept card (secondOpinion.js)
//
// Cards go to the review channel (AUTOMOD_REVIEW_CHANNEL_ID, falls back to the mod log).
// Low-severity hits are one compact line with an Undo button. Repeated hits of the same
// rule by the same member within automodConfig.burstWindowMs update the open card
// ("3 messages", latest excerpt, every case on the buttons) instead of posting another.
// Grouping lives in memory: after a restart the next hit starts a new card.

import { REVIEW_ACTIONS } from '../../config/automod.js';
import { logger } from '../../utils/logger.js';
import { Mutex } from '../../utils/mutex.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { truncate } from '../enforcement/format.js';
import { getCaseByCode, isSameCaseServer } from '../enforcement/caseService.js';
import { createRejoinInvite, executeAction, isAdministrator, sendDm } from '../enforcement/enforcementService.js';
import { liftCase, liftNoteText } from '../enforcement/appealService.js';
import { dmServerName } from '../enforcement/dmTemplates.js';
import { botText, textForGuild, textForInteraction } from '../../utils/botText.js';
import { fetchStaffChannel } from './channelRouting.js';
import {
    CLOSE_STATUS, REPORT_RULE, buildCardPayload, cardTier, closedTitle, describeStep, reviewActionLabel, statusVerb, stripLeadingEmoji,
} from './reviewFormat.js';
import { burstKey, findOpenBurst, getCard, markClosed, recordHit, registerCard } from './reviewRegistry.js';
import { switchRuleToMonitor } from './automodTuning.js';
import { ruleDefinition } from './customRules.js';
import { restoreIfContested } from './automodContest.js';
import { canGiveSecondOpinion, secondOpinionPayload, shouldAskSecondOpinion } from './secondOpinion.js';
import { alertWatched } from '../enforcement/watchlistService.js';

export { describeStep };

// Burst updates are coalesced: at most one edit per card in this interval.
const RENDER_DELAY_MS = 1500;

function userError(message) {
    return createError(message, ErrorTypes.VALIDATION, message, { expected: true });
}

/**
 * The staff channel for review cards of a server: AUTOMOD_REVIEW_CHANNEL_ID, else the mod log
 * channel (home servers: the main server's; others: their own, null when not set).
 */
export async function reviewChannel(client, guildId) {
    return fetchStaffChannel(client, guildId, 'review');
}

/** One automatic action as the card keeps it. */
function actionFrom(p) {
    const record = p.result?.record || p.result?.banRecord || null;
    return {
        step: p.step,
        caseCode: record?.case_code || null,
        failed: p.result?.error ? (p.result.error.userMessage || p.result.error.message || 'unknown error') : null,
        limitBanCode: p.result?.record && p.result?.banRecord ? p.result.banRecord.case_code : null,
        // Kept so a contested case that staff undo can have its message restored (automodContest.js).
        content: p.content ?? null,
        channelId: p.channelId || null,
        deleted: Boolean(p.deleted ?? ruleDefinition(p.rule, null, p.guild?.id)?.deleteMessage),
    };
}

/** Card parameters (see postReviewCard) → the card's state. */
export function entryFrom(p, now = Date.now()) {
    const kind = p.report ? 'report' : p.note ? 'note' : p.monitor ? 'monitor' : 'action';
    const rule = ruleDefinition(p.rule, null, p.guild?.id);
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
        note: p.note || null,
        probationUntil: p.probation?.until ? Number(p.probation.until) : null,
        ruleLabel: p.ruleLabel || null,
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
    if (next.probationUntil) entry.probationUntil = next.probationUntil;
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
    // The detail quotes the member's message (words, personal data); keep it out of the logs.
    logger.info(`Automod ${p.rule} on ${p.targetUser.id}`);
}

/** Staff watchlist: a watched member tripped automod → one mod log line (memory lookup; never throws). */
function alertWatchlistHit(p) {
    if (p.report || !p.guild?.id || !p.targetUser?.id) return;
    const rule = stripLeadingEmoji(String(p.ruleLabel || p.rule || 'a rule'));
    const where = p.messageUrl ? ` · [jump to message](${p.messageUrl})` : (p.channelId ? ` in <#${p.channelId}>` : '');
    void alertWatched(p.guild.client, {
        guildId: p.guild.id,
        userId: p.targetUser.id,
        username: p.targetUser.username,
        kind: 'automod',
        event: `triggered automod (${truncate(rule, 80)})${where}`,
    });
}

/**
 * Posts a card, or updates the open card of the same burst. p: { guild, rule, evidence,
 * targetUser, channelId, messageUrl, content, step?, result?, offence?, monitor?, suggested?,
 * raid?, report?: { reporter, messageId, removed }, deleted?, detail?, tier?, noGroup?,
 * note?: { emoji, title } (an information-only compact line), ruleLabel?,
 * probation?: { until } (the member's running probation: shown on the card) }.
 * `evidence` is a plain-English phrase (reasons.js); `detail` goes to the log only.
 * Returns the card message, or null.
 */
export async function postReviewCard(p) {
    logHit(p);
    if (!p.report) recordHit({ rule: p.rule, channelId: p.channelId, monitor: Boolean(p.monitor), guildId: p.guild?.id || null });
    alertWatchlistHit(p);
    const key = entryFrom(p).key;
    const run = async () => {
        const now = Date.now();
        const open = findOpenBurst(key, now);
        if (open) {
            mergeHit(open, p, now);
            scheduleRender(open);
            return open.message;
        }
        const channel = await reviewChannel(p.guild.client, p.guild.id);
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
    recordHit({ rule: p.rule, channelId: p.channelId, monitor: false, guildId: p.guild?.id || null });
    alertWatchlistHit(p);
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
export async function closeCard(message, outcome, { status = null, by = null, verb = null, lang = null } = {}) {
    markClosed(message.id, status || 'closed');
    // The card is a staff-channel post: the server's language (docs/bot-i18n.md).
    const code = lang || textForGuild(message.guildId || message.guild?.id || null, { purpose: 'public' }).lang;
    const tr = botText(code);
    if (!message.embeds?.length) {
        // A compact line: strike it through and say who handled it.
        const shownVerb = verb || statusVerb(CLOSE_STATUS[status] ? status : null, { lang: code });
        const head = by ? tr.t('automod.review.close.by', { verb: shownVerb, name: by }) : shownVerb;
        const line = stripLeadingEmoji(message.content || '');
        const content = truncate(`${head} · ~~${line}~~\n-# ${outcome}`, 2000);
        await message.edit({ content, components: [], allowedMentions: { parse: [] } }).catch((error) =>
            logger.warn(`Could not update review line ${message.id}: ${error.message}`));
        return;
    }
    const [embed] = message.embeds;
    const data = embed?.toJSON?.() || {};
    const fields = [...(data.fields || []), { name: tr.t('automod.review.close.field'), value: truncate(outcome, 1024) }];
    const update = { ...data, fields };
    if (status && CLOSE_STATUS[status]) {
        update.title = closedTitle(data.title, status, by || tr.t('automod.review.close.aModerator'), verb, { lang: code });
        update.color = CLOSE_STATUS[status][1];
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

// Notes about a reversal are shown on the card (server language) and in the moderator's private
// reply (their language): each note is a string (liftCase, contest restore: English as written) or
// a function of a translator.
const noteText = (notes, tr) => notes.map((note) => (typeof note === 'function' ? note(tr) : note)).join(' ');

async function reverse(client, record, admin, verb) {
    if (record.status === 'revoked') return { notes: [(tr) => tr.t('automod.review.note.alreadyLifted', { code: record.case_code })] };
    if (record.type === 'kick') {
        const guild = client.guilds.cache.get(record.guild_id);
        const invite = guild ? await createRejoinInvite(guild, `Automod kick ${record.case_code} ${verb}`) : null;
        return { notes: [(tr) => tr.t('automod.review.note.kickInvite')], invite };
    }
    // Stored reasons and invite audit reasons stay English (case data, Discord audit log).
    const entries = await liftCase(client, record, admin, {
        reason: `Automod decision ${verb} by ${admin.username}`,
        via: 'automod review',
        entries: true,
    });
    // Each note is shown in the card's and the clicker's language (noteText).
    const notes = entries.map((entry) => (tr) => liftNoteText(entry, tr.lang));
    const guild = client.guilds.cache.get(record.guild_id);
    const invite = record.type === 'ban' && guild ? await createRejoinInvite(guild, `Automod ban ${record.case_code} ${verb}`) : null;
    return { notes, invite };
}

/** DM to the member: the language of the server that acted. `replacementKey`: a REVIEW_ACTIONS key. */
async function dmReversal(client, record, invite, replacementKey = null) {
    const user = await client.users.fetch(record.target_user_id).catch(() => null);
    if (!user) return false;
    const tr = textForGuild(record.guild_id, { userId: record.target_user_id, purpose: 'dm' });
    const lines = [
        tr.t('automod.review.dm.reviewed', {
            server: dmServerName(record.guild_id, client.guilds?.cache?.get?.(record.guild_id)?.name),
            code: record.case_code,
        }),
        replacementKey ? tr.t('automod.review.dm.changed', { action: reviewActionLabel(replacementKey, { lang: tr.lang }) }) : tr.t('automod.review.dm.reversed'),
        invite ? tr.t('enforcement.dm.rejoin', { invite }) : null,
    ].filter(Boolean);
    return sendDm(user, lines.join('\n'));
}

/** "a,b,c" → the existing case records, in order. Throws when none exist. */
/**
 * The cases a card names. Only cases of the card's server (`guildId`; main + support count as
 * one, getCaseByCode): a code of another server counts as gone, so a card can never reach
 * another server's case. `lookup`: test hook. `lang`: the language of the error (the clicker's).
 */
export async function recordsFor(codesArg, guildId, lookup = getCaseByCode, { lang = 'en' } = {}) {
    const codes = String(codesArg || '').split(',').map((code) => code.trim()).filter(Boolean);
    const records = [];
    for (const code of codes) {
        const record = guildId ? await lookup(code, guildId) : null;
        if (record) records.push(record);
    }
    if (!records.length) throw userError(botText(lang).t('automod.review.error.caseGone', { codes: codes.join(', ') || '?' }));
    return records;
}

/** Reverses automod cases and DMs the members: { notes, dm } (dm: in the card's language). */
async function undoRecords(client, records, admin, cardTr) {
    const notes = [];
    let delivered = 0;
    for (const record of records) {
        const result = await reverse(client, record, admin, 'reversed');
        notes.push(...result.notes);
        const restored = await restoreIfContested(client, record);
        if (restored) notes.push(restored);
        if (await dmReversal(client, record, result.invite)) delivered += 1;
    }
    const dm = records.length === 1
        ? (delivered ? cardTr.t('automod.review.dmStatus.delivered') : cardTr.t('automod.review.dmStatus.notDelivered'))
        : cardTr.t('automod.review.dmStatus.some', { delivered, total: records.length });
    return { notes, dm };
}

/**
 * For about secondOpinionRate of kept full cards: a reply in the review channel
 * asking a different admin to confirm or undo. Mentions nobody (the keeper is shown
 * but not pinged); the buttons refuse the admin who kept it.
 */
async function maybeAskSecondOpinion(message, keeper, records, lang) {
    if (!message.embeds?.length || !shouldAskSecondOpinion()) return null;
    const codes = records.map((record) => record.case_code);
    const payload = secondOpinionPayload(keeper.id, codes, message.url, { lang });
    return message.reply({ ...payload, allowedMentions: { parse: [], repliedUser: false } }).catch((error) => {
        logger.warn(`Second-opinion request failed: ${error.message}`);
        return null;
    });
}

const codeList = (records) => records.map((record) => `\`${record.case_code}\``).join(', ');

/**
 * The server an action from a card runs in, and the moderator as a member of it. A card in the
 * main server can be about a support-server member (home servers share one review channel), so
 * every action that touches a member runs in the case's or message's own server (`guildId`),
 * never simply in the server of the click. Another server than the click's (only the other home
 * server can pass isSameCaseServer) needs the moderator to be an Administrator there too: role
 * hierarchy and the mass-action guard are checked in that server. Throws a user error otherwise
 * (in the clicker's Discord language).
 */
export async function actingGuild(interaction, guildId) {
    const clickGuildId = interaction.guild?.id || interaction.guildId;
    const targetId = guildId || clickGuildId;
    if (targetId === clickGuildId && interaction.guild) return { guild: interaction.guild, moderator: interaction.member };
    const tr = textForInteraction(interaction);
    if (!targetId || !isSameCaseServer(targetId, clickGuildId)) throw userError(tr.t('automod.review.error.otherServer'));
    const guild = interaction.client?.guilds?.cache?.get(targetId);
    if (!guild) throw userError(tr.t('automod.review.error.notInServer'));
    const moderator = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!moderator || !isAdministrator(moderator)) {
        throw userError(tr.t('automod.review.error.needAdmin', { server: guild.name }));
    }
    return { guild, moderator };
}

/** The server a card's message is about (its registry entry), else null (the click's server). */
function cardGuildId(message) {
    return (message?.id && getCard(message.id)?.guildId) || null;
}

/**
 * Handles a review card component. Returns the confirmation text for the moderator (in their
 * Discord language); the card itself is edited in the server's language.
 * `interaction.member` must be an administrator of the clicking server (checked by the caller);
 * actions that touch a member run in the case's own server (actingGuild).
 */
export async function handleReviewAction(interaction, args) {
    const [action, ...rest] = args;
    const { client, guild } = interaction;
    const admin = interaction.user;
    const by = admin.username;
    const message = interaction.message;
    const tr = textForInteraction(interaction); // the moderator's reply
    const cardTr = textForGuild(message?.guildId || guild?.id || interaction.guildId, { purpose: 'public' }); // the card
    const close = (target, outcome, opts = {}) => closeCard(target, outcome, { ...opts, lang: cardTr.lang });
    const lookupOpts = { lang: tr.lang };

    if (action === 'dismiss') {
        await close(message, cardTr.t('automod.review.outcome2.dismissedBy', { name: by }), { status: 'dismissed', by });
        return tr.t('automod.review.reply.dismissed');
    }

    if (action === '2nd') {
        // Second opinion on a kept card: [confirm|undo, keeperId, codes].
        const [choice, keeperId, codes] = rest;
        if (!canGiveSecondOpinion(admin.id, keeperId)) {
            throw userError(tr.t('automod.review.error.secondOwn'));
        }
        const records = await recordsFor(codes, guild?.id || interaction.guildId, getCaseByCode, lookupOpts);
        const original = message.reference?.messageId
            ? await message.channel.messages.fetch(message.reference.messageId).catch(() => null)
            : null;
        if (choice === 'confirm') {
            await close(message, cardTr.t('automod.review.outcome2.confirmedBy', { name: by, codes: codeList(records) }), { status: 'kept', by, verb: cardTr.t('automod.review.verb2.confirmed') });
            if (original) await close(original, cardTr.t('automod.review.outcome2.secondConfirmed', { name: by }));
            return tr.t('automod.review.reply.confirmed', { codes: codeList(records) });
        }
        if (choice === 'undo') {
            const { notes, dm } = await undoRecords(client, records, admin, cardTr);
            const outcome = cardTr.t('automod.review.outcome2.reversedSecond', { codes: codeList(records), name: by, notes: noteText(notes, cardTr), dm });
            const verb = cardTr.t('automod.review.verb2.undoneSecond');
            await close(message, outcome, { status: 'undone', by, verb });
            if (original) await close(original, outcome, { status: 'undone', by, verb });
            return tr.t('automod.review.reply.reversed', { codes: codeList(records), notes: noteText(notes, tr) });
        }
        throw userError(tr.t('automod.review.error.unknownSecond'));
    }

    if (action === 'tune') {
        // Self-tuning suggestion (automodTuning.js); the caller re-checked admin rights on click.
        // result.text is automodTuning's own sentence (English).
        const [rule] = rest;
        const result = await switchRuleToMonitor(guild.id, rule);
        await close(message, result.changed ? cardTr.t('automod.review.outcome2.tuneSwitched', { text: result.text, name: by }) : result.text,
            result.changed
                ? { status: 'applied', by, verb: cardTr.t('automod.review.verb2.switched') }
                : { status: 'dismissed', by, verb: cardTr.t('automod.review.verb2.closed') });
        return result.text;
    }

    if (action === 'delete') {
        const [channelId, messageId] = rest;
        const channelGuildId = client.channels?.cache?.get?.(channelId)?.guildId || cardGuildId(message);
        const { guild: messageGuild } = await actingGuild(interaction, channelGuildId);
        const channel = messageGuild.channels.cache.get(channelId) || await messageGuild.channels.fetch(channelId).catch(() => null);
        const target = channel?.isTextBased?.() ? await channel.messages.fetch(messageId).catch(() => null) : null;
        if (target) await target.delete().catch(() => {});
        await close(message, target
            ? cardTr.t('automod.review.outcome2.deletedBy', { name: by })
            : cardTr.t('automod.review.outcome2.alreadyGone', { name: by }), { status: 'deleted', by });
        return target ? tr.t('automod.review.reply.deleted') : tr.t('automod.review.reply.alreadyGone');
    }

    if (action === 'keep' || action === 'undo' || action === 'change') {
        const records = await recordsFor(rest[0], guild?.id || interaction.guildId, getCaseByCode, lookupOpts);

        if (action === 'keep') {
            await close(message, cardTr.t('automod.review.outcome2.keptBy', { name: by, codes: codeList(records) }), { status: 'kept', by });
            await maybeAskSecondOpinion(message, admin, records, cardTr.lang);
            return tr.t('automod.review.reply.kept', { codes: codeList(records) });
        }

        if (action === 'undo') {
            const { notes, dm } = await undoRecords(client, records, admin, cardTr);
            await close(message, cardTr.t('automod.review.outcome2.reversedBy', { codes: codeList(records), name: by, notes: noteText(notes, cardTr), dm }), { status: 'undone', by });
            return tr.t('automod.review.reply.reversed', { codes: codeList(records), notes: noteText(notes, tr) });
        }

        const choiceKey = interaction.values?.[0];
        const choice = REVIEW_ACTIONS[choiceKey];
        if (!choice) throw userError(tr.t('automod.review.error.pickPunishment'));
        const cardLabel = reviewActionLabel(choiceKey, { lang: cardTr.lang });
        const latest = records[records.length - 1];
        // The new punishment goes to the case's own server; checked before anything is reversed.
        const acting = await actingGuild(interaction, latest.guild_id);
        const targetUser = await client.users.fetch(latest.target_user_id);
        const notes = [];
        for (const record of records) notes.push(...(await reverse(client, record, admin, 'changed')).notes);
        let result;
        try {
            result = await executeAction({
                guild: acting.guild,
                moderator: acting.moderator,
                targetUser,
                flow: flowFor(choice.step, {
                    reason: `${latest.reason} (changed by ${by})`,
                    reasonKey: latest.reason_key,
                    targetUser,
                }),
            });
        } catch (error) {
            await close(message, cardTr.t('automod.review.outcome2.changeFailed', { name: by, action: cardLabel, error: error.userMessage || error.message }),
                { status: 'failed', by, verb: cardTr.t('automod.review.verb2.changeFailed', { action: cardLabel }) });
            throw error;
        }
        await dmReversal(client, latest, null, choiceKey);
        const code = result.record?.case_code;
        const changedNotes = noteText(notes, cardTr);
        await close(message, code
            ? cardTr.t('automod.review.outcome2.changedToCase', { action: cardLabel, code, name: by, notes: changedNotes })
            : cardTr.t('automod.review.outcome2.changedTo', { action: cardLabel, name: by, notes: changedNotes }),
        { status: 'changed', by, verb: cardTr.t('automod.review.verb2.changedTo', { action: cardLabel }) });
        const replyLabel = reviewActionLabel(choiceKey, { lang: tr.lang });
        return code
            ? tr.t('automod.review.reply.changedToCase', { action: replyLabel, code })
            : tr.t('automod.review.reply.changedTo', { action: replyLabel });
    }

    if (action === 'apply') {
        const [rule, userId] = rest;
        const choiceKey = interaction.values?.[0];
        const choice = REVIEW_ACTIONS[choiceKey];
        if (!choice) throw userError(tr.t('automod.review.error.pickPunishment'));
        const acting = await actingGuild(interaction, rest[2] || cardGuildId(message));
        const targetUser = await client.users.fetch(userId).catch(() => null);
        if (!targetUser) throw userError(tr.t('automod.review.error.userGone'));
        const definition = ruleDefinition(rule, null, acting.guild.id);
        const label = definition?.label;
        const result = await executeAction({
            guild: acting.guild,
            moderator: acting.moderator,
            targetUser,
            flow: flowFor(choice.step, {
                reason: label ? `Automod: ${label} (applied by ${by})` : `Reported message (decided by ${by})`,
                reasonKey: `automod:${definition?.group || REPORT_RULE}`,
                targetUser,
            }),
        });
        const code = result.record?.case_code;
        const cardLabel = reviewActionLabel(choiceKey, { lang: cardTr.lang });
        await close(message, code
            ? cardTr.t('automod.review.outcome2.appliedCase', { action: cardLabel, code, name: by })
            : cardTr.t('automod.review.outcome2.applied', { action: cardLabel, name: by }),
        { status: 'applied', by, verb: cardTr.t('automod.review.verb2.applied', { action: cardLabel }) });
        const replyLabel = reviewActionLabel(choiceKey, { lang: tr.lang });
        return code
            ? tr.t('automod.review.reply.appliedCase', { action: replyLabel, code })
            : tr.t('automod.review.reply.applied', { action: replyLabel });
    }

    throw userError(tr.t('automod.review.error.unknownAction'));
}
