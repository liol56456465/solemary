// memberPortal.js — "My record" on the website: any member logs in with Discord and sees
// their OWN moderation record in every server, grouped by server (Mewvo's two home servers are
// one group; each group has that server's standing). Appeals for every server: portalAppeals.js
// (/me/appeals, /me/appeal/:code; on when the bot client is passed to registerMemberPortal).
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
//
// Mewvo accounts (accountRoutes.js): on with the portal unless MEMBER_ACCOUNTS_ENABLED=false.
// Username + password login on this website, no email. An account session carries accountId
// and, once Discord is linked, the linked Discord id as userId, so every page below works the
// same. Linking is required: until then every page except the link step (/me/link), the
// callback, logout and delete account redirects to /me/link (forceLink). The Discord link and
// "Forgot password?" reuse /me/callback, with a link or forgot cookie bound to the state nonce.

import express from 'express';
import { enforcementConfig } from '../../config/enforcement.js';
import { homeSettingsGuild, resolveSetting } from '../settings/guildSettings.js';
import { pgConfig } from '../../config/database/postgres.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../../utils/logger.js';
import { html } from '../dashboard/html.js';
import { portalTime } from './shell.js';
import {
    MIN_SECRET_LENGTH, STATE_TTL_MS, clearCookie, createRateLimiter, createState, createStateStore, hmac,
    isSameOrigin, isSnowflake, parseCookies, safeEqual, serializeCookie, signValue, verifySignedValue,
} from '../dashboard/security.js';
import { createPgSessionStore } from '../dashboard/sessionStore.js';
import { query } from '../enforcement/db.js';
import { OPEN_STATUSES, caseStatusCode, caseStatusLabel, listUserAppeals } from '../enforcement/caseService.js';
import { getMemberStanding, nextWarningSteps } from '../enforcement/standingService.js';
import { NOINDEX, inviteOrNull, layout, legalContact, publicSiteEnabled, siteInstallUrl, siteOrigin } from './site.js';
import { createBillingHandlers } from './billing.js';
import { premiumSettings, premiumStore } from '../billing/premiumService.js';
import { ACCOUNT_EXPORT_NOTE, EXPORT_FORMAT, buildDataExport, exportFileName } from '../privacy/dataExport.js';
import { getFromDb } from '../../utils/database/wrapper.js';
import { createAccountHandlers, memberAccountSettings } from './accountRoutes.js';
import { DEFAULT_LANG, LANG_CODES, hasKey, textOf, translator } from './i18n.js';
import { languageCookie, requestLanguage } from './language.js';
import { accountStore as defaultAccountStore } from '../accounts/accountStore.js';
import { APPEALS_PATH, APPEAL_SUBMIT_LIMIT, appealPath, createAppealHandlers, serverLabel } from './portalAppeals.js';
import { getCaseByCodeAnyServer, listCasesForUserAllServers } from '../enforcement/caseService.js';
import { submitAppeal as submitAppealService } from '../enforcement/appealService.js';

export const MEMBER_BASE = '/me';
export const MEMBER_SESSION_COOKIE = 'mewvo_me';
export const MEMBER_STATE_COOKIE = 'mewvo_me_state';
// Where to go after login (a /me page, e.g. the checkout someone started logged out).
export const MEMBER_NEXT_COOKIE = 'mewvo_me_next';
// "This Discord login links the logged-in Mewvo account" (bound to the state nonce).
export const MEMBER_LINK_COOKIE = 'mewvo_me_link';
// "This Discord login is for Forgot password?" (bound to the state nonce).
export const MEMBER_FORGOT_COOKIE = 'mewvo_me_forgot';
// What an account without Discord may still open (everything else redirects to /me/link).
const LINK_STEP_OPEN = new Set(['GET /link', 'POST /link', 'GET /callback', 'POST /logout', 'POST /account/delete']);
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
    // Web appeals, per member (user id): portalAppeals.js.
    appealSubmit: APPEAL_SUBMIT_LIMIT,
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
    // Like the site, plus form-action for our own forms and https://discord.com: "Link Discord" and
    // "Forgot password?" are POST forms answered with a redirect to Discord's OAuth page, and Chrome
    // applies form-action to that redirect too (without it the button silently does nothing).
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; "
        + "form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'",
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
        publicUrl,
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
// Labels shown to the member: keys portal.caseType.<type> and portal.appealStatus.<status>
// (an unknown value is shown as it is).
const CASE_TYPES = new Set(['ban', 'kick', 'mute', 'warn']);
const APPEAL_STATUSES = new Set(['pending', 'accepted', 'denied', 'closed']);
const typeLabel = (t, type) => (CASE_TYPES.has(type) ? t(`portal.caseType.${type}`) : type);
const appealStatusLabel = (t, status) => (APPEAL_STATUSES.has(status) ? t(`portal.appealStatus.${status}`) : status);

const time = (value) => (value ? new Date(value).getTime() : NaN);

/**
 * Whether this case can be appealed now, mirroring assertAppealable (appealService.js):
 * { appealable, until (Date|null), text, from (Date|null) }.
 */
/** True when Mewvo accounts are on and complete (the site then shows "Sign up"). */
export function memberAccountsOn(env = process.env) {
    return memberAccountSettings(env, memberPortalSettings(env)).enabled;
}

/**
 * The appeal settings of the server a case belongs to (multi-server B0b): its appeal window and
 * cooldown via resolveSetting, with the bot's mapping (appealService.appealSettingsGuild): a
 * home case (main or support server) reads the main server's values, another server its own.
 */
