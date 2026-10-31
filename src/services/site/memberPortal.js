// memberPortal.js — "My record" on the website: any member logs in with Discord and sees
// their OWN moderation record in the main server. Read-only (appeals stay in Discord).
//
//   GET  /me           the record when logged in, else a page with "Log in with Discord"
//   GET  /me/login     starts Discord OAuth2 (scope identify only), state cookie + nonce
//   GET  /me/callback  Discord comes back here; state checked (signed, 10 min, single use,
//                      bound to this browser), then a fresh member session (rotation)
//   POST /me/logout    CSRF token + same-origin check, then back to /me
//
// Separate from the dashboard on every level, so a member login can never open the
// dashboard and a dashboard login never opens this page:
//   - own cookies (mewvo_me, mewvo_me_state) with Path=/me;
//   - own signing key: an HMAC of SESSION_SECRET with a fixed label, so a value signed for
//     the dashboard does not verify here (and the other way round), even under a renamed cookie;
//   - own session table (member_sessions, same shape as dashboard_sessions, hashed ids, 1 h).
//
// What is shown (only for the user id from the OAuth session, never from the URL):
// the counted warnings ("X of 3") and ladder level, the next-warning text of "My standing",
// active ban / mute with the end time, the cases (code, type, reason, by, date, status,
// whether and until when they can be appealed) and the appeals with their status. The
// moderator NAME is shown because the punishment DMs already show it ("By: …"). Never
// shown: moderator ids, revoke / void reasons, staff notes, evidence, appeal answers or the
// staff dossier, edit history. /test cases are left out (like "My appeals"); voided cases
// stay listed as voided (the member got a DM about it); imported warns are history only.
// A database error is a 503 page, never an empty "clean record".
//
// Off unless MEMBER_PORTAL_ENABLED=true; refuses (logged) without SESSION_SECRET (≥ 32),
// CLIENT_ID, DISCORD_CLIENT_SECRET, PUBLIC_URL and MAIN_GUILD_ID. Add
// <PUBLIC_URL>/me/callback under OAuth2 → Redirects in the Discord Developer Portal.

import express from 'express';
import { enforcementConfig } from '../../config/enforcement.js';
import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../../utils/logger.js';
import { html, formatDate } from '../dashboard/html.js';
import {
    MIN_SECRET_LENGTH, STATE_TTL_MS, clearCookie, createRateLimiter, createState, createStateStore, hmac,
    isSameOrigin, isSnowflake, parseCookies, safeEqual, serializeCookie, signValue, verifySignedValue,
} from '../dashboard/security.js';
import { createPgSessionStore } from '../dashboard/sessionStore.js';
import { query } from '../enforcement/db.js';
import { OPEN_STATUSES, caseStatusLabel, listCasesForUser, listUserAppeals } from '../enforcement/caseService.js';
import { getMemberStanding, nextWarningText } from '../enforcement/standingService.js';
import { NOINDEX, installUrl, inviteOrNull, layout, publicSiteEnabled, siteOrigin } from './site.js';
import { createBillingHandlers } from './billing.js';
import { premiumSettings, premiumStore } from '../billing/premiumService.js';
import { buildDataExport, exportFileName } from '../privacy/dataExport.js';
import { getFromDb } from '../../utils/database/wrapper.js';

export const MEMBER_BASE = '/me';
export const MEMBER_SESSION_COOKIE = 'mewvo_me';
export const MEMBER_STATE_COOKIE = 'mewvo_me_state';
// Where to go after login (a /me page, e.g. the checkout someone started logged out).
export const MEMBER_NEXT_COOKIE = 'mewvo_me_next';
export const MEMBER_SESSION_TTL_MS = 60 * 60 * 1000;
// The label that turns SESSION_SECRET into this page's own signing key.
const KEY_LABEL = 'mewvo member portal v1';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const ME_URL = 'https://discord.com/api/v10/users/@me';
const HTTP_TIMEOUT_MS = 10000;
const CASE_LIMIT = 200;
const APPEAL_LIMIT = 100;

