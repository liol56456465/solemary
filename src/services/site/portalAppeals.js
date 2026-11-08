// portalAppeals.js — web appeals on the member portal (multi-server B4a).
//
// A member banned from a server often shares no server with the bot, so the Discord appeal panel
// and DMs cannot reach them. Here they log in with Discord (identify only, memberPortal.js) and
// appeal their OWN cases in any server:
//
//   GET  /me/appeals        the cases they can appeal now (every server) + their appeals and status
//   GET  /me/appeal/:code   the case and the appeal form (the Discord form's three questions)
//   POST /me/appeal/:code   CSRF token + same-origin check + a per-member limit, then
//                           appealService.submitAppeal: the normal flow for that case's server
//                           (one pending appeal per case, the cooldown after a denial, unappealable
//                           cases, the appeal window; staff channel of that server, else stored for
//                           the dashboard's Appeals list)
//
// Who: the user id comes from the session only. A case code of somebody else, a /test case and
// an unknown code all get the same "not found" page, so codes cannot be probed.
// What the member sees: the server's name, case code, type, reason, dates, whether and until when
// it can be appealed, and their appeals' status. Never: moderator names or ids, staff notes,
// decision notes, evidence, who claimed or decided an appeal.
// The decision belongs only to the staff of the server that issued the case: submitAppeal routes
// it there (appealStaffGuildId), and nothing on this page decides anything.
// Text: src/content/site/<lang>/portal.json (appeals.*, appealForm.*).

import { html } from '../dashboard/html.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { isHomeGuild } from '../settings/guildSettings.js';
import { isSameOrigin, safeEqual } from '../dashboard/security.js';
import { normalizeCaseCode } from '../enforcement/format.js';
import { layout, portalTime } from './shell.js';
import { textOf, translator } from './i18n.js';
import { logger } from '../../utils/logger.js';

export const APPEALS_PATH = '/me/appeals';
export const appealPath = (code) => `/me/appeal/${encodeURIComponent(code)}`;

// The Discord form's limits (appealsHandler.js appealModal): "Why should it be lifted?" 20–1000.
export const APPEAL_FIELD_LIMITS = Object.freeze({ punishedMax: 1000, reasonMin: 20, reasonMax: 1000 });
export const DID_IT_CHOICES = Object.freeze(['yes', 'partly', 'no']);
// Per member (user id), on top of the per-address page limit: a handful of appeals an hour.
export const APPEAL_SUBMIT_LIMIT = Object.freeze({ limit: 5, windowMs: 60 * 60 * 1000 });
const CASE_LIMIT = 200;
const APPEAL_LIMIT = 100;
const CASE_TYPES = new Set(['ban', 'kick', 'mute', 'warn']);
const APPEAL_STATUSES = new Set(['pending', 'accepted', 'denied', 'closed']);

/** The server name a member sees: Mewvo's own servers as Mewvo, another by its Discord name. */
export function serverLabel(guildId, guildName, { t } = translator()) {
    if (isHomeGuild(guildId)) return enforcementConfig.serverName;
    const name = String(guildName ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100);
    return name || t('portal.appeals.unknownServer');
}

/** The latest pending or denied appeal per case (what assertAppealable looks at). appeals: newest first. */
function lastBlockingByCase(appeals) {
    const out = new Map();
    for (const appeal of appeals || []) {
        if ((appeal.status === 'pending' || appeal.status === 'denied') && !out.has(appeal.case_code)) out.set(appeal.case_code, appeal);
    }
    return out;
}

/** One case for the member: only member-safe fields (no moderator, no notes). Pure. */
export function caseItem(row, { lastAppeal = null, guildName = null, now = Date.now(), text = translator(), appealInfo }) {
    const { t } = text;
    return {
        code: row.case_code,
        guildId: row.guild_id,
        server: serverLabel(row.guild_id, guildName, text),
        type: CASE_TYPES.has(row.type) ? t(`portal.caseType.${row.type}`) : row.type,
        reason: row.reason,
        createdAt: row.created_at,
        endsAt: row.type === 'ban' || row.type === 'mute' ? row.expires_at || null : null,
        permanent: row.type === 'ban' && !row.expires_at,
        appeal: appealInfo(row, lastAppeal, { now, text }),
    };
}

