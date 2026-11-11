// headsUp.js — "Heads-up first": for the rules policy.js lists (insults, sexual
// references, non-slur bad language, personal info, custom rules) the member's first hit
// within automodConfig.headsUpSeenMs is not acted on. Instead:
//
//   1. The member gets a DM ("edit or delete it within 2 minutes and nothing happens",
//      with a link to the message); when the DM fails, a short notice in the channel
//      that mentions only them and is deleted after headsUpNoticeMs.
//      Personal info is different: the message is deleted at once, the DM says so, and
//      that is all (no waiting, no case).
//   2. A waiting record goes into the key-value store (automod:headsup:pending:<guild>:<msg>,
//      TTL headsUpPendingTtlMs) plus an index key per server (automod:headsup:index:<guild>,
//      "<guild>:<msg>" → { dueAt, rule }; the row lock there decides who resolves it). The
//      per-minute check (automodService.runHeadsUpChecks) lists the waiting records to find the
//      servers with something waiting, then reads only their indexes, so it also works after a
//      restart and costs nothing for servers with nothing waiting. The old single index
//      (automod:headsup:index) is still read until it is empty, so heads-ups waiting during a
//      deploy are resolved too.
//   3. A compact line in the review channel: "Heads-up sent, waiting 2 minutes", later
//      struck through as "Fixed by member" or "Action taken".
//
// Resolution (automodService.js): an edit that no longer breaks the rule, or deleting the
// message → fixed; still there and still breaking it after the grace time → the normal
// action. Counts per guild and day (sent / fixed / acted) are kept for headsUpStats().
//
// "Seen" records: automod:headsup:seen:<guild>:<user>:<rule>, TTL headsUpSeenMs. A failed
// read or write of the seen or waiting record means no heads-up: automod acts as usual.

import { automodConfig } from '../../config/automod.js';
import { logger } from '../../utils/logger.js';
import { db, deleteFromDb, getFromDb, setInDb } from '../../utils/database.js';
import { sendDm } from '../enforcement/enforcementService.js';
import { isRaidJoiner } from './raidService.js';
import { closeCard, postReviewCard } from './reviewCards.js';
import { Mutex } from '../../utils/mutex.js';
import { headsUpDm, headsUpNotice, privacyHeadsUpDm, privacyHeadsUpNotice } from './policy.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { markOwnDelete } from '../logTamperService.js';

const DAY = 24 * 60 * 60 * 1000;
const LEGACY_INDEX_KEY = 'automod:headsup:index';
const PENDING_PREFIX = 'automod:headsup:pending:';
export const indexKey = (guildId) => `automod:headsup:index:${guildId}`;
const seenKey = (guildId, userId, rule) => `automod:headsup:seen:${guildId}:${userId}:${rule}`;
const pendingKey = (guildId, messageId) => `${PENDING_PREFIX}${guildId}:${messageId}`;
const statsKey = (guildId) => `automod:headsup:stats:${guildId}`;
const indexId = (guildId, messageId) => `${guildId}:${messageId}`;

// Waiting messages known to this process: "<guild>:<message>" → rule. Rebuilt from the
// indexes on every per-minute check, so after a restart it is complete within a minute
// (until then the check itself still resolves everything). Bounded: entries live 2 minutes.
const WAITING_MAX = 10000;
const waiting = new BoundedMap(WAITING_MAX);
// The old single index still had entries at the last check (read until it is empty once).
let legacyIndexInUse = true;

const defaultDeps = {
    kvGet: (key) => getFromDb(key, null),
    kvSet: (key, value, ttlSeconds) => setInDb(key, value, ttlSeconds),
    kvDelete: (key) => deleteFromDb(key),
    kvUpdate: (key, mutator) => db.update(key, mutator, null),
    kvList: (prefix) => db.list(prefix),
    sendDm: (user, content) => sendDm(user, content),
    postReviewCard: (p) => postReviewCard(p),
    closeCard: (...args) => closeCard(...args),
    isRaidJoiner: (...args) => isRaidJoiner(...args),
    now: () => Date.now(),
};
let deps = { ...defaultDeps };

/** Test hook: replace some side effects (no argument restores all) and forget the in-memory list. */
export function setHeadsUpDepsForTest(overrides = null) {
    deps = overrides ? { ...defaultDeps, ...overrides } : { ...defaultDeps };
    waiting.clear();
    legacyIndexInUse = true;
}