export function appealConfigFor(guildId) {
    const settingsGuild = homeSettingsGuild(guildId);
    return {
        appealWindowMs: resolveSetting(settingsGuild, 'appealWindowMs'),
        appealCooldownMs: resolveSetting(settingsGuild, 'appealCooldownMs'),
    };
}

export function appealInfo(record, lastAppeal, { now = Date.now(), config, text = translator() } = {}) {
    const { t } = text;
    config = config || appealConfigFor(record.guild_id);
    if (record.voided_at) return { appealable: false, text: t('portal.appeal.voided') };
    if (record.status === 'revoked') return { appealable: false, text: t('portal.appeal.lifted') };
    if (record.unappealable) return { appealable: false, text: t('portal.appeal.unappealable') };
    let until = null;
    if (record.type === 'ban' || record.type === 'mute') {
        const inEffect = OPEN_STATUSES.includes(record.status) && (!record.expires_at || time(record.expires_at) > now);
        if (!inEffect) return { appealable: false, text: t('portal.appeal.ended') };
        if (record.appeal_deadline && time(record.appeal_deadline) <= now) return { appealable: false, text: t('portal.appeal.deadlinePassed') };
        until = record.appeal_deadline || record.expires_at || null;
    } else {
        const end = time(record.created_at) + config.appealWindowMs;
        if (!(end > now)) return { appealable: false, text: text.tp('portal.appeal.windowClosed', Math.round(config.appealWindowMs / DAY_MS)) };
        until = new Date(end);
    }
    if (lastAppeal?.status === 'pending') return { appealable: false, text: t('portal.appeal.pending') };
    if (lastAppeal?.status === 'denied' && lastAppeal.decided_at) {
        const retry = time(lastAppeal.decided_at) + config.appealCooldownMs;
        if (retry > now) return { appealable: false, text: t('portal.appeal.deniedRetry'), from: new Date(retry) };
    }
    return { appealable: true, until: until ? new Date(until) : null, text: t('portal.appeal.appealable') };
}

/** A member-facing status: caseStatusCode in the page's language, with plainer words for warnings and kicks. */
function memberStatus(t, record, countedCodes, appealStatus) {
    if (record.is_imported) return t('portal.status.imported');
    const code = caseStatusCode(record, appealStatus);
    if (code === 'voided') return t('portal.status.voided');
    if (record.status === 'active' && record.type === 'warn') {
        return t(countedCodes.has(record.case_code) ? 'portal.status.counts' : 'portal.status.noLongerCounts');
    }
    if (record.status === 'active' && record.type === 'kick') return t('portal.status.onRecord');
    // portal.status.case.<code>; an unknown status keeps caseStatusLabel's English words.
    return /^[a-zA-Z]+$/.test(code) && hasKey('en', `portal.status.case.${code}`) ? t(`portal.status.case.${code}`) : caseStatusLabel(record, appealStatus);
}

const DURATION_UNITS = [['month', 30 * DAY_MS], ['day', DAY_MS], ['hour', 60 * 60 * 1000], ['minute', 60 * 1000]];

/** A ban length like enforcement/format.js formatDuration ("7 days", "1 month"), in the page's language; null = permanent. */
export function banLengthText(ms, { t, tp }) {
    if (ms == null) return t('portal.next.permanent');
    const parts = [];
    let rest = ms;
    for (const [unit, size] of DURATION_UNITS) {
        const count = Math.floor(rest / size);
        if (count > 0) {
            parts.push(tp(`portal.duration.${unit}`, count));
            rest -= count * size;
        }
    }
    return parts.slice(0, 2).join(' ') || t('portal.duration.lessThanMinute');
}

/** What the next warning would do (standingService nextWarningSteps), in the page's language. */
export function nextWarningWords(ladder, text = translator()) {
    const { t, tp } = text;
    const step = nextWarningSteps(ladder);
    const ban = banLengthText(step.banMs, text);
    if (step.escalates) return t('portal.next.limit', { ban, level: step.nextLevel });
    const first = t('portal.next.warning', { number: step.warnNumber, threshold: step.threshold });
    const after = step.left === 1 ? t('portal.next.afterOne', { ban }) : tp('portal.next.afterMore', step.left, { ban });
    return `${first} ${after}`;
}

/**
 * The page's view model from the service results. Only these fields reach the page, so no
 * internal column can leak by accident. Pure, for tests.
 */
export function buildRecordView({ standing, cases, appeals, now = Date.now(), config, text = translator() }) {
    // `config` (tests) overrides every case; without it each case uses its own server's appeal settings.
    const { t } = text;
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
    const threshold = ladder.level === 0 ? (config?.warnsPerLevel ?? enforcementConfig.warnsPerLevel) : 1;
    const active = (record) => (record ? { code: record.case_code, endsAt: record.expires_at || null } : null);
    return {
        warnings: { count: Number(ladder.warns_since_level) || 0, threshold },
        ladder: { level: Number(ladder.level) || 0, next: nextWarningWords(ladder, text) },
        activeBan: active(standing.activeBan),
        activeMute: active(standing.activeMute),
        cases: rows.map((row) => ({
            code: row.case_code,
            type: typeLabel(t, row.type),
            reason: row.reason,
            by: row.moderator_username,
            createdAt: row.created_at,
            endsAt: row.type === 'ban' || row.type === 'mute' ? row.expires_at || null : null,
            permanent: row.type === 'ban' && !row.expires_at,
            status: memberStatus(t, row, counted, latest.get(row.case_code)),
            appeal: appealInfo(row, lastBlocking.get(row.case_code), { now, config, text }),
        })),
        appeals: ownAppeals.map((appeal) => ({
            code: appeal.case_code,
            type: typeLabel(t, appeal.type),
            status: appealStatusLabel(t, appeal.status),
            filedAt: appeal.created_at,
            decidedAt: appeal.decided_at || null,
        })),
        truncated: rows.length >= CASE_LIMIT,
    };
}