/**
 * The /me/appeals view from the member's own rows: { appealable, appeals }. Only cases of
 * `userId` count (a stray row of somebody else is dropped, whatever the data layer returned).
 */
export function buildAppealsView({ userId, cases, appeals, guildName = () => null, now = Date.now(), text = translator(), appealInfo }) {
    const { t } = text;
    const own = (cases || []).filter((row) => row.target_user_id === userId && !row.is_test);
    const codes = new Set(own.map((row) => row.case_code));
    const ownAppeals = (appeals || []).filter((appeal) => codes.has(appeal.case_code));
    const blocking = lastBlockingByCase(ownAppeals);
    const byCode = new Map(own.map((row) => [row.case_code, row]));
    const appealable = own
        .map((row) => caseItem(row, { lastAppeal: blocking.get(row.case_code), guildName: guildName(row.guild_id), now, text, appealInfo }))
        .filter((item) => item.appeal.appealable);
    return {
        appealable,
        appeals: ownAppeals.map((appeal) => {
            const gid = appeal.guild_id || byCode.get(appeal.case_code)?.guild_id || null;
            let status = APPEAL_STATUSES.has(appeal.status) ? t(`portal.appealStatus.${appeal.status}`) : appeal.status;
            if (appeal.status === 'pending' && appeal.claimed_at) status = t('portal.appeals.claimed');
            return {
                code: appeal.case_code,
                server: serverLabel(gid, guildName(gid), text),
                type: CASE_TYPES.has(appeal.type) ? t(`portal.caseType.${appeal.type}`) : appeal.type,
                status,
                filedAt: appeal.created_at,
                decidedAt: appeal.decided_at || null,
            };
        }),
    };
}

/** The form's answers, checked: { answers } or { error, field }. Same keys as the stored body. Pure. */
export function parseAppealForm(body, { t } = translator()) {
    const clean = (value, max) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
    const punished = clean(body?.punished, APPEAL_FIELD_LIMITS.punishedMax);
    const reason = clean(body?.reason, APPEAL_FIELD_LIMITS.reasonMax);
    const didIt = DID_IT_CHOICES.find((choice) => choice === body?.didIt) || '';
    const values = { punished, reason, didIt };
    if (!punished) return { values, field: 'punished', error: t('portal.appealForm.errors.punished') };
    if (reason.length < APPEAL_FIELD_LIMITS.reasonMin) return { values, field: 'reason', error: t('portal.appealForm.errors.reason', { min: APPEAL_FIELD_LIMITS.reasonMin }) };
    if (!didIt) return { values, field: 'didIt', error: t('portal.appealForm.errors.didIt') };
    return { values, answers: { punished, reason, didIt } };
}

// ── Pages ─────────────────────────────────────────────────────────────────

/** A date in the page's language (shell.js portalTime). */
const when = (ctx, value) => portalTime(ctx, value);

function untilCell(text, item) {
    const { t } = text;
    if (item.appeal.until) return when(text, item.appeal.until);
    return t('portal.appeal.appealable');
}