const graceMinutes = () => Math.round(automodConfig.headsUpGraceMs / 60000);

function sendNotice(message, content) {
    return message.channel?.send?.({ content, allowedMentions: { users: [message.author.id] } })
        .then((notice) => {
            if (notice) setTimeout(() => { markOwnDelete(notice.id); notice.delete().catch(() => {}); }, automodConfig.headsUpNoticeMs).unref?.();
            return notice;
        })
        .catch(() => null);
}

/** The waiting record's hit: what acting later needs (rule, card evidence, log detail, custom rule name). */
function storedHit(hit) {
    return {
        rule: hit.rule,
        evidence: hit.evidence ?? null,
        detail: hit.detail ?? null,
        ...(hit.ruleLabel ? { ruleLabel: hit.ruleLabel } : {}),
    };
}

/**
 * Gives a heads-up instead of acting, when the member has not had one for this rule
 * within headsUpSeenMs. The caller has checked policy.headsUpApplies. `card` is the
 * review card base (automodService.actOn); `deleteMessage` removes the message.
 * Returns 'pending' (waiting for the member), 'removed' (personal info: deleted, done)
 * or false (act as usual: already had one, raid joiner, or a database error).
 */
export function giveHeadsUp(message, hit, options) {
    // One at a time per member and rule: two messages at the same moment get one heads-up,
    // the other is acted on as usual (the "seen" check and write must not interleave).
    return Mutex.runExclusive(`automod-headsup:${message.guild.id}:${message.author.id}:${hit.rule}`,
        () => giveHeadsUpNow(message, hit, options));
}

async function giveHeadsUpNow(message, hit, { card, deleteMessage = async () => {} }) {
    const { guild, author } = message;
    if (await deps.isRaidJoiner(guild.id, author.id).catch(() => false)) return false;
    const now = deps.now();
    const seen = seenKey(guild.id, author.id, hit.rule);
    try {
        const record = await deps.kvGet(seen);
        if (record && Number(record.until) > now) return false;
    } catch (error) {
        logger.warn(`Automod heads-up for ${author.id} skipped (could not read the heads-up record: ${error.message}); acting normally`);
        return false;
    }

    const privacy = hit.rule === 'privacy';
    const pending = privacy ? null : {
        guildId: guild.id,
        channelId: message.channelId,
        messageId: message.id,
        userId: author.id,
        rule: hit.rule,
        hit: storedHit(hit),
        messageUrl: message.url || null,
        at: now,
        dueAt: now + automodConfig.headsUpGraceMs,
        dm: null,
        card: null,
    };
    try {
        // Seen first: if a later write fails the member only loses the heads-up, never gets two actions.
        await deps.kvSet(seen, { at: now, until: now + automodConfig.headsUpSeenMs, messageId: message.id },
            Math.ceil(automodConfig.headsUpSeenMs / 1000));
        if (pending) {
            await deps.kvSet(pendingKey(guild.id, message.id), pending, Math.ceil(automodConfig.headsUpPendingTtlMs / 1000));
            await deps.kvUpdate(indexKey(guild.id), (current) => ({
                ...(current && typeof current === 'object' ? current : {}),
                [indexId(guild.id, message.id)]: { dueAt: pending.dueAt, rule: hit.rule },
            }));
        }
    } catch (error) {
        logger.warn(`Automod heads-up for ${author.id} skipped (could not save it: ${error.message}); acting normally`);
        return false;
    }
    if (pending) waiting.set(indexId(guild.id, message.id), hit.rule);

    const channelName = message.channel?.name || null;
    const serverName = guild.name || null;
    if (privacy) await deleteMessage();
    const dmText = privacy
        ? privacyHeadsUpDm({ channelName, serverName })
        : headsUpDm({ ruleKey: hit.rule, ruleLabel: hit.ruleLabel, channelName, serverName, messageUrl: message.url, graceMinutes: graceMinutes() });
    const delivered = await deps.sendDm(author, dmText);
    if (!delivered) {
        await sendNotice(message, privacy
            ? privacyHeadsUpNotice(author.id)
            : headsUpNotice({ ruleKey: hit.rule, ruleLabel: hit.ruleLabel, userId: author.id, graceMinutes: graceMinutes() }));
    }

    const how = delivered ? 'DM' : 'channel notice';
    const title = privacy
        ? `Warned privately (${how}): personal info removed, no warning`
        : `Warned privately first (${how}), ${graceMinutes()} min to fix`;
    const cardMessage = await deps.postReviewCard({ ...card, note: { title }, deleted: privacy, noGroup: true })
        .catch((error) => {
            logger.warn(`Automod heads-up card failed: ${error.message}`);
            return null;
        });
    await bumpHeadsUpStat(guild.id, 'sent');
    if (privacy) return 'removed';

    pending.dm = delivered;
    if (cardMessage?.id) {
        pending.card = { channelId: cardMessage.channelId || cardMessage.channel?.id || null, messageId: cardMessage.id };
        // Only for updating the card later; the waiting record itself is already saved.
        await deps.kvSet(pendingKey(guild.id, message.id), pending, Math.ceil(automodConfig.headsUpPendingTtlMs / 1000))
            .catch((error) => logger.warn(`Automod heads-up card link not saved: ${error.message}`));
    }
    return 'pending';
}