// Standing (warnings, ladder, active ban/mute) is read for at most this many servers per page view;
// further servers list their cases only.
export const MAX_STANDING_SERVERS = 20;

/** The server a case is grouped under: Mewvo's two home servers are one group (the main server's id). */
export const recordGroupKey = (guildId) => homeSettingsGuild(guildId);

/**
 * "My record" across servers: the member's cases (every server, test cases dropped) grouped by
 * server, newest first; each group has the buildRecordView view of its own cases with that server's
 * standing (summary false for groups without one: cases only). `standings`: Map key -> standing.
 * The appeals list is one table for every server, with the server name. Pure, for tests.
 */
export function buildRecordGroups({ cases, appeals, standings = new Map(), guildName = () => null, now = Date.now(), config, text = translator() }) {
    const rows = (cases || []).filter((row) => !row.is_test);
    const byKey = new Map();
    for (const row of rows) {
        const key = recordGroupKey(row.guild_id);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(row);
    }
    const empty = { ladder: { level: 0, warns_since_level: 0 }, warns: [], activeBan: null, activeMute: null };
    const groups = [...byKey.entries()].map(([key, groupRows]) => {
        const standing = standings.get(key) || null;
        const view = buildRecordView({ standing: standing || empty, cases: groupRows, appeals, now, config, text });
        return { guildId: key, server: serverLabel(key, guildName(key), text), summary: Boolean(standing), view };
    });
    const allAppeals = groups.flatMap((g) => g.view.appeals.map((a) => ({ ...a, server: g.server })))
        .sort((a, b) => new Date(b.filedAt).getTime() - new Date(a.filedAt).getTime());
    return { groups, appeals: allAppeals, truncated: rows.length >= CASE_LIMIT, caseCount: rows.length };
}

// ── Pages ─────────────────────────────────────────────────────────────────

/** A date in the page's language (shell.js portalTime). */
const when = (ctx, value) => portalTime(ctx, value);

function appealCell(page, appeal, code = null) {
    const { t, ti } = page;
    if (appeal.appealable) {
        const text = appeal.until ? ti('portal.appeal.until', { date: when(page, appeal.until) }) : t('portal.appeal.yes');
        // Web appeals on: the cell links to the form (portalAppeals.js).
        return code ? html`${text} <a href="${appealPath(code)}">${t('portal.appeals.appealButton')}</a>` : text;
    }
    return appeal.from ? html`${appeal.text} ${when(page, appeal.from)}` : appeal.text;
}

function appealHint({ ti }, ctx) {
    if (ctx.webAppeals) return html`<p class="note">${ti('portal.record.appealHintWeb', { href: APPEALS_PATH })}</p>`;
    return ctx.supportInvite
        ? html`<p class="note">${ti('portal.record.appealHintInvite', { invite: ctx.supportInvite })}</p>`
        : html`<p class="note">${ti('portal.record.appealHint')}</p>`;
}

/** `next`: a /me page to return to after the Discord login (the appeal form from a DM link). */
export function loginPage(ctx, { next = null } = {}) {
    const { t, ti } = textOf(ctx);
    const back = next ? safeNextPath(next) : MEMBER_BASE;
    const discordLogin = back !== MEMBER_BASE ? `${MEMBER_BASE}/login?next=${encodeURIComponent(back)}` : `${MEMBER_BASE}/login`;
    return layout(ctx, {
        title: t('portal.record.title'), active: 'me',
        body: html`<div class="wrap page prose"><h1>${t('portal.record.title')}</h1>
<p class="lead">${back.startsWith(APPEALS_PATH) || back.startsWith('/me/appeal/') ? t('portal.login.appealLead') : t('portal.login.lead', { server: enforcementConfig.serverName })}</p>
<p><a class="button" href="${discordLogin}">${t('portal.login.withDiscord')}</a>${ctx.accounts ? html` <a class="button button-quiet" href="${MEMBER_BASE}/login-password">${t('portal.login.withAccount')}</a>` : ''}</p>
<p class="note">${t('portal.login.note')}</p>
${ctx.accounts ? html`<p class="note">${ti('portal.login.signup', { href: `${MEMBER_BASE}/signup` })}</p>` : ''}</div>`,
    });
}

/** One server's summary cards: counted warnings, ladder level, active ban / mute. */
function summaryCards(ctx, view) {
    const { t, ti } = textOf(ctx);
    const warn = view.warnings;
    const code = (value) => html`<code>${value}</code>`;
    const activeRows = [
        view.activeBan ? html`<li>${view.activeBan.endsAt
            ? ti('portal.record.activeBanEnds', { code: code(view.activeBan.code), date: when(ctx, view.activeBan.endsAt) })
            : ti('portal.record.activeBanPermanent', { code: code(view.activeBan.code) })}</li>` : '',
        view.activeMute ? html`<li>${ti('portal.record.activeMuteEnds', { code: code(view.activeMute.code), date: when(ctx, view.activeMute.endsAt) })}</li>` : '',
    ].filter(Boolean);
    return html`<ul class="record-summary">
<li class="feature"><h3>${t('portal.record.warnings')}</h3><p class="record-big">${t('portal.record.warningsCount', { count: warn.count, threshold: warn.threshold })}</p><p>${t('portal.record.warningsNote')}</p></li>
<li class="feature"><h3>${t('portal.record.ladder')}</h3><p class="record-big">${t('portal.record.ladderLevel', { level: view.ladder.level, max: 3 })}</p><p>${view.ladder.next}</p></li>
<li class="feature"><h3>${t('portal.record.activeNow')}</h3>${activeRows.length ? html`<ul class="record-active">${activeRows}</ul>` : html`<p>${t('portal.record.nothingActive')}</p>`}</li>
</ul>`;
}

