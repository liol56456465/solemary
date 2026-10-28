// inboxRoutes.js — the Inbox and reading / replying / closing modmail and tickets from the web.
//
//   GET  /dashboard/inbox[?kind=]                       everything waiting for staff, oldest first
//   GET  /dashboard/inbox/:kind/:id                     a modmail conversation or ticket (kind modmail|ticket)
//   POST /dashboard/inbox/:kind/:id/reply               send as the bot (modmail: DM "Name (staff): …"; `//` = note)
//   POST /dashboard/inbox/:kind/:id/close/preview       confirm step (single-use token, 5 min)
//   POST /dashboard/inbox/:kind/:id/close               closeModmail / closeTicket
//
// POSTs go through the enforcement pages' guardedPost (rate limit, same origin + CSRF, edit
// switch, Administrator in the main server) and re-check Administrator on a freshly fetched
// member (freshModerator). Every reply and close is an audit row.
//
// The sidebar badge: the Inbox total, cached for BADGE_TTL_MS and refreshed in the
// background (never awaited by a page), so no page waits for it.

import { logger } from '../../utils/logger.js';
import { InputError, plainText, queryText, text } from './forms.js';
import { isSnowflake } from './security.js';
import { path, queryString } from './html.js';
import {
    CONVERSATION_KINDS, INBOX_KINDS, REPLY_MAX, closeConversation, collectInbox, defaultInboxData, findConversation, recentMessages, replyText, sendReply,
} from './inboxData.js';
import { closeConfirmPage, conversationPage, inboxPage } from './inboxPages.js';

export const BADGE_TTL_MS = 60 * 1000;

/** The cached Inbox count for the sidebar badge: peek() never waits; refresh() runs at most once at a time. */
export function createInboxBadge({ load, ttlMs = BADGE_TTL_MS, now = () => Date.now() }) {
    let value = null;
    let at = 0;
    let running = null;
    const refresh = () => {
        running ??= Promise.resolve().then(load).then((total) => { value = total; at = now(); }, (error) => {
            at = now(); // back off for a TTL after a failure too
            logger.warn(`Dashboard inbox badge refresh failed: ${error.message}`);
        }).finally(() => { running = null; });
        return running;
    };
    return {
        /** The last known total (null before the first load); starts a background refresh when stale. */
        peek() {
            if (now() - at >= ttlMs) refresh();
            return value;
        },
        set(total) { value = total; at = now(); },
        /** Forget the age (the next peek refreshes), keeping the last value on screen meanwhile. */
        invalidate() { at = 0; },
        refresh,
    };
}