/** The rule a heads-up is waiting on for this message (this process's list), or null. */
export function pendingHeadsUpRule(guildId, messageId) {
    return waiting.get(indexId(guildId, messageId)) || null;
}

/** Reads a waiting record without resolving it. Throws on a database error. */
export async function peekHeadsUp(guildId, messageId) {
    return deps.kvGet(pendingKey(guildId, messageId));
}

/**
 * Claims a waiting heads-up (removes it from the index under the row lock, so only one
 * of edit / delete / the per-minute check resolves it) and deletes its record. Returns
 * the record ({ guildId, messageId } when it had expired), or null when it was not
 * waiting (already resolved). Throws on a database error.
 */
export async function takeHeadsUp(guildId, messageId) {
    const id = indexId(guildId, messageId);
    let claimed = false;
    const claim = (current) => {
        const next = current && typeof current === 'object' ? { ...current } : {};
        if (Object.hasOwn(next, id)) {
            claimed = true;
            delete next[id];
        }
        return next;
    };
    await deps.kvUpdate(indexKey(guildId), claim);
    // Waiting since before the per-server indexes: claimed from the old single index.
    if (!claimed && legacyIndexInUse) await deps.kvUpdate(LEGACY_INDEX_KEY, claim);
    waiting.delete(id);
    if (!claimed) return null;
    const record = await deps.kvGet(pendingKey(guildId, messageId)).catch((error) => {
        logger.warn(`Automod heads-up record ${messageId} could not be read: ${error.message}`);
        return null;
    });
    await deps.kvDelete(pendingKey(guildId, messageId)).catch((error) =>
        logger.warn(`Automod heads-up record ${messageId} not deleted (expires by itself): ${error.message}`));
    return record || { guildId, messageId, expired: true };
}

const OUTCOME_TEXT = {
    edited: ['Fixed by member', 'The member edited the message in time.'],
    deleted: ['Fixed by member', 'The member deleted the message in time.'],
    acted: ['Action taken', 'The message was still there and still broke the rule, so the usual action ran (see its card).'],
    dropped: ['Closed', 'No action.'],
};

/**
 * Finishes a claimed heads-up: counts it (fixed / acted) and strikes through its review
 * line. outcome: 'edited' | 'deleted' (fixed), 'acted', or 'dropped' (`note` says why).
 */
export async function finishHeadsUp(client, record, outcome, note = null) {
    if (!record) return;
    if (outcome === 'edited' || outcome === 'deleted') await bumpHeadsUpStat(record.guildId, 'fixed');
    if (outcome === 'acted') await bumpHeadsUpStat(record.guildId, 'acted');
    logger.info(`Automod heads-up ${record.messageId} (${record.rule || 'unknown rule'}, user ${record.userId || '?'}): ${outcome}${note ? ` (${note})` : ''}`);
    if (!record.card?.channelId || !record.card?.messageId || !client) return;
    const channel = await client.channels?.fetch?.(record.card.channelId).catch(() => null);
    const cardMessage = await channel?.messages?.fetch?.(record.card.messageId).catch(() => null);
    if (!cardMessage) return;
    const [verb, text] = OUTCOME_TEXT[outcome] || OUTCOME_TEXT.dropped;
    await deps.closeCard(cardMessage, note && outcome === 'dropped' ? `No action: ${note}.` : text, { verb });
}