export const MEMBER_LIMITS = {
    login: { limit: 30, windowMs: 60 * 1000 },
    page: { limit: 60, windowMs: 60 * 1000 },
    redeem: { limit: 10, windowMs: 60 * 1000 },
    // "Download my data": a heavier read across every table, so a few a minute is plenty.
    dataExport: { limit: 5, windowMs: 60 * 1000 },
};

/**
 * A return path after login: only this portal's own pages (/me…), no scheme, host, "//",
 * backslash or control characters; anything else → /me. Pure.
 */
export function safeNextPath(value) {
    const next = typeof value === 'string' ? value.trim() : '';
    if (next.length > 200 || !/^\/me(\/|\?|$)/.test(next)) return MEMBER_BASE;
    if (/[\\\s\u0000-\u001f]|\/\//.test(next)) return MEMBER_BASE;
    return next;
}

export const MEMBER_SECURITY_HEADERS = {
    // Like the site, plus form-action 'self' for the logout form.
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'none'; img-src 'self'; "
        + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // same-origin: a form POST then carries a real Origin header (no-referrer would send "null").
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': NOINDEX,
};

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || '').trim());

/** The member signing key: never equal to the dashboard's (which signs with SESSION_SECRET itself). */
export function memberSigningKey(sessionSecret) {
    return hmac(KEY_LABEL, sessionSecret);
}