/** `record`: buildRecordGroups' result (cases grouped by server, one appeals list). */
export function recordPage(ctx, { session, record }) {
    const text = textOf(ctx);
    const { t, ti } = text;
    const col = (key) => html`<th scope="col">${t(`portal.record.column.${key}`)}</th>`;
    const group = (g, i) => html`<section class="record-server" aria-labelledby="server-${String(i)}"><h2 id="server-${String(i)}">${g.server}</h2>
${g.summary ? summaryCards(ctx, g.view) : ''}
<div class="table-wrap" role="region" aria-label="${t('portal.record.casesIn', { server: g.server })}" tabindex="0"><table class="record-table"><caption class="visually-hidden">${t('portal.record.casesIn', { server: g.server })}</caption><thead><tr>${col('case')}${col('type')}${col('reason')}${col('by')}${col('date')}${col('ends')}${col('status')}${col('appeal')}</tr></thead>
<tbody>${g.view.cases.map((c) => html`<tr><td><code>${c.code}</code></td><td>${c.type}</td><td>${c.reason}</td><td>${c.by}</td><td>${when(ctx, c.createdAt)}</td><td>${c.permanent ? t('portal.record.permanent') : when(ctx, c.endsAt)}</td><td>${c.status}</td><td>${appealCell(text, c.appeal, ctx.webAppeals ? c.code : null)}</td></tr>`)}</tbody></table></div></section>`;
    return layout(ctx, {
        title: t('portal.record.title'), active: 'me',
        body: html`<div class="wrap page record"><div class="record-head"><div><h1>${t('portal.record.title')}</h1>
<p class="lead">${ti('portal.record.lead', { username: session.username })}</p></div>
<div class="record-links">${session.accountId ? html`<a class="button button-quiet" href="${MEMBER_BASE}/account">${t('portal.record.accountSettings')}</a> ` : ''}${ctx.webAppeals ? html`<a class="button button-quiet" href="${APPEALS_PATH}">${t('portal.record.myAppeals')}</a> ` : ''}<a class="button button-quiet" href="${MEMBER_BASE}/data" download>${t('portal.record.download')}</a> ${ctx.billing ? html`<a class="button button-quiet" href="${MEMBER_BASE}/billing">${t('portal.record.subscription')}</a> ` : ''}<form method="post" action="${MEMBER_BASE}/logout"><input type="hidden" name="csrf" value="${session.csrf}"><button class="button button-quiet" type="submit">${t('portal.record.logOut')}</button></form></div></div>
${record.groups.length ? html`${record.groups.map(group)}${record.truncated ? html`<p class="note">${text.tp('portal.record.truncated', record.caseCount)}</p>` : ''}`
        : html`<p>${t('portal.record.noCases')}</p>`}
<h2 id="appeals-title">${t('portal.record.appeals')}</h2>
${record.appeals.length ? html`<div class="table-wrap" role="region" aria-labelledby="appeals-title" tabindex="0"><table class="record-table"><thead><tr>${col('server')}${col('case')}${col('type')}${col('status')}${col('filed')}${col('decided')}</tr></thead>
<tbody>${record.appeals.map((a) => html`<tr><td>${a.server}</td><td><code>${a.code}</code></td><td>${a.type}</td><td>${a.status}</td><td>${when(ctx, a.filedAt)}</td><td>${when(ctx, a.decidedAt)}</td></tr>`)}</tbody></table></div>`
        : html`<p>${t('portal.record.noAppeals')}</p>`}
${appealHint(text, ctx)}</div>`,
    });
}

function messagePage(ctx, title, message, { login = false } = {}) {
    const { t } = textOf(ctx);
    return layout(ctx, {
        title, active: 'me',
        body: html`<div class="wrap page prose"><h1>${title}</h1><p class="lead">${message}</p>
<p><a class="button" href="${login ? `${MEMBER_BASE}/login` : MEMBER_BASE}">${t(login ? 'portal.message.logInAgain' : 'portal.message.backToRecord')}</a></p></div>`,
    });
}

// ── Handlers ──────────────────────────────────────────────────────────────

const defaultData = {
    getMemberStanding, listUserAppeals,
    listCasesAllServers: (userId, options) => listCasesForUserAllServers(userId, options),
    exportData: (userId) => buildDataExport(userId, { query, readKey: (key) => getFromDb(key, null) }),
};

