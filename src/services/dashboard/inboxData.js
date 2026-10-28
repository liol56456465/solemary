// inboxData.js — the Inbox: one list of everything waiting for staff in the main server,
// oldest first, and the read / reply / close operations of a modmail conversation or a
// ticket from the web. Every function the Inbox calls is in `defaultInboxData`, so tests
// can replace any of them (createDashboard({ inbox })). They are the SAME services the
// Discord side uses (modmailService, ticket.js, appealService, the automod review queue).
//
// Kinds:
//   appeal  pending appeals (listPendingAppeals)                → /dashboard/appeals/:code
//   ticket  open tickets (ticket_data, status open, channel still there) → conversation page
//   modmail open conversations (modmail_links, channel still there)       → conversation page
//   report  open staff reports (mod_appeals kind 'report', pending, channel still there) → Discord
//   review  open automod review cards (collectOpenReviews, as the Automod page)         → Discord

import { query, T } from '../enforcement/db.js';
import { listPendingAppeals } from '../enforcement/appealService.js';
import { collectOpenReviews } from '../automod/reviewQueue.js';
import { chunkText, closeModmail, modmailUserId, sendStaffTextToMember } from '../modmailService.js';
import { closeTicket } from '../ticket.js';
import { getTicketData } from '../../utils/database.js';

export const INBOX_KINDS = {
    appeal: { label: 'Appeals', one: 'Appeal' },
    ticket: { label: 'Tickets', one: 'Ticket' },
    modmail: { label: 'Modmail', one: 'Modmail' },
    report: { label: 'Staff reports', one: 'Staff report' },
    review: { label: 'Automod reviews', one: 'Automod review' },
};

/** The kinds that have a conversation page (read, reply, close from the web). */
export const CONVERSATION_KINDS = ['modmail', 'ticket'];

const LIST_LIMIT = 100;
export const REPLY_MAX = 4000;
export const NOTE_PREFIX = '//';
export const HISTORY_LIMIT = 50;
const NO_MENTIONS = { parse: [] };

/** Open tickets of the guild: [{ channelId, userId, createdAt, claimedBy, priority, reason }]. */
export async function listOpenTickets(guildId) {
    const { rows } = await query(
        `SELECT channel_id, data, created_at FROM ${T.tickets}
         WHERE guild_id = $1 AND data->>'status' = 'open' ORDER BY created_at ASC LIMIT $2`,
        [guildId, LIST_LIMIT],
    );
    return rows.map((row) => ({
        channelId: row.channel_id,
        userId: row.data?.userId || null,
        createdAt: row.data?.createdAt || row.created_at || null,
        claimedBy: row.data?.claimedBy || null,
        priority: row.data?.priority || 'none',
        reason: typeof row.data?.reason === 'string' ? row.data.reason : '',
    }));
}

/** Open modmail conversations of the guild: [{ channelId, userId, createdAt }]. */
export async function listOpenModmail(guildId) {
    const { rows } = await query(
        `SELECT channel_id, user_id, created_at FROM ${T.modmailLinks} WHERE guild_id = $1 ORDER BY created_at ASC LIMIT $2`,
        [guildId, LIST_LIMIT],
    );
    return rows.map((row) => ({ channelId: row.channel_id, userId: row.user_id, createdAt: row.created_at }));
}

/** Pending staff reports that still have their channel: [{ id, userId, username, channelId, createdAt, staffMember }]. */
export async function listOpenReports(guildId) {
    const { rows } = await query(
        `SELECT id, user_id, username, channel_id, body, created_at FROM ${T.appeals}
         WHERE kind = 'report' AND guild_id = $1 AND status = 'pending' AND channel_id IS NOT NULL
         ORDER BY created_at ASC LIMIT $2`,
        [guildId, LIST_LIMIT],
    );
    return rows.map((row) => ({
        id: row.id, userId: row.user_id, username: row.username, channelId: row.channel_id, createdAt: row.created_at,
        staffMember: typeof row.body?.staffMember === 'string' ? row.body.staffMember : '',
    }));
}

export const defaultInboxData = {
    listPendingAppeals, listOpenTickets, listOpenModmail, listOpenReports, collectOpenReviews,
    modmailUserId, sendStaffTextToMember, closeModmail, closeTicket, getTicketData,
};

