// inboxPages.js — the Inbox list, a modmail / ticket conversation page (read, reply,
// close) and the close confirmation. Every value goes through `html` (escaped).
// Text: src/content/dashboard/<lang>/inbox.json (docs/dashboard-i18n.md).

import { formatAge, html, icon, layout, path, queryString, raw, timeTag } from './html.js';
import { actionForm } from './enforcementPages.js';
import { INBOX_KINDS, NOTE_PREFIX, REPLY_MAX } from './inboxData.js';
import { currentText, dashboardText } from './language.js';

const KIND_ICON = { appeal: 'appeals', ticket: 'tickets', modmail: 'messages', report: 'warn', review: 'automod' };
const userHref = (id) => path(`/users/${encodeURIComponent(id)}`);

// A kind's word ('label' = the list, 'one' = one item; catalog key "single") and a row's button:
// English keeps the words inboxData.js gives; other languages use inbox.kinds.* / inbox.action.*.
function kindWord(tr, kind, form) {
    const key = `inbox.kinds.${kind}.${form === 'one' ? 'single' : form}`;
    return tr.lang !== 'en' && tr.has(key) ? tr.t(key) : INBOX_KINDS[kind]?.[form];
}
function actionWord(tr, item) {
    const key = `inbox.action.${item.kind}`;
    return tr.lang !== 'en' && tr.has(key) ? tr.t(key) : item.action;
}

function kindTag(kind, tr = currentText()) {
    return html`<span class="tag inbox-kind">${icon(KIND_ICON[kind] || 'inbox')}${kindWord(tr, kind, 'one') || kind}</span>`;
}

function rowAction(item, tr = currentText()) {
    if (item.external) {
        return html`<a class="btn small" href="${item.href}" rel="noopener noreferrer" target="_blank">${actionWord(tr, item)}<span class="sr"> ${tr.t('inbox.list.opensDiscord')}</span></a>`;
    }
    return html`<a class="btn small" href="${path(item.href)}">${actionWord(tr, item)}</a>`;
}

/** input: { inbox (collectInbox), kind ('' = all), now }. */
export function inboxPage({ session, access = null, moduleStates = {}, inbox, kind = '', flash = null, now = Date.now() }) {
    const tr = dashboardText(session?.lang);
    const chip = (key, label, count) => html`<a class="chip" href="${path(`/inbox${queryString({ kind: key })}`)}"${key === kind ? raw(' aria-current="page"') : ''}>${label} <span class="chip-count">${count}</span></a>`;
    const chips = html`<nav class="chips" aria-label="${tr.t('inbox.list.filterLabel')}">${chip('', tr.t('inbox.list.all'), inbox.total)}${Object.keys(INBOX_KINDS).map((key) => chip(key, kindWord(tr, key, 'label'), inbox.counts[key] ?? 0))}</nav>`;
    const rows = kind ? inbox.items.filter((i) => i.kind === kind) : inbox.items;
    const failed = inbox.failed.length
        ? html`<p class="error" role="alert">${tr.t('inbox.list.failed', { kinds: inbox.failed.map((k) => kindWord(tr, k, 'label') || k).join(', ') })}</p>` : '';
    const emptyKind = kind && tr.has(`inbox.list.emptyKind.${kind}`) ? tr.t(`inbox.list.emptyKind.${kind}`) : `No open ${INBOX_KINDS[kind]?.label.toLowerCase() || 'items'}.`;
    const table = rows.length ? html`<div class="scroll"><table class="inbox-table"><thead><tr><th>${tr.t('inbox.list.kind')}</th><th>${tr.t('inbox.list.what')}</th><th>${tr.t('inbox.list.who')}</th><th>${tr.t('inbox.list.waiting')}</th><th></th></tr></thead><tbody>
${rows.map((item) => {
        const days = item.at ? (now - item.at) / 86400000 : 0;
        return html`<tr><td>${kindTag(item.kind, tr)}</td><td>${item.title}${item.note ? html` <span class="muted">· ${item.note}</span>` : ''}</td>
<td>${item.userId ? html`<a href="${userHref(item.userId)}">${item.who || item.userId}</a>` : html`<span class="muted">-</span>`}</td>
<td class="nowrap ${days >= 3 ? 'bad' : days >= 1 ? 'warn' : ''}" title="${item.at ? tr.fmtDateTime(new Date(item.at)) : ''}">${item.at ? formatAge(item.at, now) : '-'}</td>
<td class="nowrap">${rowAction(item, tr)}</td></tr>`;
    })}</tbody></table></div>`
        : html`<p class="empty">${kind ? emptyKind : tr.t('inbox.list.empty')}</p>`;
    const body = html`<header class="page-head"><h1>${tr.t('inbox.list.heading', { count: tr.fmtNumber(inbox.total) })}</h1><p>${tr.t('inbox.list.intro')}</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}${failed}${chips}${table}`;
    return layout({ title: tr.t('inbox.list.title'), active: 'inbox', session, access, moduleStates, body });
}