export function appealsPage(ctx, { session, view, sent = null }) {
    const { t, ti } = textOf(ctx);
    const col = (key) => html`<th scope="col">${t(`portal.appeals.column.${key}`)}</th>`;
    return layout(ctx, {
        title: t('portal.appeals.title'), active: 'me',
        body: html`<div class="wrap page record"><div class="record-head"><div><h1>${t('portal.appeals.title')}</h1>
<p class="lead">${ti('portal.appeals.lead', { username: session.username || session.userId })}</p></div>
<div class="record-links"><a class="button button-quiet" href="/me">${t('portal.appeals.backToRecord')}</a></div></div>
${sent ? html`<p class="flash" role="status">${t('portal.appeals.sent', { code: sent.code, server: sent.server })}</p>` : ''}
<p class="note">${t('portal.appeals.whoDecides')}</p>
<h2 id="appealable-title">${t('portal.appeals.appealable')}</h2>
${view.appealable.length ? html`<div class="table-wrap" role="region" aria-labelledby="appealable-title" tabindex="0"><table class="record-table appeal-table"><thead><tr>${col('server')}${col('case')}${col('reason')}${col('type')}${col('date')}${col('until')}${col('action')}</tr></thead>
<tbody>${view.appealable.map((c) => html`<tr><td>${c.server}</td><td><code>${c.code}</code></td><td>${c.reason}</td><td>${c.type}</td><td>${when(ctx, c.createdAt)}</td><td>${untilCell(textOf(ctx), c)}</td><td><a class="button" href="${appealPath(c.code)}">${t('portal.appeals.appealButton')}</a></td></tr>`)}</tbody></table></div>`
        : html`<p>${t('portal.appeals.noneAppealable')}</p>`}
<h2 id="history-title">${t('portal.appeals.history')}</h2>
${view.appeals.length ? html`<div class="table-wrap" role="region" aria-labelledby="history-title" tabindex="0"><table class="record-table appeal-table"><thead><tr>${col('server')}${col('case')}${col('type')}${col('status')}${col('filed')}${col('decided')}</tr></thead>
<tbody>${view.appeals.map((a) => html`<tr><td>${a.server}</td><td><code>${a.code}</code></td><td>${a.type}</td><td>${a.status}</td><td>${when(ctx, a.filedAt)}</td><td>${when(ctx, a.decidedAt)}</td></tr>`)}</tbody></table></div>`
        : html`<p>${t('portal.appeals.noAppeals')}</p>`}
<p class="note">${t('portal.appeals.dmNote')}</p></div>`,
    });
}

function caseFacts(text, item) {
    const { t } = text;
    const row = (key, value) => html`<div><dt>${t(`portal.appealForm.facts.${key}`)}</dt><dd>${value}</dd></div>`;
    return html`<dl class="account-facts">${row('server', item.server)}${row('case', html`<code>${item.code}</code>`)}${row('type', item.type)}${row('reason', item.reason)}${row('date', when(text, item.createdAt))}${item.permanent ? row('ends', t('portal.record.permanent')) : item.endsAt ? row('ends', when(text, item.endsAt)) : ''}</dl>`;
}

/** The case and, when it can be appealed now, the form. `values` refill the form after an error. */
export function appealFormPage(ctx, { session, item, values = {}, error = null, field = null }) {
    const text = textOf(ctx);
    const { t, ti } = text;
    const L = APPEAL_FIELD_LIMITS;
    const invalid = (name) => (field === name ? html` aria-invalid="true"` : '');
    const choice = (value) => html`<div class="form-check"><input id="ap-did-${value}" name="didIt" type="radio" value="${value}" required${values.didIt === value ? html` checked` : ''}><label for="ap-did-${value}">${t(`portal.appealForm.didIt.${value}`)}</label></div>`;
    const blocked = !item.appeal.appealable;
    const why = item.appeal.from ? html`${item.appeal.text} ${when(text, item.appeal.from)}` : item.appeal.text;
    return layout(ctx, {
        title: t('portal.appealForm.title', { code: item.code }), active: 'me',
        body: html`<div class="wrap page"><div class="account"><h1>${t('portal.appealForm.title', { code: item.code })}</h1>
<p class="lead">${ti('portal.appealForm.lead', { server: item.server })}</p>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${caseFacts(text, item)}
${blocked ? html`<p class="error" role="status">${t('portal.appealForm.notAppealable')} ${why}</p>
<p class="form-actions"><a class="button button-quiet" href="${APPEALS_PATH}">${t('portal.appealForm.back')}</a></p>`
        : html`<form class="form-stack" method="post" action="${appealPath(item.code)}"><input type="hidden" name="csrf" value="${session.csrf}">
<div class="form-field"><label for="ap-punished">${t('portal.appealForm.punished')}</label><textarea id="ap-punished" name="punished" rows="4" required maxlength="${L.punishedMax}" aria-describedby="ap-punished-hint"${invalid('punished')}>${values.punished || ''}</textarea><p class="form-hint" id="ap-punished-hint">${t('portal.appealForm.punishedHint', { max: L.punishedMax })}</p></div>
<div class="form-field"><label for="ap-reason">${t('portal.appealForm.reason')}</label><textarea id="ap-reason" name="reason" rows="6" required minlength="${L.reasonMin}" maxlength="${L.reasonMax}" aria-describedby="ap-reason-hint"${invalid('reason')}>${values.reason || ''}</textarea><p class="form-hint" id="ap-reason-hint">${t('portal.appealForm.reasonHint', { min: L.reasonMin, max: L.reasonMax })}</p></div>
<fieldset class="form-choice"><legend>${t('portal.appealForm.didItLabel')}</legend>${DID_IT_CHOICES.map(choice)}</fieldset>
<p class="form-hint">${t('portal.appealForm.note')}</p>
<p class="form-actions"><button class="button" type="submit">${t('portal.appealForm.submit')}</button><a href="${APPEALS_PATH}">${t('portal.appealForm.back')}</a></p></form>`}
</div></div>`,
    });
}