const discordLink = (guildId, channelId) => `https://discord.com/channels/${guildId}/${channelId}`;
const toTime = (value) => {
    const t = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(t) ? t : 0;
};

/**
 * Everything waiting for staff, oldest first: { items: [{ kind, at, title, who, userId,
 * href, external }], counts: { kind → n }, failed: [kind] }. Each source is read on its
 * own; one that fails is listed in `failed` (shown as "could not be loaded", never as 0).
 */
export async function collectInbox({ client, guildId, inbox = defaultInboxData }) {
    const guild = client.guilds?.cache?.get(guildId) || null;
    const hasChannel = (id) => Boolean(id && guild?.channels?.cache?.has?.(id));
    const userName = (id) => guild?.members?.cache?.get?.(id)?.user?.username || client.users?.cache?.get?.(id)?.username || null;
    const read = (run) => Promise.resolve().then(run).then((value) => ({ ok: true, value }), () => ({ ok: false, value: [] }));
    const [appeals, tickets, modmail, reports, reviews] = await Promise.all([
        read(() => inbox.listPendingAppeals(LIST_LIMIT, guildId)),
        read(() => inbox.listOpenTickets(guildId)),
        read(() => inbox.listOpenModmail(guildId)),
        read(() => inbox.listOpenReports(guildId)),
        read(() => inbox.collectOpenReviews(client)),
    ]);
    const items = [
        ...appeals.value.map((a) => ({
            kind: 'appeal', at: toTime(a.created_at), title: `Appeal on ${a.case_code} (${a.type || 'case'}${a.is_test ? ', test' : ''})`,
            who: a.username || a.user_id, userId: a.user_id, href: `/appeals/${encodeURIComponent(a.case_code)}`, action: 'Review appeal',
        })),
        ...tickets.value.filter((t) => hasChannel(t.channelId)).map((t) => ({
            kind: 'ticket', at: toTime(t.createdAt), title: `#${guild.channels.cache.get(t.channelId)?.name || t.channelId}${t.reason ? ` · ${t.reason}` : ''}`,
            who: userName(t.userId) || t.userId, userId: t.userId, href: `/inbox/ticket/${t.channelId}`, action: 'Open conversation',
            note: t.claimedBy ? `claimed by ${userName(t.claimedBy) || t.claimedBy}` : 'not claimed',
        })),
        ...modmail.value.filter((m) => hasChannel(m.channelId)).map((m) => ({
            kind: 'modmail', at: toTime(m.createdAt), title: `#${guild.channels.cache.get(m.channelId)?.name || m.channelId}`,
            who: userName(m.userId) || m.userId, userId: m.userId, href: `/inbox/modmail/${m.channelId}`, action: 'Open conversation',
        })),
        ...reports.value.filter((r) => hasChannel(r.channelId)).map((r) => ({
            kind: 'report', at: toTime(r.createdAt), title: `Report #${r.id}${r.staffMember ? ` about ${r.staffMember}` : ''}`,
            who: r.username || r.userId, userId: r.userId, href: discordLink(guildId, r.channelId), external: true, action: 'Open in Discord',
        })),
        ...reviews.value.filter((r) => typeof r.url === 'string' && /^https:\/\/(?:[a-z]+\.)?discord\.com\//.test(r.url)).map((r) => ({
            kind: 'review', at: toTime(r.at), title: r.title || 'Review card', who: null, userId: null,
            href: r.url, external: true, action: 'Open review card', note: r.count > 1 ? `${r.count} messages` : null,
        })),
    ].sort((a, b) => a.at - b.at);
    const counts = Object.fromEntries(Object.keys(INBOX_KINDS).map((kind) => [kind, items.filter((i) => i.kind === kind).length]));
    const failed = Object.entries({ appeal: appeals, ticket: tickets, modmail, report: reports, review: reviews })
        .filter(([, r]) => !r.ok).map(([kind]) => kind);
    return { items, counts, failed, total: items.length };
}

/** What a moderator may see: staff reports are complaints about staff, so admins only. */
export function inboxForModerator(result) {
    const items = result.items.filter((item) => item.kind !== 'report');
    return { ...result, items, counts: { ...result.counts, report: 0 }, failed: result.failed.filter((k) => k !== 'report'), total: items.length };
}

/**
 * The conversation behind an Inbox row: the channel and who it belongs to, or null when
 * it is not an open modmail conversation / ticket of this guild (the DB link decides,
 * never the channel name or topic).
 */