function message(m, tr = currentText()) {
    return html`<li class="msg${m.bot ? ' msg-bot' : ''}"><p class="msg-head"><b>${m.author}</b>${m.bot ? html` <span class="tag">${tr.t('inbox.conversation.bot')}</span>` : ''} <span class="muted">${timeTag(m.at)}</span></p>
${m.content ? html`<p class="msg-text">${m.content}</p>` : ''}${m.embeds.map((e) => html`<p class="msg-embed muted">${e}</p>`)}
${m.attachments.length ? html`<ul class="msg-files">${m.attachments.map((a) => html`<li><a href="${a.url}" rel="noopener noreferrer" target="_blank">${a.name}</a></li>`)}</ul>` : ''}</li>`;
}

/**
 * input: { kind, channel: { id, name }, member: { id, name }, messages (recentMessages),
 * canWrite, values, error, flash, editEnabled }.
 */
export function conversationPage({ session, access = null, moduleStates = {}, kind, channel, member, messages = [], canWrite = false, editEnabled = true, canAct = true, flash = null, error = null, values = {} }) {
    const tr = dashboardText(session?.lang);
    const base = `/inbox/${kind}/${channel.id}`;
    const modmail = kind === 'modmail';
    // tx() params are built apart (text nodes only; see the tx-in-attribute test).
    const prefix = html`<code>${NOTE_PREFIX}</code>`;
    const help = modmail ? tr.tx('inbox.conversation.helpModmail', { prefix }) : tr.t('inbox.conversation.helpTicket');
    const readOnly = !canWrite ? html`<p class="muted">${!editEnabled ? tr.t('inbox.conversation.editingOff') : !canAct ? tr.t('inbox.conversation.needsAdmin') : ''}</p>` : '';
    const memberLink = member?.id ? html`<a href="${userHref(member.id)}">${member.name || member.id}</a>` : '';
    const memberId = member?.id ? html`<span class="muted">${member.id}</span>` : '';
    const withMember = member?.id ? tr.tx('inbox.conversation.with', { member: memberLink, id: memberId }) : '';
    const body = html`<p><a href="${path(`/inbox${queryString({ kind })}`)}">${tr.t('inbox.conversation.back')}</a></p>
<header class="page-head"><h1>${tr.t(modmail ? 'inbox.conversation.headModmail' : 'inbox.conversation.headTicket', { channel: channel.name })}</h1><p>${withMember}<a href="${channel.url}" rel="noopener noreferrer" target="_blank">${tr.t('inbox.conversation.openDiscord')}</a></p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<section class="card"><h2>${tr.tp('inbox.conversation.last', messages.length)}</h2>${messages.length ? html`<ol class="msg-list">${messages.map((m) => message(m, tr))}</ol>` : html`<p class="empty">${tr.t('inbox.conversation.noMessages')}</p>`}</section>
<section class="card"><h2>${tr.t('inbox.conversation.reply')}</h2><p class="muted">${help}</p>${readOnly}
${actionForm(session.csrf, `${base}/reply`, html`<label class="wide">${tr.t('inbox.conversation.message')}<textarea name="text" rows="4" maxlength="${REPLY_MAX}" required>${values.text || ''}</textarea><span class="hint">${tr.t('inbox.conversation.replyHint', { max: tr.fmtNumber(REPLY_MAX) })}</span></label>`, { submit: tr.t('inbox.conversation.send'), enabled: canWrite })}</section>
<section class="card"><h2>${tr.t('inbox.conversation.close')}</h2><p class="muted">${tr.t(modmail ? 'inbox.conversation.closeHelpModmail' : 'inbox.conversation.closeHelpTicket')}</p>
${actionForm(session.csrf, `${base}/close/preview`, html`<label class="wide">${tr.t('inbox.conversation.reason')}<input type="text" name="reason" maxlength="500" value="${values.reason || ''}"></label>`, { submit: tr.t('inbox.conversation.closeButton'), danger: true, enabled: canWrite })}</section>`;
    return layout({ title: tr.t(modmail ? 'inbox.conversation.titleModmail' : 'inbox.conversation.titleTicket', { channel: channel.name }), active: 'inbox', session, access, moduleStates, body });
}

/** The close confirmation (a single-use token, 5 minutes). */
export function closeConfirmPage({ session, access = null, moduleStates = {}, kind, channel, member, reason, token, hash }) {
    const tr = dashboardText(session?.lang);
    const modmail = kind === 'modmail';
    const base = `/inbox/${kind}/${channel.id}`;
    const body = html`<p><a href="${path(base)}">${tr.t('inbox.confirm.back')}</a></p>
<h1>${tr.t(modmail ? 'inbox.confirm.headModmail' : 'inbox.confirm.headTicket', { channel: channel.name })}</h1>
<section class="card confirm-card"><dl><dt>${tr.t('inbox.confirm.member')}</dt><dd>${member?.name || member?.id || '-'} <span class="muted">${member?.id || ''}</span></dd>
<dt>${tr.t('inbox.confirm.reason')}</dt><dd>${reason || '-'}</dd>
<dt>${tr.t('inbox.confirm.effect')}</dt><dd>${tr.t(modmail ? 'inbox.confirm.effectModmail' : 'inbox.confirm.effectTicket')}</dd></dl>
<p class="muted">${tr.t('inbox.confirm.once')}</p>
${actionForm(session.csrf, `${base}/close`, '', { submit: tr.t('inbox.confirm.submit'), hidden: { token, fh: hash }, danger: true })}</section>`;
    return layout({ title: tr.t('inbox.confirm.title'), active: 'inbox', session, access, moduleStates, body });
}
