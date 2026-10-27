// reviewRegistry.js — in-memory record of the review cards posted since startup,
// the automod hits of the last day and a few alert events, for burst grouping,
// /automod queue and the daily digest.
//
// Nothing here is persisted: a restart starts with an empty registry (no grouping
// into cards posted before the restart; /automod queue then also scans the review
// channel; the digest says which numbers are "since startup").

import { automodConfig } from '../../config/automod.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CARDS = 2000;
const MAX_HITS = 20000;

const cards = new Map();   // card message id → entry (see reviewFormat.js), plus { messageId, channelId, url, open, closedStatus }
const bursts = new Map();  // burst key → card message id
let hits = [];             // [{ at, rule, channelId, monitor }]
const events = [];         // [{ at, kind }]
export const startedAt = Date.now();

/**
 * Cards are grouped by member, rule and kind (an enforced hit never joins a monitor-mode
 * card); member reports and raid kicks are never grouped.
 */
export function burstKey(p) {
    if (!p.userId || !p.rule || p.kind === 'report' || p.noGroup) return null;
    return `${p.guildId || ''}:${p.userId}:${p.rule}:${p.kind || 'action'}`;
}

/** The open card for this burst, if its last hit is within the window. */
export function findOpenBurst(key, now = Date.now(), windowMs = automodConfig.burstWindowMs) {
    if (!key) return null;
    const entry = cards.get(bursts.get(key));
    if (!entry || !entry.open || now - entry.lastAt > windowMs) return null;
    return entry;
}

export function registerCard(entry) {
    cards.set(entry.messageId, entry);
    if (entry.key) bursts.set(entry.key, entry.messageId);
    if (cards.size > MAX_CARDS) pruneCards();
    return entry;
}

export function getCard(messageId) {
    return cards.get(messageId) || null;
}

/** Marks a card reviewed: it is never grouped into again and leaves the queue. */
export function markClosed(messageId, status) {
    const entry = cards.get(messageId);
    if (!entry) return null;
    entry.open = false;
    entry.closedStatus = status;
    entry.closedAt = Date.now();
    if (entry.renderTimer) {
        clearTimeout(entry.renderTimer);
        entry.renderTimer = null;
    }
    return entry;
}

/** Open cards, newest first. Compact lines are included only with `includeCompact`. */
export function openCards({ includeCompact = false } = {}) {
    return [...cards.values()]
        .filter((entry) => entry.open && (includeCompact || entry.tier !== 'compact'))
        .sort((a, b) => b.firstAt - a.firstAt);
}

function pruneCards(now = Date.now()) {
    for (const [id, entry] of cards) {
        const age = now - (entry.lastAt || entry.firstAt || 0);
        if ((!entry.open && age > DAY_MS) || age > 7 * DAY_MS) {
            cards.delete(id);
            if (entry.key && bursts.get(entry.key) === id) bursts.delete(entry.key);
        }
    }
    // Still too many: drop the oldest.
    if (cards.size > MAX_CARDS) {
        const oldest = [...cards.values()].sort((a, b) => a.lastAt - b.lastAt).slice(0, cards.size - MAX_CARDS);
        for (const entry of oldest) {
            cards.delete(entry.messageId);
            if (entry.key && bursts.get(entry.key) === entry.messageId) bursts.delete(entry.key);
        }
    }
}

/** One automod hit (acted on, monitored, or suppressed by the cooldown). */
export function recordHit({ rule, channelId = null, monitor = false }, now = Date.now()) {
    hits.push({ at: now, rule, channelId, monitor });
    if (hits.length > MAX_HITS || (hits.length % 500 === 0)) hits = hits.filter((hit) => now - hit.at <= DAY_MS).slice(-MAX_HITS);
}

export function hitsSince(since) {
    return hits.filter((hit) => hit.at >= since);
}

/** An alert worth counting in the digest ('raid', …). */
export function recordEvent(kind, now = Date.now()) {
    events.push({ at: now, kind });
    while (events.length && now - events[0].at > 2 * DAY_MS) events.shift();
}

export function eventsSince(since, kind = null) {
    return events.filter((event) => event.at >= since && (!kind || event.kind === kind));
}

/** Test hook. */
export function resetReviewRegistry() {
    for (const entry of cards.values()) if (entry.renderTimer) clearTimeout(entry.renderTimer);
    cards.clear();
    bursts.clear();
    hits = [];
    events.length = 0;
}