export async function findConversation({ client, guildId, kind, channelId, inbox = defaultInboxData }) {
    const guild = client.guilds?.cache?.get(guildId) || null;
    const channel = guild?.channels?.cache?.get?.(channelId) || null;
    if (!channel || typeof channel.send !== 'function') return null;
    if (kind === 'modmail') {
        const userId = await inbox.modmailUserId(channel);
        return userId ? { kind, channel, userId, guild } : null;
    }
    if (kind === 'ticket') {
        const ticket = await inbox.getTicketData(guildId, channelId);
        return ticket && ticket.status === 'open' ? { kind, channel, userId: ticket.userId || null, ticket, guild } : null;
    }
    return null;
}

const safeUrl = (value) => (typeof value === 'string' && /^https:\/\//.test(value) ? value : null);

/** The channel's last messages, oldest first, as plain data for the page (escaped there). */
export async function recentMessages(channel, limit = HISTORY_LIMIT) {
    const fetched = await channel.messages.fetch({ limit });
    return [...fetched.values()].sort((a, b) => toTime(a.createdTimestamp ?? a.createdAt) - toTime(b.createdTimestamp ?? b.createdAt)).map((m) => ({
        id: m.id,
        author: m.member?.displayName || m.author?.globalName || m.author?.username || 'unknown',
        authorId: m.author?.id || null,
        bot: Boolean(m.author?.bot),
        at: new Date(toTime(m.createdTimestamp ?? m.createdAt)),
        content: typeof m.content === 'string' ? m.content : '',
        embeds: [...(m.embeds || [])].map((e) => [e.title, e.description].filter(Boolean).join(' — ')).filter(Boolean),
        attachments: [...(m.attachments?.values?.() || [])].map((a) => ({ name: a.name || 'attachment', url: safeUrl(a.url) })).filter((a) => a.url),
    }));
}

/** The reply text from the form: trimmed, line breaks kept; '' when empty, null when too long. */
export function replyText(value) {
    if (typeof value !== 'string') return '';
    const textValue = value.replace(/\r\n?/g, '\n').trim();
    return textValue.length > REPLY_MAX ? null : textValue;
}

/** Sends `text` to `channel` in Discord-sized pieces, never pinging anyone. Returns the messages. */
async function postChunks(channel, text) {
    const sent = [];
    for (const chunk of chunkText(text)) sent.push(await channel.send({ content: chunk, allowedMentions: NO_MENTIONS }));
    return sent;
}

/**
 * A staff reply from the web, like staff typing in the Discord channel:
 * - modmail: the reply is posted in the channel (so staff in Discord see it), then DMed to
 *   the member as "Name (staff): …" (sendStaffTextToMember, like the canned answers); ✅ / ❌
 *   on the channel copy as for a Discord message. A reply starting with `//` is an internal
 *   note: posted in the channel only, never sent to the member.
 * - ticket: posted in the ticket channel (the member reads it there).
 * Returns { note, delivered } (delivered: true / false for a modmail DM, null otherwise).
 */
export async function sendReply({ conversation, staffName, text, inbox = defaultInboxData }) {
    const { kind, channel } = conversation;
    const note = kind === 'modmail' && text.startsWith(NOTE_PREFIX);
    const header = note ? `**${staffName} (internal note, from the dashboard):**` : `**${staffName} (staff, from the dashboard):**`;
    const copies = await postChunks(channel, `${header}\n${text}`);
    if (kind !== 'modmail' || note) return { note, delivered: null };
    let delivered = false;
    try {
        delivered = Boolean(await inbox.sendStaffTextToMember(channel, staffName, text));
    } catch {
        delivered = false;
    }
    const last = copies[copies.length - 1];
    await last?.react?.(delivered ? '✅' : '❌')?.catch?.(() => {});
    if (!delivered) {
        await channel.send({ content: 'Could not DM the member (they left the server or closed their DMs).', allowedMentions: NO_MENTIONS }).catch(() => {});
    }
    return { note: false, delivered };
}

/** Closes the conversation with the same service as the Close button / command. */
export async function closeConversation({ conversation, closer, reason, inbox = defaultInboxData }) {
    if (conversation.kind === 'modmail') return inbox.closeModmail(conversation.channel, closer, reason);
    return inbox.closeTicket(conversation.channel, closer, reason || 'Closed from the dashboard');
}