/** The configuration from the environment: { requested, enabled, problems, … }. */
export function memberPortalSettings(env = process.env) {
    const requested = truthy(env.MEMBER_PORTAL_ENABLED);
    const publicUrl = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
    const sessionSecret = String(env.SESSION_SECRET || '');
    const settings = {
        requested,
        clientId: String(env.CLIENT_ID || '').trim(),
        clientSecret: String(env.DISCORD_CLIENT_SECRET || '').trim(),
        signingKey: sessionSecret.length >= MIN_SECRET_LENGTH ? memberSigningKey(sessionSecret) : '',
        redirectUri: publicUrl ? `${publicUrl}${MEMBER_BASE}/callback` : '',
        publicOrigin: null,
        secure: env.NODE_ENV === 'production' || publicUrl.startsWith('https://'),
        mainGuildId: env.MAIN_GUILD_ID !== undefined ? String(env.MAIN_GUILD_ID).trim() : enforcementConfig.mainGuildId,
        problems: [],
    };
    try {
        if (publicUrl) settings.publicOrigin = new URL(publicUrl).origin;
    } catch {
        settings.problems.push('PUBLIC_URL is not a valid URL');
    }
    if (requested) {
        if (sessionSecret.length < MIN_SECRET_LENGTH) settings.problems.push(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
        if (!settings.clientId) settings.problems.push('CLIENT_ID is not set');
        if (!settings.clientSecret) settings.problems.push('DISCORD_CLIENT_SECRET is not set');
        if (!publicUrl) settings.problems.push('PUBLIC_URL is not set');
        if (!isSnowflake(settings.mainGuildId || '')) settings.problems.push('MAIN_GUILD_ID is not set');
    }
    settings.enabled = requested && settings.problems.length === 0;
    return settings;
}

// ── The record: raw rows → a view with only member-safe fields ─────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const TYPE_LABEL = { ban: 'Ban', kick: 'Kick', mute: 'Mute', warn: 'Warning' };
const APPEAL_STATUS = {
    pending: 'Pending: the administrators have not decided yet',
    accepted: 'Accepted',
    denied: 'Denied',
    closed: 'Closed',
};

const time = (value) => (value ? new Date(value).getTime() : NaN);

/**
 * Whether this case can be appealed now, mirroring assertAppealable (appealService.js):
 * { appealable, until (Date|null), text, from (Date|null) }.
 */
export function appealInfo(record, lastAppeal, { now = Date.now(), config = enforcementConfig } = {}) {
    if (record.voided_at) return { appealable: false, text: 'Voided: nothing to appeal' };
    if (record.status === 'revoked') return { appealable: false, text: 'Already lifted' };
    if (record.unappealable) return { appealable: false, text: 'Cannot be appealed' };
    let until = null;
    if (record.type === 'ban' || record.type === 'mute') {
        const inEffect = OPEN_STATUSES.includes(record.status) && (!record.expires_at || time(record.expires_at) > now);
        if (!inEffect) return { appealable: false, text: 'Ended: nothing to appeal' };
        if (record.appeal_deadline && time(record.appeal_deadline) <= now) return { appealable: false, text: 'The appeal window has closed' };
        until = record.appeal_deadline || record.expires_at || null;
    } else {
        const end = time(record.created_at) + config.appealWindowMs;
        if (!(end > now)) return { appealable: false, text: `The appeal window (${Math.round(config.appealWindowMs / DAY_MS)} days) has closed` };
        until = new Date(end);
    }
    if (lastAppeal?.status === 'pending') return { appealable: false, text: 'Appeal pending' };
    if (lastAppeal?.status === 'denied' && lastAppeal.decided_at) {
        const retry = time(lastAppeal.decided_at) + config.appealCooldownMs;
        if (retry > now) return { appealable: false, text: 'Appeal denied; you can appeal again from', from: new Date(retry) };
    }
    return { appealable: true, until: until ? new Date(until) : null, text: 'Can be appealed' };
}

/** A member-facing status: caseStatusLabel, with plainer words for warnings and kicks. */
function memberStatus(record, countedCodes, appealStatus) {
    if (record.is_imported) return 'history only (imported, does not count)';
    const label = caseStatusLabel(record, appealStatus);
    if (label === 'voided') return 'voided: no longer counts';
    if (record.status === 'active' && record.type === 'warn') {
        return countedCodes.has(record.case_code) ? 'counts now' : 'on record, no longer counts';
    }
    if (record.status === 'active' && record.type === 'kick') return 'on record';
    return label;
}

/**
 * The page's view model from the service results. Only these fields reach the page, so no
 * internal column can leak by accident. Pure, for tests.
 */
export function buildRecordView({ standing, cases, appeals, now = Date.now(), config = enforcementConfig }) {
    const rows = (cases || []).filter((row) => !row.is_test);
    const codes = new Set(rows.map((row) => row.case_code));
    const ownAppeals = (appeals || []).filter((appeal) => codes.has(appeal.case_code));
    // Per case: the latest pending or denied appeal (what assertAppealable looks at), and the latest of any kind.
    const lastBlocking = new Map();
    const latest = new Map();
    for (const appeal of ownAppeals) { // newest first
        if (!latest.has(appeal.case_code)) latest.set(appeal.case_code, appeal.status);
        if ((appeal.status === 'pending' || appeal.status === 'denied') && !lastBlocking.has(appeal.case_code)) lastBlocking.set(appeal.case_code, appeal);
    }
    const counted = new Set((standing.warns || []).map((warn) => warn.case_code));
    const ladder = standing.ladder || { level: 0, warns_since_level: 0 };
    const threshold = ladder.level === 0 ? config.warnsPerLevel : 1;
    const active = (record) => (record ? { code: record.case_code, endsAt: record.expires_at || null } : null);
    return {
        warnings: { count: Number(ladder.warns_since_level) || 0, threshold },
        ladder: { level: Number(ladder.level) || 0, next: nextWarningText(ladder) },
        activeBan: active(standing.activeBan),
        activeMute: active(standing.activeMute),
        cases: rows.map((row) => ({
            code: row.case_code,
            type: TYPE_LABEL[row.type] || row.type,
            reason: row.reason,
            by: row.moderator_username,
            createdAt: row.created_at,
            endsAt: row.type === 'ban' || row.type === 'mute' ? row.expires_at || null : null,
            permanent: row.type === 'ban' && !row.expires_at,
            status: memberStatus(row, counted, latest.get(row.case_code)),
            appeal: appealInfo(row, lastBlocking.get(row.case_code), { now, config }),
        })),
        appeals: ownAppeals.map((appeal) => ({
            code: appeal.case_code,
            type: TYPE_LABEL[appeal.type] || appeal.type,
            status: APPEAL_STATUS[appeal.status] || appeal.status,
            filedAt: appeal.created_at,
            decidedAt: appeal.decided_at || null,
        })),
        truncated: rows.length >= CASE_LIMIT,
    };
}

// ── Pages ─────────────────────────────────────────────────────────────────

function when(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? html`<time datetime="${date.toISOString()}">${formatDate(date)}</time>` : '—';
}

function appealCell(appeal) {
    if (appeal.appealable) return appeal.until ? html`Until ${when(appeal.until)}` : 'Yes';
    return appeal.from ? html`${appeal.text} ${when(appeal.from)}` : appeal.text;
}

function appealHint(ctx) {
    return ctx.supportInvite
        ? html`<p class="note">Appeal from the appeal panel in Discord: <a href="${ctx.supportInvite}" rel="noopener">join the support server</a> and press <strong>Appeal</strong> with the case code. Nothing can be appealed from this page.</p>`
        : html`<p class="note">Appeal from the appeal panel in Discord with the case code. Nothing can be appealed from this page.</p>`;
}

export function loginPage(ctx) {
    return layout(ctx, {
        title: 'My record', active: 'me',
        body: html`<div class="wrap page prose"><h1>My record</h1>
<p class="lead">See your own moderation record in ${enforcementConfig.serverName}: your warnings, warning-ladder level, any active ban or mute, your cases and your appeals.</p>
<p><a class="button" href="${MEMBER_BASE}/login">Log in with Discord</a></p>
<p class="note">Mewvo asks Discord only who you are (the identify permission): no email, no servers, nothing else. You only ever see your own record. The login lasts one hour.</p></div>`,
    });
}

export function recordPage(ctx, { session, view }) {
    const warn = view.warnings;
    const activeRows = [
        view.activeBan ? html`<li>Ban <code>${view.activeBan.code}</code>: ${view.activeBan.endsAt ? html`ends ${when(view.activeBan.endsAt)}` : 'permanent'}</li>` : '',
        view.activeMute ? html`<li>Mute <code>${view.activeMute.code}</code>: ends ${when(view.activeMute.endsAt)}</li>` : '',
    ].filter(Boolean);
    return layout(ctx, {
        title: 'My record', active: 'me',
        body: html`<div class="wrap page record"><div class="record-head"><div><h1>My record</h1>
<p class="lead">Your moderation record in ${enforcementConfig.serverName}, logged in as <strong>${session.username}</strong>. Only you can see this.</p></div>
<div class="record-links"><a class="button button-quiet" href="${MEMBER_BASE}/data" download>Download my data</a> ${ctx.billing ? html`<a class="button button-quiet" href="${MEMBER_BASE}/billing">Subscription</a> ` : ''}<form method="post" action="${MEMBER_BASE}/logout"><input type="hidden" name="csrf" value="${session.csrf}"><button class="button button-quiet" type="submit">Log out</button></form></div></div>
<ul class="record-summary">
<li class="feature"><h2>Warnings</h2><p class="record-big">${warn.count} of ${warn.threshold}</p><p>Counted warnings at your level. Warnings do not expire.</p></li>
<li class="feature"><h2>Warning ladder</h2><p class="record-big">Level ${view.ladder.level} of 3</p><p>${view.ladder.next}</p></li>
<li class="feature"><h2>Active now</h2>${activeRows.length ? html`<ul class="record-active">${activeRows}</ul>` : html`<p>No active ban or mute.</p>`}</li>
</ul>
<h2 id="cases-title">Cases</h2>
${view.cases.length ? html`<div class="table-wrap" role="region" aria-labelledby="cases-title" tabindex="0"><table class="record-table"><thead><tr><th scope="col">Case</th><th scope="col">Type</th><th scope="col">Reason</th><th scope="col">By</th><th scope="col">Date</th><th scope="col">Ends</th><th scope="col">Status</th><th scope="col">Appeal</th></tr></thead>
<tbody>${view.cases.map((c) => html`<tr><td><code>${c.code}</code></td><td>${c.type}</td><td>${c.reason}</td><td>${c.by}</td><td>${when(c.createdAt)}</td><td>${c.permanent ? 'permanent' : when(c.endsAt)}</td><td>${c.status}</td><td>${appealCell(c.appeal)}</td></tr>`)}</tbody></table></div>
${view.truncated ? html`<p class="note">Showing your newest ${view.cases.length} cases.</p>` : ''}`
        : html`<p>You have no cases in ${enforcementConfig.serverName}.</p>`}
<h2 id="appeals-title">Appeals</h2>
${view.appeals.length ? html`<div class="table-wrap" role="region" aria-labelledby="appeals-title" tabindex="0"><table class="record-table"><thead><tr><th scope="col">Case</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Filed</th><th scope="col">Decided</th></tr></thead>
<tbody>${view.appeals.map((a) => html`<tr><td><code>${a.code}</code></td><td>${a.type}</td><td>${a.status}</td><td>${when(a.filedAt)}</td><td>${when(a.decidedAt)}</td></tr>`)}</tbody></table></div>`
        : html`<p>You have not filed any appeals.</p>`}
${appealHint(ctx)}</div>`,
    });
}

function messagePage(ctx, title, message, { login = false } = {}) {
    return layout(ctx, {
        title, active: 'me',
        body: html`<div class="wrap page prose"><h1>${title}</h1><p class="lead">${message}</p>
<p><a class="button" href="${login ? `${MEMBER_BASE}/login` : MEMBER_BASE}">${login ? 'Log in again' : 'Back to My record'}</a></p></div>`,
    });
}

// ── Handlers ──────────────────────────────────────────────────────────────

const defaultData = {
    getMemberStanding, listCasesForUser, listUserAppeals,
    exportData: (userId) => buildDataExport(userId, { query, readKey: (key) => getFromDb(key, null) }),
};

async function discordFetch(fetchImpl, url, options) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Discord answered ${response.status}`);
    return body;
}

const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || 'unknown');

/**
 * The handlers, everything injectable for tests:
 * { settings, sessions, data, fetchImpl, states, limits, context }.
 * `context()` returns the site shell values (invites, dashboard link…).
 */
export function createMemberPortal({
    settings, sessions, data = defaultData, fetchImpl = globalThis.fetch, states = createStateStore(),
    limits = MEMBER_LIMITS, context = () => ({}), premium = null,
}) {
    const key = settings.signingKey;
    // Its own key for the return-path cookie, so it can never stand in for a session cookie.
    const nextKey = hmac('mewvo member next v1', key);
    const guildId = settings.mainGuildId;
    const cookieOptions = { secure: settings.secure, path: MEMBER_BASE };
    const loginLimiter = createRateLimiter(limits.login);
    const pageLimiter = createRateLimiter(limits.page);
    const redeemLimiter = createRateLimiter(limits.redeem || MEMBER_LIMITS.redeem);
    const exportLimiter = createRateLimiter(limits.dataExport || MEMBER_LIMITS.dataExport);
    const ctx = () => ({ ...context(), memberPortal: true, billing: Boolean(premium) });
    const send = (res, status, page) => res.status(status).type('html').send(page);
    const fail = (res, status, title, message, options) => send(res, status, messagePage(ctx(), title, message, options));

    function headers(req, res, next) {
        res.set(MEMBER_SECURITY_HEADERS);
        if (settings.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
        next();
    }

    function limitBy(limiter) {
        return (req, res, next) => {
            if (limiter.allow(clientIp(req))) return next();
            res.set('Retry-After', '60');
            return fail(res, 429, 'Slow down', 'Too many requests from your address. Wait a minute and try again.');
        };
    }

    function cookieSessionId(req) {
        return verifySignedValue(parseCookies(req.headers?.cookie)[MEMBER_SESSION_COOKIE], key);
    }

    async function readSession(req) {
        const id = cookieSessionId(req);
        return id ? sessions.get(id) : null;
    }

    function login(req, res) {
        const { state, nonce } = createState(key);
        res.append('Set-Cookie', serializeCookie(MEMBER_STATE_COOKIE, nonce, { ...cookieOptions, maxAgeMs: STATE_TTL_MS }));
        const next = safeNextPath(req.query?.next);
        if (next !== MEMBER_BASE) res.append('Set-Cookie', serializeCookie(MEMBER_NEXT_COOKIE, signValue(next, nextKey), { ...cookieOptions, maxAgeMs: STATE_TTL_MS }));
        else res.append('Set-Cookie', clearCookie(MEMBER_NEXT_COOKIE, cookieOptions));
        const params = new URLSearchParams({
            client_id: settings.clientId, response_type: 'code', redirect_uri: settings.redirectUri, scope: 'identify', state,
        });
        return res.redirect(302, `${AUTHORIZE_URL}?${params}`);
    }

    async function callback(req, res) {
        const cookies = parseCookies(req.headers?.cookie);
        res.append('Set-Cookie', clearCookie(MEMBER_STATE_COOKIE, cookieOptions));
        if (req.query?.error) return fail(res, 400, 'Login cancelled', 'You did not authorize the login.', { login: true });
        const code = str(req.query?.code, 200);
        if (!code || !states.consume(str(req.query?.state, 1000), cookies[MEMBER_STATE_COOKIE], key)) {
            return fail(res, 400, 'Login expired', 'This login link is invalid, expired or already used.', { login: true });
        }
        let me;
        try {
            const token = await discordFetch(fetchImpl, TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: settings.clientId, client_secret: settings.clientSecret, grant_type: 'authorization_code',
                    code, redirect_uri: settings.redirectUri,
                }),
            });
            // The access token is used once, to read who logged in, and then dropped.
            me = await discordFetch(fetchImpl, ME_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
        } catch (error) {
            logger.warn(`Member portal login failed: ${error.message}`);
            return fail(res, 502, 'Login failed', 'Discord did not confirm the login. Try again.', { login: true });
        }
        if (!isSnowflake(String(me?.id || ''))) return fail(res, 502, 'Login failed', 'Discord did not return a user.', { login: true });
        // Rotation: whatever member session this browser had is dropped; a fresh id is issued.
        const session = await sessions.rotate(cookieSessionId(req), {
            userId: me.id, username: me.global_name || me.username || me.id, avatar: null,
        });
        res.append('Set-Cookie', serializeCookie(MEMBER_SESSION_COOKIE, signValue(session.id, key), { ...cookieOptions, maxAgeMs: MEMBER_SESSION_TTL_MS }));
        logger.info(`Member portal login: ${me.id}`);
        res.append('Set-Cookie', clearCookie(MEMBER_NEXT_COOKIE, cookieOptions));
        return res.redirect(303, safeNextPath(verifySignedValue(cookies[MEMBER_NEXT_COOKIE], nextKey) || MEMBER_BASE));
    }

    async function index(req, res) {
        const session = await readSession(req);
        if (!session) return send(res, 200, loginPage(ctx()));
        let view;
        try {
            // The user id comes from the session only; nothing in the URL is read.
            const [standing, cases, appeals] = await Promise.all([
                data.getMemberStanding(guildId, session.userId),
                data.listCasesForUser(guildId, session.userId, { limit: CASE_LIMIT }),
                data.listUserAppeals(session.userId, APPEAL_LIMIT),
            ]);
            view = buildRecordView({ standing, cases: cases?.rows || [], appeals });
        } catch (error) {
            logger.error(`Member portal: record of ${session.userId} could not be loaded: ${error.message}`);
            res.set('Retry-After', '60');
            return fail(res, 503, 'Record unavailable', 'Your record could not be loaded because the database is not responding. This does not mean your record is clean: try again in a few minutes.');
        }
        return send(res, 200, recordPage(ctx(), { session, view }));
    }

    /** GET /me/data: the member's own data as a JSON download (id from the session only). */
    async function dataExport(req, res) {
        const session = await readSession(req);
        if (!session) return fail(res, 401, 'Log in first', 'Log in with Discord to download your data.', { login: true });
        let file;
        try {
            file = await data.exportData(session.userId);
        } catch (error) {
            logger.error(`Member portal: data export of ${session.userId} failed: ${error.message}`);
            res.set('Retry-After', '60');
            return fail(res, 503, 'Download unavailable', 'Your data could not be collected because the database is not responding. Try again in a few minutes.');
        }
        logger.info(`Member portal: ${session.userId} downloaded their data`);
        res.set('Cache-Control', 'no-store');
        res.set('Content-Disposition', `attachment; filename="${exportFileName(session.userId)}"`);
        return res.status(200).type('application/json').send(`${JSON.stringify(file, null, 2)}\n`);
    }

    async function logout(req, res) {
        const session = await readSession(req);
        if (!session) return fail(res, 401, 'Logged out', 'You are not logged in.', { login: true });
        if (!isSameOrigin(req, settings.publicOrigin) || !safeEqual(str(req.body?.csrf, 100), session.csrf)) {
            return fail(res, 403, 'Not allowed', 'The logout request did not come from this page.');
        }
        await sessions.destroy(session.id);
        res.append('Set-Cookie', clearCookie(MEMBER_SESSION_COOKIE, cookieOptions));
        return res.redirect(303, MEMBER_BASE);
    }

    function notFound(req, res) {
        return fail(res, 404, 'Not found', 'There is no such page.');
    }

    // Subscriptions (billing.js): only with a premium store (PREMIUM_TEST_CHECKOUT=true).
    const billing = premium ? createBillingHandlers({
        readSession, sessions, settings, ctx, send, store: premium, redeemLimiter, clientIp,
    }) : null;

    /** A thrown error (database down while reading the session…) → 503, never a stack trace. */
    function safe(handler) {
        return async (req, res, next) => {
            try {
                return await handler(req, res, next);
            } catch (error) {
                logger.error(`Member portal ${req.method} ${req.path} failed: ${error.message}`);
                if (res.headersSent) return undefined;
                res.set('Retry-After', '60');
                return fail(res, 503, 'Try again later', 'This page could not be loaded because the database is not responding. Nothing was changed.');
            }
        };
    }

    function router() {
        const r = express.Router();
        r.use(headers);
        r.get('/', limitBy(pageLimiter), safe(index));
        r.get('/login', limitBy(loginLimiter), login);
        r.get('/callback', limitBy(loginLimiter), safe(callback));
        r.get('/data', limitBy(exportLimiter), safe(dataExport));
        r.post('/logout', limitBy(pageLimiter), express.urlencoded({ extended: false, limit: '2kb' }), safe(logout));
        if (billing) {
            const form = express.urlencoded({ extended: false, limit: '2kb' });
            r.get('/billing', limitBy(pageLimiter), safe(billing.billing));
            r.get('/billing/orders/:id', limitBy(pageLimiter), safe(billing.receipt));
            r.get('/checkout', limitBy(pageLimiter), safe(billing.checkout));
            r.post('/checkout', limitBy(pageLimiter), form, safe(billing.checkoutPost));
            r.get('/redeem', limitBy(pageLimiter), safe(billing.redeemForm));
            r.post('/redeem', limitBy(pageLimiter), form, safe(billing.redeemPost));
        }
        r.use(notFound);
        return r;
    }

    return { headers, login, callback, index, dataExport, logout, notFound, router, sessions, states, billing };
}

/**
 * Mounts /me when MEMBER_PORTAL_ENABLED=true and the configuration is complete.
 * Returns true when mounted (the site then shows the "My record" link).
 */
export function registerMemberPortal(app, { env = process.env, dashboardEnabled = false, supportInvite = () => null, sessions = null, data, fetchImpl, limits, premium } = {}) {
    const settings = memberPortalSettings(env);
    if (!settings.requested) return false;
    if (!settings.enabled) {
        logger.error(`Member portal (/me) NOT enabled: ${settings.problems.join('; ')}`);
        return false;
    }
    const base = {
        publicSite: publicSiteEnabled(env),
        dashboardEnabled: Boolean(dashboardEnabled),
        installUrl: installUrl(env.CLIENT_ID),
        mainInvite: inviteOrNull(env.MAIN_SERVER_INVITE),
        origin: siteOrigin(env),
    };
    const context = () => {
        let support = null;
        try { support = inviteOrNull(supportInvite()); } catch { support = null; }
        return { ...base, supportInvite: support };
    };
    const portal = createMemberPortal({
        settings,
        sessions: sessions || createPgSessionStore({ query, table: pgConfig.tables.member_sessions, ttlMs: MEMBER_SESSION_TTL_MS }),
        context,
        ...(data ? { data } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(limits ? { limits } : {}),
        // Test checkout: only when PREMIUM_TEST_CHECKOUT=true (premiumService.js).
        premium: premiumSettings(env).testCheckout ? (premium || premiumStore) : null,
    });
    app.use(MEMBER_BASE, portal.router());
    logger.info(`Member portal enabled at ${MEMBER_BASE} (OAuth redirect ${settings.redirectUri})${portal.billing ? '; subscriptions in TEST CHECKOUT mode (no payments)' : ''}`);
    return true;
}