/**
 * The login ran out before the form was sent: nothing was sent and no case is looked up (there is
 * no member to check it against). The typed answers are shown again to copy, outside any form, with
 * a login link that comes back to this appeal (next=). Never submits anything.
 */
export function appealExpiredPage(ctx, { code, values = {} }) {
    const { t } = textOf(ctx);
    const L = APPEAL_FIELD_LIMITS;
    const loginHref = `/me/login?next=${encodeURIComponent(appealPath(code))}`;
    const didIt = DID_IT_CHOICES.includes(values.didIt) ? t(`portal.appealForm.didIt.${values.didIt}`) : '-';
    return layout(ctx, {
        title: t('portal.appealForm.title', { code }), active: 'me',
        body: html`<div class="wrap page"><div class="account"><h1>${t('portal.appealForm.title', { code })}</h1>
<p class="error" role="alert">${t('portal.appealForm.expired.message')}</p>
<p class="form-actions"><a class="button" href="${loginHref}">${t('portal.appealForm.expired.logIn')}</a></p>
<div class="form-stack"><div class="form-field"><label for="ap-punished">${t('portal.appealForm.punished')}</label><textarea id="ap-punished" rows="4" maxlength="${L.punishedMax}" readonly>${values.punished || ''}</textarea></div>
<div class="form-field"><label for="ap-reason">${t('portal.appealForm.reason')}</label><textarea id="ap-reason" rows="6" maxlength="${L.reasonMax}" readonly>${values.reason || ''}</textarea></div>
<dl class="account-facts"><div><dt>${t('portal.appealForm.didItLabel')}</dt><dd>${didIt}</dd></div></dl>
<p class="form-hint">${t('portal.appealForm.expired.copyHint')}</p></div></div></div>`,
    });
}

// ── Handlers ──────────────────────────────────────────────────────────────

/**
 * The three handlers. `data`: { listCases(userId, {limit}), listUserAppeals(userId, limit),
 * getCase(code), guildName(guildId), submitAppeal({ user, caseCode, answers }) }.
 * `limiter`: per member (user id) for POSTs. `appealInfo`: memberPortal's (same rules as the bot).
 */