async function discordFetch(fetchImpl, url, options) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Discord answered ${response.status}`);
    return body;
}

const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
/** This request's /me path (for the language picker and its redirect): only plain /me/… paths, else /me. */
function memberPath(req) {
    const path = `${req.baseUrl || ''}${req.path || ''}`.replace(/(.)\/$/, '$1');
    return /^\/me(\/[A-Za-z0-9_-]+)*$/.test(path) ? path : MEMBER_BASE;
}
/** This request's query without setlang (the picker adds its own), e.g. "sent=abc12" on /me/appeals. */
function memberQuery(req) {
    const params = new URL(req.originalUrl || '/', 'http://localhost').searchParams;
    params.delete('setlang');
    const query = params.toString();
    return query.length <= 500 ? query : '';
}
const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || 'unknown');

/**
 * The handlers, everything injectable for tests:
 * { settings, sessions, data, fetchImpl, states, limits, context }.
 * `context()` returns the site shell values (invites, dashboard link…).
 */
export function createMemberPortal({
    settings, sessions, data = defaultData, fetchImpl = globalThis.fetch, states = createStateStore(),
    limits = MEMBER_LIMITS, context = () => ({}), premium = null, accounts = null, appeals = null,
}) {
    const key = settings.signingKey;
    // Its own key for the return-path cookie, so it can never stand in for a session cookie.
    const nextKey = hmac('mewvo member next v1', key);
    const cookieOptions = { secure: settings.secure, path: MEMBER_BASE };
    const loginLimiter = createRateLimiter(limits.login);
    const pageLimiter = createRateLimiter(limits.page);
    const redeemLimiter = createRateLimiter(limits.redeem || MEMBER_LIMITS.redeem);
    const exportLimiter = createRateLimiter(limits.dataExport || MEMBER_LIMITS.dataExport);
    const appealLimiter = createRateLimiter(limits.appealSubmit || MEMBER_LIMITS.appealSubmit);
    const linkKey = hmac('mewvo member link v1', key);
    const forgotKey = hmac('mewvo member forgot v1', key);
    // Who is logged in, for the top bar of every /me page (set per request by `viewer` below).
    const viewers = new AsyncLocalStorage();
    // The page language and path per request (set by `viewer`): /me has no URL prefix, so the
    // language is the mewvo_lang cookie, else Accept-Language, else English (language.js).
    const requests = new AsyncLocalStorage();
    const ctx = () => {
        const here = requests.getStore() || { lang: DEFAULT_LANG, path: MEMBER_BASE };
        return {
            ...context(), ...translator(here.lang), memberPortal: true, billing: Boolean(premium), accounts: Boolean(accounts), webAppeals: Boolean(appeals), viewer: viewers.getStore() || null,
            // The picker on /me pages reloads the same /me page, query kept, with setlang=<code> (handled in `language` below).
            languageLink: (code) => `${here.path}?${here.query ? `${here.query}&` : ''}setlang=${encodeURIComponent(code)}`,
        };
    };
    const send = (res, status, page) => res.status(status).type('html').send(page);
    // A message page from two keys: portal.errors.<name>.title and .message.
    const fail = (res, status, name, options) => {
        const page = ctx();
        const { t } = textOf(page);
        return send(res, status, messagePage(page, t(`portal.errors.${name}.title`), t(`portal.errors.${name}.message`), options));
    };

    function headers(req, res, next) {
        res.set(MEMBER_SECURITY_HEADERS);
        if (settings.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
        next();
    }

    function limitBy(limiter) {
        return (req, res, next) => {
            if (limiter.allow(clientIp(req))) return next();
            res.set('Retry-After', '60');
            return fail(res, 429, 'slowDown');
        };
    }

    function cookieSessionId(req) {
        return verifySignedValue(parseCookies(req.headers?.cookie)[MEMBER_SESSION_COOKIE], key);
    }

    async function readSession(req) {
        const id = cookieSessionId(req);
        return id ? sessions.get(id) : null;
    }

    /**
     * Discord OAuth. linkAccountId: this login links that Mewvo account (POST /me/link).
     * forgot: this login is for a password reset (POST /me/forgot).
     */
    function startOAuth(req, res, { linkAccountId = null, forgot = false } = {}) {
        const { state, nonce } = createState(key);
        res.append('Set-Cookie', serializeCookie(MEMBER_STATE_COOKIE, nonce, { ...cookieOptions, maxAgeMs: STATE_TTL_MS }));
        if (linkAccountId) res.append('Set-Cookie', serializeCookie(MEMBER_LINK_COOKIE, signValue(`${linkAccountId}.${nonce}`, linkKey), { ...cookieOptions, maxAgeMs: STATE_TTL_MS }));
        else res.append('Set-Cookie', clearCookie(MEMBER_LINK_COOKIE, cookieOptions));
        if (forgot && !linkAccountId) res.append('Set-Cookie', serializeCookie(MEMBER_FORGOT_COOKIE, signValue(`forgot.${nonce}`, forgotKey), { ...cookieOptions, maxAgeMs: STATE_TTL_MS }));
        else res.append('Set-Cookie', clearCookie(MEMBER_FORGOT_COOKIE, cookieOptions));
        const next = linkAccountId || forgot ? MEMBER_BASE : safeNextPath(req.query?.next);
        if (next !== MEMBER_BASE) res.append('Set-Cookie', serializeCookie(MEMBER_NEXT_COOKIE, signValue(next, nextKey), { ...cookieOptions, maxAgeMs: STATE_TTL_MS }));
        else res.append('Set-Cookie', clearCookie(MEMBER_NEXT_COOKIE, cookieOptions));
        const params = new URLSearchParams({
            client_id: settings.clientId, response_type: 'code', redirect_uri: settings.redirectUri, scope: 'identify', state,
        });
        return res.redirect(302, `${AUTHORIZE_URL}?${params}`);
    }

    function login(req, res) {
        return startOAuth(req, res);
    }

    /** The account id of a link started in this browser, bound to the state nonce; else null. */
    function linkTarget(cookies) {
        const value = verifySignedValue(cookies[MEMBER_LINK_COOKIE], linkKey);
        if (!value) return null;
        const dot = value.indexOf('.');
        const accountId = value.slice(0, dot);
        const nonce = value.slice(dot + 1);
        return cookies[MEMBER_STATE_COOKIE] && safeEqual(nonce, cookies[MEMBER_STATE_COOKIE]) ? accountId : null;
    }

    /** True when a "Forgot password?" login was started in this browser, bound to the state nonce. */
    function forgotStarted(cookies) {
        const value = verifySignedValue(cookies[MEMBER_FORGOT_COOKIE], forgotKey);
        if (!value?.startsWith('forgot.')) return false;
        return Boolean(cookies[MEMBER_STATE_COOKIE]) && safeEqual(value.slice('forgot.'.length), cookies[MEMBER_STATE_COOKIE]);
    }

    async function callback(req, res) {
        const cookies = parseCookies(req.headers?.cookie);
        res.append('Set-Cookie', clearCookie(MEMBER_STATE_COOKIE, cookieOptions));
        res.append('Set-Cookie', clearCookie(MEMBER_LINK_COOKIE, cookieOptions));
        res.append('Set-Cookie', clearCookie(MEMBER_FORGOT_COOKIE, cookieOptions));
        if (req.query?.error) return fail(res, 400, 'loginCancelled', { login: true });
        const code = str(req.query?.code, 200);
        if (!code || !states.consume(str(req.query?.state, 1000), cookies[MEMBER_STATE_COOKIE], key)) {
            return fail(res, 400, 'loginExpired', { login: true });
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
            return fail(res, 502, 'loginFailed', { login: true });
        }
        if (!isSnowflake(String(me?.id || ''))) return fail(res, 502, 'noUser', { login: true });
        const linkAccountId = accountHandlers ? linkTarget(cookies) : null;
        if (linkAccountId) {
            const current = await readSession(req);
            if (!current?.accountId || current.accountId !== linkAccountId) {
                return fail(res, 400, 'linkOtherBrowser');
            }
            return accountHandlers.linkCallback(req, res, { session: current, discordUser: me });
        }
        // "Forgot password?": no session is made here; the account handlers decide.
        if (accountHandlers && forgotStarted(cookies)) return accountHandlers.resetCallback(req, res, { discordUser: me });
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
        if (!session.userId) {
            // A Mewvo account without Discord: the link step (forceLink normally sends it there first).
            const me = accountHandlers ? await accountHandlers.current(req) : null;
            if (!me) return send(res, 200, loginPage(ctx()));
            return res.redirect(303, `${MEMBER_BASE}/link`);
        }
        let record;
        try {
            // The user id comes from the session only; nothing in the URL is read. Every server's
            // cases (test cases excluded), then the standing of each server that has any.
            const [cases, appeals] = await Promise.all([
                data.listCasesAllServers(session.userId, { limit: CASE_LIMIT }),
                data.listUserAppeals(session.userId, APPEAL_LIMIT),
            ]);
            const own = (cases || []).filter((row) => row.target_user_id === session.userId && !row.is_test);
            const keys = [...new Set(own.map((row) => recordGroupKey(row.guild_id)))].slice(0, MAX_STANDING_SERVERS);
            const standings = new Map(await Promise.all(keys.map(async (key) => [key, await data.getMemberStanding(key, session.userId)])));
            record = buildRecordGroups({ cases: own, appeals, standings, guildName: (id) => data.guildName?.(id) ?? null, text: textOf(ctx()) });
        } catch (error) {
            logger.error(`Member portal: record of ${session.userId} could not be loaded: ${error.message}`);
            res.set('Retry-After', '60');
            return fail(res, 503, 'recordUnavailable');
        }
        return send(res, 200, recordPage(ctx(), { session, record }));
    }

    /** GET /me/data: the member's own data as a JSON download (id from the session only). */
    async function dataExport(req, res) {
        const session = await readSession(req);
        if (!session) return fail(res, 401, 'downloadLogin', { login: true });
        if (!session.userId && !session.accountId) return fail(res, 401, 'downloadLoginAccount', { login: true });
        let file;
        try {
            const account = session.accountId && accounts ? await accounts.store.exportOf(session.accountId) : null;
            if (session.userId) {
                file = await data.exportData(session.userId);
                if (account && !file.mewvoAccount?.length) file.mewvoAccount = [account];
            } else {
                file = { format: EXPORT_FORMAT, generatedAt: new Date().toISOString(), userId: null, note: ACCOUNT_EXPORT_NOTE, mewvoAccount: account ? [account] : [] };
            }
        } catch (error) {
            logger.error(`Member portal: data export of ${session.userId || `account ${session.accountId}`} failed: ${error.message}`);
            res.set('Retry-After', '60');
            return fail(res, 503, 'downloadUnavailable');
        }
        const who = session.userId || `account ${session.accountId}`;
        logger.info(`Member portal: ${who} downloaded their data`);
        res.set('Cache-Control', 'no-store');
        res.set('Content-Disposition', `attachment; filename="${session.userId ? exportFileName(session.userId) : `mewvo-account-data-${new Date().toISOString().slice(0, 10)}.json`}"`);
        return res.status(200).type('application/json').send(`${JSON.stringify(file, null, 2)}\n`);
    }

    async function logout(req, res) {
        const session = await readSession(req);
        if (!session) return fail(res, 401, 'notLoggedIn', { login: true });
        if (!isSameOrigin(req, settings.publicOrigin) || !safeEqual(str(req.body?.csrf, 100), session.csrf)) {
            return fail(res, 403, 'logoutNotAllowed');
        }
        await sessions.destroy(session.id);
        res.append('Set-Cookie', clearCookie(MEMBER_SESSION_COOKIE, cookieOptions));
        return res.redirect(303, MEMBER_BASE);
    }

    function notFound(req, res) {
        return fail(res, 404, 'notFound');
    }

    // Subscriptions (billing.js): only with a premium store (PREMIUM_TEST_CHECKOUT=true).
    // They need a Discord id: an account session without one is sent to /me (link Discord).
    const readDiscordSession = async (req) => { const s = await readSession(req); return s?.userId ? s : null; };
    const billing = premium ? createBillingHandlers({
        readSession: readDiscordSession, sessions, settings, ctx, send, store: premium, redeemLimiter, clientIp,
    }) : null;

    // Mewvo accounts (accountRoutes.js): on unless MEMBER_ACCOUNTS_ENABLED=false.
    const accountHandlers = accounts ? createAccountHandlers({
        settings, accountSettings: accounts.settings, store: accounts.store, sessions, ctx, send, clientIp, cookieOptions, key,
        sessionCookie: MEMBER_SESSION_COOKIE, cookieSessionId, readSession, sessionTtlMs: MEMBER_SESSION_TTL_MS,
        startLink: (req, res, accountId) => startOAuth(req, res, { linkAccountId: accountId }),
        startReset: (req, res) => startOAuth(req, res, { forgot: true }),
        ...(accounts.limits ? { limits: accounts.limits } : {}), ...(accounts.hashParams ? { hashParams: accounts.hashParams } : {}),
        ...(accounts.after ? { after: accounts.after } : {}),
    }) : null;

    // Web appeals (portalAppeals.js): only with the appeal data (the bot client) passed in.
    const appealHandlers = appeals ? createAppealHandlers({
        readSession, ctx, send, fail, data: appeals, settings, limiter: appealLimiter, appealInfo, loginPage,
    }) : null;

    /** Linking Discord is required: an account session without a Discord id only reaches the link step. */
    async function forceLink(req, res, next) {
        if (LINK_STEP_OPEN.has(`${req.method} ${req.path}`)) return next();
        const session = await readSession(req);
        if (session?.accountId && !session.userId) return res.redirect(303, `${MEMBER_BASE}/link`);
        return next();
    }

    /** A thrown error (database down while reading the session…) → 503, never a stack trace. */
    function safe(handler) {
        return async (req, res, next) => {
            try {
                return await handler(req, res, next);
            } catch (error) {
                logger.error(`Member portal ${req.method} ${req.path} failed: ${error.message}`);
                if (res.headersSent) return undefined;
                res.set('Retry-After', '60');
                return fail(res, 503, 'tryLater');
            }
        };
    }

    /**
     * The top bar's account menu: the logged-in member for this request, or null. Display only:
     * when the session cannot be read the bar shows "Log in", and the page's own handler reads
     * the session again and answers 503 as before.
     */
    async function viewer(req, res, next) {
        let session = null;
        try {
            session = await readSession(req);
        } catch (error) {
            logger.warn(`Member portal: top bar could not read the session: ${error.message}`);
        }
        const here = { lang: requestLanguage(req), path: memberPath(req), query: memberQuery(req) };
        return requests.run(here, () => {
            const who = session ? { name: session.username || textOf(ctx()).t('portal.viewer.fallbackName'), accountId: session.accountId || null, csrf: session.csrf } : null;
            return viewers.run(who, next);
        });
    }

    /**
     * ?setlang=<code> on a /me page (the language picker): sets the mewvo_lang cookie and reloads
     * the same /me page without it. An unknown code is ignored; the target is always this /me path.
     */
    function language(req, res, next) {
        if ((req.method !== 'GET' && req.method !== 'HEAD') || req.query?.setlang === undefined) return next();
        const code = LANG_CODES.find((c) => c === req.query.setlang);
        if (code) res.append('Set-Cookie', languageCookie(code, { secure: Boolean(settings.secure) }));
        const params = new URL(req.originalUrl || '/', 'http://localhost').searchParams;
        params.delete('setlang');
        const query = params.toString();
        res.set('Cache-Control', 'no-store');
        return res.redirect(302, `${memberPath(req)}${query ? `?${query}` : ''}`);
    }

    function router() {
        const r = express.Router();
        r.use(headers);
        r.use(language);
        r.use(viewer);
        if (accountHandlers) r.use(safe(forceLink));
        r.get('/', limitBy(pageLimiter), safe(index));
        r.get('/login', limitBy(loginLimiter), login);
        r.get('/callback', limitBy(loginLimiter), safe(callback));
        r.get('/data', limitBy(exportLimiter), safe(dataExport));
        r.post('/logout', limitBy(pageLimiter), express.urlencoded({ extended: false, limit: '2kb' }), safe(logout));
        if (appealHandlers) {
            r.get('/appeals', limitBy(pageLimiter), safe(appealHandlers.list));
            r.get('/appeal/:code', limitBy(pageLimiter), safe(appealHandlers.form));
            // Two answers of up to 1000 characters each, percent-encoded (non-Latin text is up to 9 bytes a character).
            r.post('/appeal/:code', limitBy(pageLimiter), express.urlencoded({ extended: false, limit: '24kb' }), safe(appealHandlers.submit));
        }
        if (accountHandlers) {
            const a = accountHandlers;
            const form = express.urlencoded({ extended: false, limit: '4kb' });
            const get = (path, handler) => r.get(path, limitBy(pageLimiter), safe(handler));
            const post = (path, handler) => r.post(path, limitBy(pageLimiter), form, safe(handler));
            get('/signup', a.signupForm); post('/signup', a.signupPost);
            get('/login-password', a.loginForm); post('/login-password', a.loginPost);
            get('/login-2fa', a.twoStepForm); post('/login-2fa', a.twoStepPost);
            get('/forgot', a.forgotForm);
            // Starts a Discord login, so it shares the login limit too.
            r.post('/forgot', limitBy(loginLimiter), form, safe(a.forgotPost));
            get('/reset', a.resetForm); post('/reset', a.resetPost);
            get('/link', a.linkPage); post('/link', a.linkPost);
            get('/linked', a.linked);
            post('/letter', a.letterPost); post('/letter/decline', a.letterDecline);
            get('/account', a.settingsPage);
            post('/account/password', a.passwordPost);
            post('/account/2fa/start', a.twoStepStart); post('/account/2fa/enable', a.twoStepEnable); post('/account/2fa/disable', a.twoStepDisable);
            post('/account/unlink', a.unlinkPost); post('/account/delete', a.deletePost);
        }
        if (billing) {
            const form = express.urlencoded({ extended: false, limit: '2kb' });
            r.get('/billing', limitBy(pageLimiter), safe(billing.billing));
            r.get('/billing/orders/:id', limitBy(pageLimiter), safe(billing.receipt));
            r.get('/checkout', limitBy(pageLimiter), safe(billing.checkout));
            r.post('/checkout', limitBy(pageLimiter), form, safe(billing.checkoutPost));
            r.get('/redeem', limitBy(pageLimiter), safe(billing.redeemForm));
            r.post('/redeem', limitBy(pageLimiter), form, safe(billing.redeemPost));
            // Online withdrawal (CRD Art. 11a): list → confirm → acknowledgement.
            r.get('/withdraw', limitBy(pageLimiter), safe(billing.withdrawList));
            r.get('/billing/orders/:id/withdraw', limitBy(pageLimiter), safe(billing.withdrawForm));
            r.post('/billing/orders/:id/withdraw', limitBy(pageLimiter), form, safe(billing.withdrawPost));
            r.get('/billing/orders/:id/withdrawal', limitBy(pageLimiter), safe(billing.withdrawalAck));
        }
        r.use(notFound);
        return r;
    }

    return { headers, login, callback, index, dataExport, logout, notFound, router, sessions, states, billing, accounts: accountHandlers, appeals: appealHandlers };
}

/**
 * The web appeals' data (portalAppeals.js) on top of the bot client: the member's cases in every
 * server, the case by code, the server name from the client's cache, and the normal appeal flow.
 */
export function portalAppealData(client) {
    return {
        listCases: (userId, options) => listCasesForUserAllServers(userId, options),
        listUserAppeals: (userId, limit) => listUserAppeals(userId, limit),
        getCase: (code) => getCaseByCodeAnyServer(code),
        guildName: (guildId) => client.guilds?.cache?.get(guildId)?.name || null,
        submitAppeal: ({ user, caseCode, answers }) => submitAppealService({ client, user, caseCode, answers }),
    };
}

/**
 * Mounts /me when MEMBER_PORTAL_ENABLED=true and the configuration is complete.
 * Returns true when mounted (the site then shows the "My record" link).
 */
export function registerMemberPortal(app, {
    env = process.env, dashboardEnabled = false, supportInvite = () => null, sessions = null, data, fetchImpl, limits, premium,
    accountStore = null, accountLimits = null, hashParams = null, accountAfter = null, client = null, appeals = null,
} = {}) {
    const settings = memberPortalSettings(env);
    if (!settings.requested) return false;
    if (!settings.enabled) {
        logger.error(`Member portal (/me) NOT enabled: ${settings.problems.join('; ')}`);
        return false;
    }
    const base = {
        publicSite: publicSiteEnabled(env),
        dashboardEnabled: Boolean(dashboardEnabled),
        installUrl: siteInstallUrl(env),
        mainInvite: inviteOrNull(env.MAIN_SERVER_INVITE),
        origin: siteOrigin(env),
        // Seller identity + VAT status for the checkout, receipts and DMs (billing.js).
        legal: { ...legalContact(env), vatRegistered: Boolean(String(env.LEGAL_VAT_NO || '').trim()) },
    };
    const context = () => {
        let support = null;
        try { support = inviteOrNull(supportInvite()); } catch { support = null; }
        return { ...base, supportInvite: support };
    };
    // Mewvo accounts: on with the portal, off only with MEMBER_ACCOUNTS_ENABLED=false.
    const accountSettings = memberAccountSettings(env, settings);
    if (accountSettings.requested && !accountSettings.enabled) logger.error(`Mewvo accounts NOT enabled: ${accountSettings.problems.join('; ')}`);
    const accounts = accountSettings.enabled ? {
        settings: accountSettings,
        store: accountStore || defaultAccountStore,
        ...(accountLimits ? { limits: accountLimits } : {}),
        ...(hashParams ? { hashParams } : {}),
        ...(accountAfter ? { after: accountAfter } : {}),
    } : null;
    const portal = createMemberPortal({
        settings,
        accounts,
        // Web appeals need the bot (submitAppeal opens the staff channel, server names): on with a client.
        appeals: appeals || (client ? portalAppealData(client) : null),
        sessions: sessions || createPgSessionStore({ query, table: pgConfig.tables.member_sessions, ttlMs: MEMBER_SESSION_TTL_MS, accounts: true }),
        context,
        // "My record" names each server from the bot's cache (portalAppeals.serverLabel).
        ...(data ? { data } : client ? { data: { ...defaultData, guildName: (id) => client.guilds?.cache?.get(id)?.name || null } } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(limits ? { limits } : {}),
        // Test checkout: only when PREMIUM_TEST_CHECKOUT=true (premiumService.js).
        premium: premiumSettings(env).testCheckout ? (premium || premiumStore) : null,
    });
    app.use(MEMBER_BASE, portal.router());
    logger.info(`Member portal enabled at ${MEMBER_BASE} (OAuth redirect ${settings.redirectUri})${portal.billing ? '; subscriptions in TEST CHECKOUT mode (no payments)' : ''}${portal.accounts ? '; Mewvo accounts on' : ''}${portal.appeals ? '; web appeals on' : ''}`);
    return true;
}
