// inboxPages.js — the Inbox list, a modmail / ticket conversation page (read, reply,
// close) and the close confirmation. Every value goes through `html` (escaped).

import { formatAge, formatDate, html, icon, layout, path, queryString, raw, timeTag } from './html.js';
import { actionForm } from './enforcementPages.js';
import { INBOX_KINDS, NOTE_PREFIX, REPLY_MAX } from './inboxData.js';

const KIND_ICON = { appeal: 'appeals', ticket: 'tickets', modmail: 'messages', report: 'warn', review: 'automod' };
const userHref = (id) => path(`/users/${encodeURIComponent(id)}`);

function kindTag(kind) {
    return html`<span class="tag inbox-kind">${icon(KIND_ICON[kind] || 'inbox')}${INBOX_KINDS[kind]?.one || kind}</span>`;
}

function rowAction(item) {
    if (item.external) {
        return html`<a class="btn small" href="${item.href}" rel="noopener noreferrer" target="_blank">${item.action}<span class="sr"> (opens Discord)</span></a>`;
    }
    return html`<a class="btn small" href="${path(item.href)}">${item.action}</a>`;
}

/** input: { inbox (collectInbox), kind ('' = all), now }. */
export function inboxPage({ session, access = null, moduleStates = {}, inbox, kind = '', flash = null, now = Date.now() }) {
    const chip = (key, label, count) => html`<a class="chip" href="${path(`/inbox${queryString({ kind: key })}`)}"${key === kind ? raw(' aria-current="page"') : ''}>${label} <span class="chip-count">${count}</span></a>`;
    const chips = html`<nav class="chips" aria-label="Filter by kind">${chip('', 'All', inbox.total)}${Object.entries(INBOX_KINDS).map(([key, k]) => chip(key, k.label, inbox.counts[key] ?? 0))}</nav>`;
    const rows = kind ? inbox.items.filter((i) => i.kind === kind) : inbox.items;
    const failed = inbox.failed.length
        ? html`<p class="error" role="alert">Could not be loaded right now: ${inbox.failed.map((k) => INBOX_KINDS[k]?.label || k).join(', ')}. Those counts are not complete; reload to try again.</p>` : '';
    const table = rows.length ? html`<div class="scroll"><table class="inbox-table"><thead><tr><th>Kind</th><th>What</th><th>Who</th><th>Waiting</th><th></th></tr></thead><tbody>
${rows.map((item) => {
        const days = item.at ? (now - item.at) / 86400000 : 0;
        return html`<tr><td>${kindTag(item.kind)}</td><td>${item.title}${item.note ? html` <span class="muted">· ${item.note}</span>` : ''}</td>
<td>${item.userId ? html`<a href="${userHref(item.userId)}">${item.who || item.userId}</a>` : html`<span class="muted">—</span>`}</td>
<td class="nowrap ${days >= 3 ? 'bad' : days >= 1 ? 'warn' : ''}" title="${item.at ? formatDate(new Date(item.at)) : ''}">${item.at ? formatAge(item.at, now) : '—'}</td>
<td class="nowrap">${rowAction(item)}</td></tr>`;
    })}</tbody></table></div>`
        : html`<p class="empty">${kind ? `No open ${INBOX_KINDS[kind]?.label.toLowerCase() || 'items'}.` : 'Nothing is waiting for staff.'}</p>`;
    const body = html`<header class="page-head"><h1>Inbox (${inbox.total})</h1><p>Everything waiting for staff, oldest first: appeals, tickets, modmail, staff reports and automod review cards. Amber after a day, red after three.</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}${failed}${chips}${table}`;
    return layout({ title: 'Inbox', active: 'inbox', session, access, moduleStates, body });
}

function message(m) {
    return html`<li class="msg${m.bot ? ' msg-bot' : ''}"><p class="msg-head"><b>${m.author}</b>${m.bot ? html` <span class="tag">bot</span>` : ''} <span class="muted">${timeTag(m.at)}</span></p>
${m.content ? html`<p class="msg-text">${m.content}</p>` : ''}${m.embeds.map((e) => html`<p class="msg-embed muted">${e}</p>`)}
${m.attachments.length ? html`<ul class="msg-files">${m.attachments.map((a) => html`<li><a href="${a.url}" rel="noopener noreferrer" target="_blank">${a.name}</a></li>`)}</ul>` : ''}</li>`;
}