export function createAppealHandlers({ readSession, ctx, send, fail, data, settings, limiter, appealInfo, loginPage }) {
    // Only a logged-in member with a Discord id; else the login page that comes back here.
    async function member(req, res, next) {
        const session = await readSession(req);
        if (session?.userId) return session;
        send(res, 200, loginPage(ctx(), { next }));
        return null;
    }

    /** This member's case by code, or null (unknown, somebody else's, /test: all the same). */
    async function ownCase(session, code) {
        if (!code) return null;
        const record = await data.getCase(code);
        if (!record || record.target_user_id !== session.userId || record.is_test) return null;
        return record;
    }

    async function itemFor(session, record) {
        const appeals = await data.listUserAppeals(session.userId, APPEAL_LIMIT);
        const last = lastBlockingByCase((appeals || []).filter((a) => a.case_code === record.case_code)).get(record.case_code) || null;
        return caseItem(record, { lastAppeal: last, guildName: data.guildName(record.guild_id), text: textOf(ctx()), appealInfo });
    }

    async function list(req, res) {
        const session = await member(req, res, APPEALS_PATH);
        if (!session) return undefined;
        let view;
        try {
            const [cases, appeals] = await Promise.all([
                data.listCases(session.userId, { limit: CASE_LIMIT }),
                data.listUserAppeals(session.userId, APPEAL_LIMIT),
            ]);
            view = buildAppealsView({ userId: session.userId, cases, appeals, guildName: data.guildName, text: textOf(ctx()), appealInfo });
        } catch (error) {
            logger.error(`Member portal: appeals of ${session.userId} could not be loaded: ${error.message}`);
            res.set('Retry-After', '60');
            return fail(res, 503, 'appealsUnavailable');
        }
        // ?sent=<code>: the flash after a submit, only for one of this member's own cases.
        let sent = null;
        const sentCode = normalizeCaseCode(typeof req.query?.sent === 'string' ? req.query.sent : '');
        if (sentCode) {
            const filed = view.appeals.find((a) => a.code === sentCode);
            if (filed) sent = { code: sentCode, server: filed.server };
        }
        return send(res, 200, appealsPage(ctx(), { session, view, sent }));
    }

    async function form(req, res) {
        const code = normalizeCaseCode(req.params?.code);
        const session = await member(req, res, code ? appealPath(code) : APPEALS_PATH);
        if (!session) return undefined;
        const record = await ownCase(session, code);
        if (!record) return fail(res, 404, 'caseNotFound');
        return send(res, 200, appealFormPage(ctx(), { session, item: await itemFor(session, record) }));
    }

    async function submit(req, res) {
        const session = await readSession(req);
        // From another site: refused as before, nothing echoed back.
        if (!isSameOrigin(req, settings.publicOrigin)) {
            return session?.userId ? fail(res, 403, 'appealNotAllowed') : fail(res, 401, 'notLoggedIn', { login: true });
        }
        const code = normalizeCaseCode(req.params?.code);
        // The login ran out (1 h) while the member was typing: their words come back with a login link.
        if (!session?.userId) {
            if (!code) return fail(res, 401, 'notLoggedIn', { login: true });
            return send(res, 401, appealExpiredPage(ctx(), { code, values: parseAppealForm(req.body).values }));
        }
        const record = await ownCase(session, code);
        if (!record) return fail(res, 404, 'caseNotFound');
        const item = await itemFor(session, record);
        const page = ctx();
        const text = textOf(page);
        // A stale page (e.g. logged in again in another tab: new CSRF token): nothing is sent; the
        // form comes back with the member's words and this session's token, to send again by hand.
        if (!safeEqual(String(req.body?.csrf || '').slice(0, 100), session.csrf)) {
            const stale = parseAppealForm(req.body, text).values;
            return send(res, 403, appealFormPage(page, { session, item, values: stale, error: text.t('portal.appealForm.errors.stale') }));
        }
        if (!item.appeal.appealable) return send(res, 409, appealFormPage(page, { session, item }));
        const parsed = parseAppealForm(req.body, text);
        if (!parsed.answers) return send(res, 400, appealFormPage(page, { session, item, values: parsed.values, error: parsed.error, field: parsed.field }));
        if (!limiter.allow(session.userId)) {
            res.set('Retry-After', '3600');
            return send(res, 429, appealFormPage(page, { session, item, values: parsed.values, error: text.t('portal.appealForm.errors.tooMany') }));
        }
        try {
            await data.submitAppeal({
                user: { id: session.userId, username: String(session.username || session.userId).slice(0, 100) },
                caseCode: record.case_code,
                answers: parsed.answers,
            });
        } catch (error) {
            // A rule of the normal flow said no (pending appeal, cooldown, ended…), e.g. a second
            // tab won the race: the member's own words stay in the form.
            if (error?.context?.expected) {
                return send(res, 409, appealFormPage(page, { session, item: await itemFor(session, record), values: parsed.values, error: text.t('portal.appealForm.errors.refused') }));
            }
            throw error;
        }
        logger.info(`Member portal: ${session.userId} appealed ${record.case_code} (guild ${record.guild_id}) on the website`);
        return res.redirect(303, `${APPEALS_PATH}?sent=${encodeURIComponent(record.case_code)}`);
    }

    return { list, form, submit };
}