export function createInboxHandlers(core) {
    const {
        client, guildId, settings, inbox = defaultInboxData, confirms, sendHtml, fail, shellOf, enforcement, badge = null,
    } = core;
    const { guardedPost, freshModerator, audit, flash } = enforcement;
    const canWrite = (req) => Boolean(settings.editEnabled && req.dashboard.access.canAct);

    async function list(req, res) {
        const requested = queryText(req.query, 'kind', 10);
        const kind = Object.hasOwn(INBOX_KINDS, requested) ? requested : '';
        const result = await collectInbox({ client, guildId, inbox });
        if (!result.failed.length) badge?.set(result.total);
        return sendHtml(res, 200, inboxPage({ ...shellOf(req), inbox: result, kind, flash: req.dashboard.flash }));
    }

    /** kind + channel id from the URL, or null. */
    function target(req) {
        const kind = typeof req.params?.kind === 'string' ? req.params.kind : '';
        const id = typeof req.params?.id === 'string' ? req.params.id : '';
        return CONVERSATION_KINDS.includes(kind) && isSnowflake(id) ? { kind, id } : null;
    }

    async function load(req) {
        const t = target(req);
        if (!t) return null;
        return findConversation({ client, guildId, kind: t.kind, channelId: t.id, inbox });
    }

    function memberOf(conversation) {
        const id = conversation.userId;
        if (!id) return null;
        const name = conversation.guild?.members?.cache?.get?.(id)?.user?.username || client.users?.cache?.get?.(id)?.username || null;
        return { id, name };
    }

    const channelView = (conversation) => ({
        id: conversation.channel.id, name: conversation.channel.name || conversation.channel.id,
        url: `https://discord.com/channels/${guildId}/${conversation.channel.id}`,
    });

    const gone = (res, req) => fail(res, 404, 'Not found', 'This conversation or ticket is not open any more (or never existed). It may have been closed in Discord.', req);

    async function renderConversation(req, res, status = 200, { error = null, values = {} } = {}) {
        const conversation = await load(req);
        if (!conversation) return gone(res, req);
        let messages = [];
        let readError = null;
        try {
            messages = await recentMessages(conversation.channel);
        } catch (err) {
            logger.warn(`Dashboard inbox: messages of ${conversation.channel.id} not read: ${err.message}`);
            readError = 'The messages could not be loaded from Discord. Reload to try again.';
        }
        return sendHtml(res, status, conversationPage({
            ...shellOf(req), kind: conversation.kind, channel: channelView(conversation), member: memberOf(conversation), messages,
            canWrite: canWrite(req), editEnabled: settings.editEnabled, canAct: req.dashboard.access.canAct,
            flash: status === 200 ? req.dashboard.flash : null, error: error || readError, values,
        }));
    }

    const conversation = (req, res) => renderConversation(req, res);
    const rerender = (req, res, status, message) => renderConversation(req, res, status, {
        error: message, values: { text: typeof req.body?.text === 'string' ? req.body.text.slice(0, REPLY_MAX) : '', reason: text(req.body, 'reason', 500) },
    });

    /** The open conversation for a POST, or an InputError (404). */
    async function requireConversation(req) {
        const found = await load(req);
        if (!found) throw new InputError('This conversation or ticket is not open any more. Nothing was sent.', 404);
        return found;
    }

    const reply = guardedPost(async (req, res) => {
        const found = await requireConversation(req);
        const message = replyText(req.body?.text);
        if (message === null) throw new InputError(`The reply is longer than ${REPLY_MAX} characters.`);
        if (!message) throw new InputError('Write a reply first.');
        const moderator = await freshModerator(req);
        const staffName = moderator.displayName || moderator.user?.globalName || moderator.user?.username || req.dashboard.session.username;
        const result = await sendReply({ conversation: found, staffName, text: message, inbox });
        await audit(req, 'inbox', [{
            key: `${found.kind}:${found.channel.id}`, old: null,
            new: { reply: message.slice(0, 500), note: result.note, ...(result.delivered === null ? {} : { dmDelivered: result.delivered }) },
        }]);
        await flash(req, result.note ? 'Internal note posted in the channel (not sent to the member).'
            : found.kind === 'ticket' ? 'Reply posted in the ticket.'
                : result.delivered ? 'Reply sent to the member by DM and copied to the channel.'
                    : 'The reply was posted in the channel, but the DM could not be delivered (they left the server or closed their DMs).');
        return res.redirect(303, path(`/inbox/${found.kind}/${found.channel.id}`));
    }, { rerender });

    const closePreview = guardedPost(async (req, res) => {
        const found = await requireConversation(req);
        await freshModerator(req);
        const reason = text(req.body, 'reason', 500);
        const payload = { kind: found.kind, channelId: found.channel.id, reason };
        const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: `inbox-close:${found.kind}:${found.channel.id}`, payload });
        return sendHtml(res, 200, closeConfirmPage({ ...shellOf(req), kind: found.kind, channel: channelView(found), member: memberOf(found), reason, token, hash }));
    }, { rerender });

    const close = guardedPost(async (req, res) => {
        const t = target(req);
        if (!t) throw new InputError('This conversation or ticket is not open any more.', 404);
        const payload = confirms.consume(text(req.body, 'token', 100), {
            session: req.dashboard.session.idHash, subject: `inbox-close:${t.kind}:${t.id}`, hash: text(req.body, 'fh', 100),
        });
        if (!payload) throw new InputError('This confirmation expired or was already used. Nothing was closed; press Close again.');
        const found = await requireConversation(req);
        const moderator = await freshModerator(req);
        const closer = moderator.user || { id: moderator.id, username: req.dashboard.session.username };
        await closeConversation({ conversation: found, closer, reason: payload.reason || '', inbox });
        await audit(req, 'inbox', [{ key: `${found.kind}:${found.channel.id}`, old: 'open', new: { closed: true, reason: payload.reason || null } }]);
        badge?.invalidate();
        await flash(req, `${found.kind === 'modmail' ? 'Modmail conversation' : 'Ticket'} #${plainText(found.channel.name || found.channel.id)} closed.`);
        return res.redirect(303, path(`/inbox${queryString({ kind: found.kind })}`));
    }, { rerender });

    return { list, conversation, reply, closePreview, close };
}