/**
 * input: { kind, channel: { id, name }, member: { id, name }, messages (recentMessages),
 * canWrite, values, error, flash, editEnabled }.
 */
export function conversationPage({ session, access = null, moduleStates = {}, kind, channel, member, messages = [], canWrite = false, editEnabled = true, canAct = true, flash = null, error = null, values = {} }) {
    const base = `/inbox/${kind}/${channel.id}`;
    const modmail = kind === 'modmail';
    const help = modmail
        ? html`Sent as the bot, like typing in the Discord channel: the member gets a DM "Your server name (staff): …" and a copy is posted in the channel. Start with <code>${NOTE_PREFIX}</code> for an internal note (posted in the channel only, never sent to the member).`
        : 'Posted as the bot in the ticket channel (the member reads it there).';
    const readOnly = !canWrite ? html`<p class="muted">${!editEnabled ? 'Editing from the dashboard is off (DASHBOARD_EDIT_ENABLED): reply in Discord.' : !canAct ? 'Replying needs Administrator in the main server (bot owners without it can read only).' : ''}</p>` : '';
    const body = html`<p><a href="${path(`/inbox${queryString({ kind })}`)}">← Inbox</a></p>
<header class="page-head"><h1>${modmail ? 'Modmail' : 'Ticket'} · #${channel.name}</h1><p>${member?.id ? html`With <a href="${userHref(member.id)}">${member.name || member.id}</a> <span class="muted">${member.id}</span> · ` : ''}<a href="${channel.url}" rel="noopener noreferrer" target="_blank">Open in Discord</a></p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<section class="card"><h2>Last ${messages.length} messages</h2>${messages.length ? html`<ol class="msg-list">${messages.map(message)}</ol>` : html`<p class="empty">No messages yet.</p>`}</section>
<section class="card"><h2>Reply</h2><p class="muted">${help}</p>${readOnly}
${actionForm(session.csrf, `${base}/reply`, html`<label class="wide">Message<textarea name="text" rows="4" maxlength="${REPLY_MAX}" required>${values.text || ''}</textarea><span class="hint">Up to ${REPLY_MAX} characters; nobody is pinged.</span></label>`, { submit: 'Send reply', enabled: canWrite })}</section>
<section class="card"><h2>Close</h2><p class="muted">${modmail
        ? 'Like the Close button: the member is told by DM, the transcript goes to the transcript channel and the channel is deleted.'
        : 'Like the Close button: the ticket is closed (moved to the closed category if one is set), the member is DMed if that is on, and the transcript is filed.'}</p>
${actionForm(session.csrf, `${base}/close/preview`, html`<label class="wide">Reason (optional)<input type="text" name="reason" maxlength="500" value="${values.reason || ''}"></label>`, { submit: 'Close…', danger: true, enabled: canWrite })}</section>`;
    return layout({ title: `${modmail ? 'Modmail' : 'Ticket'} #${channel.name}`, active: 'inbox', session, access, moduleStates, body });
}

/** The close confirmation (a single-use token, 5 minutes). */
export function closeConfirmPage({ session, access = null, moduleStates = {}, kind, channel, member, reason, token, hash }) {
    const base = `/inbox/${kind}/${channel.id}`;
    const body = html`<p><a href="${path(base)}">← Back (cancel)</a></p>
<h1>Confirm: close ${kind === 'modmail' ? 'the modmail conversation' : 'the ticket'} #${channel.name}</h1>
<section class="card confirm-card"><dl><dt>Member</dt><dd>${member?.name || member?.id || '—'} <span class="muted">${member?.id || ''}</span></dd>
<dt>Reason</dt><dd>${reason || '—'}</dd>
<dt>Effect</dt><dd>${kind === 'modmail' ? 'The member is DMed that the conversation was closed, the transcript is filed and the channel is deleted.' : 'The ticket is closed for the member (they can no longer write in it), the transcript is filed.'}</dd></dl>
<p class="muted">This confirmation works once and expires in 5 minutes.</p>
${actionForm(session.csrf, `${base}/close`, '', { submit: 'Close now', hidden: { token, fh: hash }, danger: true })}</section>`;
    return layout({ title: 'Confirm close', active: 'inbox', session, access, moduleStates, body });
}