/** Message deleted (messageDelete, partials too): a waiting heads-up for it is fixed. */
export async function noteMessageDeleted(client, guildId, messageId) {
    if (!guildId || !pendingHeadsUpRule(guildId, messageId)) return false;
    try {
        const record = await takeHeadsUp(guildId, messageId);
        if (record) await finishHeadsUp(client, record, 'deleted');
        return Boolean(record);
    } catch (error) {
        logger.warn(`Automod heads-up for deleted message ${messageId} not resolved (${error.message}); the per-minute check retries`);
        return false;
    }
}

/**
 * Due heads-ups [{ guildId, messageId, rule }] (dueAt passed), and refreshes this
 * process's list of waiting messages from the index. Throws on a database error.
 */
export async function dueHeadsUps(now = deps.now()) {
    // Servers with a waiting record (records expire after headsUpPendingTtlMs).
    const guildIds = new Set();
    for (const key of await deps.kvList(PENDING_PREFIX) || []) {
        const [guildId] = String(key).slice(PENDING_PREFIX.length).split(':');
        if (guildId) guildIds.add(guildId);
    }
    const indexes = [];
    for (const guildId of guildIds) indexes.push(await deps.kvGet(indexKey(guildId)));
    if (legacyIndexInUse) {
        const legacy = await deps.kvGet(LEGACY_INDEX_KEY);
        const entries = legacy && typeof legacy === 'object' ? Object.keys(legacy).length : 0;
        if (entries) indexes.push(legacy);
        else legacyIndexInUse = false;
    }
    waiting.clear();
    const due = [];
    const seen = new Set();
    for (const index of indexes) {
        for (const [id, entry] of Object.entries(index && typeof index === 'object' ? index : {})) {
            const [guildId, messageId] = id.split(':');
            if (!guildId || !messageId || seen.has(id)) continue;
            seen.add(id);
            waiting.set(id, entry?.rule || 'unknown');
            if (Number(entry?.dueAt) <= now) due.push({ guildId, messageId, rule: entry?.rule || null });
        }
    }
    return due;
}

// ── Counts ────────────────────────────────────────────────────────────────────

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * +1 sent / fixed / acted for today (UTC) under the row lock; days older than
 * headsUpStatsKeepDays are dropped. A failed write is logged: counts never block moderation.
 */
export async function bumpHeadsUpStat(guildId, field) {
    const now = deps.now();
    const today = dayOf(now);
    const oldest = dayOf(now - automodConfig.headsUpStatsKeepDays * DAY);
    try {
        await deps.kvUpdate(statsKey(guildId), (current) => {
            const days = {};
            for (const [day, row] of Object.entries(current?.days && typeof current.days === 'object' ? current.days : {})) {
                if (day >= oldest) days[day] = row;
            }
            const row = { sent: 0, fixed: 0, acted: 0, ...(days[today] || {}) };
            row[field] = (Number(row[field]) || 0) + 1;
            days[today] = row;
            return { days };
        });
    } catch (error) {
        logger.warn(`Automod heads-up count (${field}) not saved for ${guildId}: ${error.message}`);
    }
}

/**
 * Heads-ups in the last `days` days (today included, UTC days): { days, sent, fixed, acted }.
 * Counts are kept headsUpStatsKeepDays (120). Throws on a database error.
 */
export async function headsUpStats(guildId, { days = 90, now = deps.now() } = {}) {
    const span = Math.max(1, Math.min(Number(days) || 90, automodConfig.headsUpStatsKeepDays));
    const stored = await deps.kvGet(statsKey(guildId));
    const from = dayOf(now - (span - 1) * DAY);
    const totals = { days: span, sent: 0, fixed: 0, acted: 0 };
    for (const [day, row] of Object.entries(stored?.days && typeof stored.days === 'object' ? stored.days : {})) {
        if (day < from) continue;
        totals.sent += Number(row?.sent) || 0;
        totals.fixed += Number(row?.fixed) || 0;
        totals.acted += Number(row?.acted) || 0;
    }
    return totals;
}
