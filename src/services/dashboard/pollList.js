// pollList.js — Mewvo's open Discord polls in the main server, for "End a poll" on the Messages
// page (a list with an End button each instead of a pasted message link).
//
// Polls have no table of their own (no schema change): the candidates come from what exists:
//   1. the dashboard audit log: every poll posted from the dashboard has a `poll.<messageId>`
//      row (module "messages") with its channel; a poll lasts at most 7 days, so 8 days back;
//   2. the bot's message cache: polls Mewvo posted since its last restart (also /poll create).
// Each candidate is then checked on the message itself (still there, a native poll, posted by
// Mewvo, not ended or expired), so the list never offers a poll that cannot be ended. Polls
// posted with /poll before the last restart are not found: the link field stays for those.

import { query as dbQuery } from '../enforcement/db.js';
import { pgConfig } from '../../config/database/postgres.js';

export const OPEN_POLL_LOOKBACK_DAYS = 8;
export const OPEN_POLL_MAX = 25;

const pollKey = /^poll\.(\d{17,20})$/;
// Message IDs whose fetch found nothing (deleted, no access) → when; skipped for a few minutes.
const MISS_TTL_MS = 5 * 60 * 1000;
const misses = new Map();

function isOpen(message, botId, now) {
    const poll = message?.poll;
    if (!poll || !botId || message.author?.id !== botId) return false;
    if (poll.resultsFinalized) return false;
    const expires = poll.expiresTimestamp;
    return expires === null || expires === undefined || expires > now;
}

function row(message, channel) {
    return {
        messageId: message.id,
        channelId: channel.id,
        channelName: channel.name || channel.id,
        question: message.poll?.question?.text || '',
        endsAt: message.poll?.expiresTimestamp ?? null,
        url: message.url || null,
    };
}

/** Dashboard-posted poll candidates: [{ messageId, channelId }], newest first (anonymous reaction polls skipped). */
export async function auditPollCandidates(guildId, { query = dbQuery, table = pgConfig.tables.dashboard_audit, days = OPEN_POLL_LOOKBACK_DAYS, limit = 50 } = {}) {
    const { rows } = await query(
        `SELECT key, new FROM ${table}
         WHERE guild_id = $1 AND module = 'messages' AND key LIKE 'poll.%' AND created_at > NOW() - make_interval(days => $2)
         ORDER BY id DESC LIMIT $3`, [guildId, days, limit]);
    const ended = new Set(rows.map((r) => /^poll\.(\d{17,20})\.ended$/.exec(r.key)?.[1]).filter(Boolean));
    const out = [];
    for (const r of rows) {
        const id = pollKey.exec(r.key)?.[1];
        if (!id || ended.has(id) || r.new?.anonymous === true || typeof r.new?.channelId !== 'string') continue;
        out.push({ messageId: id, channelId: r.new.channelId });
    }
    return out;
}

/**
 * The open polls: [{ messageId, channelId, channelName, question, endsAt, url }], soonest end first.
 * `candidates` (from auditPollCandidates) are checked with at most `maxFetch` message reads.
 */
export async function listOpenPolls(guild, { candidates = [], now = Date.now(), maxFetch = OPEN_POLL_MAX } = {}) {
    if (!guild) return [];
    const botId = guild.client?.user?.id ?? guild.members?.me?.id;
    const found = new Map();
    // 2. the message cache (no API calls).
    for (const channel of guild.channels?.cache?.values?.() || []) {
        for (const message of channel.messages?.cache?.values?.() || []) {
            if (isOpen(message, botId, now)) found.set(message.id, row(message, channel));
        }
    }
    // 1. the audit candidates not in the cache: one fetch each, capped.
    let fetches = 0;
    for (const { messageId, channelId } of candidates) {
        if (found.has(messageId)) continue;
        const channel = guild.channels?.cache?.get?.(channelId);
        if (!channel || typeof channel.messages?.fetch !== 'function') continue;
        let message = channel.messages.cache?.get?.(messageId) || null;
        if (!message) {
            // A poll that was gone or unreadable a moment ago is not fetched again on every page load.
            if ((misses.get(messageId) || 0) > now - MISS_TTL_MS) continue;
            if (fetches >= maxFetch) break;
            fetches += 1;
            message = await channel.messages.fetch(messageId).catch(() => null);
            if (!message) {
                misses.set(messageId, now);
                if (misses.size > 500) misses.delete(misses.keys().next().value);
            }
        }
        if (isOpen(message, botId, now)) found.set(messageId, row(message, channel));
    }
    return [...found.values()].sort((a, b) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity)).slice(0, OPEN_POLL_MAX);
}

/**
 * Both steps for the dashboard (services.js): { polls, partial }. A failed audit read still
 * lists the cached polls (partial: true, the page says so).
 */
export async function openPollsFor(guild, guildId, deps = {}) {
    let partial = false;
    const candidates = await auditPollCandidates(guildId, deps).catch(() => { partial = true; return []; });
    return { polls: await listOpenPolls(guild, { candidates }), partial };
}
