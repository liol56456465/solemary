// routes.js — the read-only staff web dashboard on the bot's Express server.
//
//   GET  /staff                 → the cases page when logged in, else Discord login
//   GET  /staff/oauth/callback  Discord OAuth2 (scope identify only) comes back here
//   GET  /staff/cases           case search (the /case search filters), paged
//   GET  /staff/cases/:code     one case: details, edit history, evidence, appeals
//   GET  /staff/appeals         pending appeals with their age
//   GET  /staff/automod         automod actions per rule over 7 days, undo rates
//   GET  /staff/stats           staff moderation stats (/staff stats)
//   POST /staff/logout          the only POST (CSRF token + same-origin check)
//
// Access: members of the main server who are Administrators or have the ticket staff
// role, re-checked on every request (cached 60 s, access.js). The login state is
// HMAC-signed, expires after 10 minutes, is single use and bound to the browser by a
// nonce cookie. Sessions are kept in memory (12 h); the browser only gets a signed
// random id in an HttpOnly, SameSite=Lax cookie (Secure in production). The Discord
// access token is used once to read the user id and then dropped.
//
// Off unless STAFF_DASHBOARD_ENABLED=true; refuses to start without SESSION_SECRET
// (≥ 32 characters), CLIENT_ID, DISCORD_CLIENT_SECRET, PUBLIC_URL and MAIN_GUILD_ID.
// Add <PUBLIC_URL>/staff/oauth/callback under OAuth2 → Redirects in the Discord
// Developer Portal.

import express from 'express';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { normalizeCaseCode } from '../enforcement/format.js';
import { normalizeSearchFilters, searchCaseRecords } from '../enforcement/caseSearchService.js';
import {
    caseStatusLabel, getAppealHistory, getCaseByCode, getLatestAppealStatusesForCases,
} from '../enforcement/caseService.js';
import { getCaseEdits } from '../enforcement/caseEditService.js';
import { listEvidence, resolveImageUrls } from '../enforcement/evidenceService.js';
import { listPendingAppeals } from '../enforcement/appealService.js';
import { automodStats } from '../automod/automodReport.js';
import { automodRuleStats } from '../automod/automodTuning.js';
import { STATS_PERIODS, staffModerationStats } from '../staffActivityService.js';
import { createAccessChecker } from './access.js';
import { messagePage } from './html.js';
import { appealsPage, automodPage, caseDetailPage, casesPage, statsPage } from './pages.js';
import {
    MIN_SECRET_LENGTH, SESSION_COOKIE, SESSION_TTL_MS, STATE_COOKIE, STATE_TTL_MS,
    allowRequest, clearCookie, createSessionStore, createState, createStateStore,
    isSnowflake, parseCookies, serializeCookie, signValue, verifySignedValue,
} from './security.js';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const ME_URL = 'https://discord.com/api/v10/users/@me';
const HTTP_TIMEOUT_MS = 10000;
const CASES_PAGE_SIZE = 25;
const MAX_PAGE = 10000;
const AUTOMOD_DAYS = 7;

export const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://cdn.discordapp.com https://media.discordapp.net; "
        + "style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
};

/** The dashboard's configuration from the environment: { enabled, problems, … }. */
export function dashboardSettings(env = process.env) {
    const requested = String(env.STAFF_DASHBOARD_ENABLED || '').trim().toLowerCase() === 'true';
    const publicUrl = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
    const settings = {
        requested,
        clientId: String(env.CLIENT_ID || '').trim(),
        clientSecret: String(env.DISCORD_CLIENT_SECRET || '').trim(),
        sessionSecret: String(env.SESSION_SECRET || ''),
        redirectUri: publicUrl ? `${publicUrl}/staff/oauth/callback` : '',
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
        if (settings.sessionSecret.length < MIN_SECRET_LENGTH) settings.problems.push(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
        if (!settings.clientId) settings.problems.push('CLIENT_ID is not set');
        if (!settings.clientSecret) settings.problems.push('DISCORD_CLIENT_SECRET is not set');
        if (!publicUrl) settings.problems.push('PUBLIC_URL is not set');
        if (!isSnowflake(settings.mainGuildId || '')) settings.problems.push('MAIN_GUILD_ID is not set');
    }
    settings.enabled = requested && settings.problems.length === 0;
    return settings;
}

/** Express 5 may hand over arrays for repeated keys: keep strings only. */
function str(value, max = 200) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const defaultData = {
    searchCaseRecords, getCaseByCode, getCaseEdits, listEvidence, resolveImageUrls, getAppealHistory,
    listPendingAppeals, automodRuleStats, automodStats, staffModerationStats, getLatestAppealStatusesForCases,
};

async function discordFetch(fetchImpl, url, options) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(`Discord answered ${response.status}: ${body.error_description || body.error || body.message || 'unknown error'}`);
        error.status = response.status;
        throw error;
    }
    return body;
}

/**
 * The dashboard's handlers, with everything injectable for tests:
 * { client, settings, access, data, fetchImpl, sessions, states, rateLimit }.
 */
export function createDashboard({
    client, settings, access = createAccessChecker(client), data = defaultData, fetchImpl = globalThis.fetch,
    sessions = createSessionStore(), states = createStateStore(), rateLimit = { limit: 60, windowMs: 60 * 1000 },
}) {
    const secret = settings.sessionSecret;
    const guildId = settings.mainGuildId;

    const sendHtml = (res, status, page) => res.status(status).type('html').send(page);
    const fail = (res, status, title, message, session = null) => sendHtml(res, status, messagePage(title, message, session));

    function readSession(req) {
        const cookies = parseCookies(req.headers?.cookie);
        const id = verifySignedValue(cookies[SESSION_COOKIE], secret);
        return id ? sessions.get(id) : null;
    }

    function securityHeaders(req, res, next) {
        res.set(SECURITY_HEADERS);
        next();
    }

    function startLogin(req, res) {
        const { state, nonce } = createState(secret);
        res.append('Set-Cookie', serializeCookie(STATE_COOKIE, nonce, { maxAgeMs: STATE_TTL_MS, secure: settings.secure }));
        const params = new URLSearchParams({
            client_id: settings.clientId,
            response_type: 'code',
            redirect_uri: settings.redirectUri,
            scope: 'identify',
            state,
        });
        return res.redirect(302, `${AUTHORIZE_URL}?${params}`);
    }

    async function index(req, res) {
        if (readSession(req)) return res.redirect(302, '/staff/cases');
        return startLogin(req, res);
    }

    async function callback(req, res) {
        const cookies = parseCookies(req.headers?.cookie);
        res.append('Set-Cookie', clearCookie(STATE_COOKIE, { secure: settings.secure }));
        if (req.query?.error) return fail(res, 400, 'Login cancelled', 'You did not authorize. Open /staff again to log in.');
        const code = str(req.query?.code, 200);
        if (!code || !states.consume(str(req.query?.state, 1000), cookies[STATE_COOKIE], secret)) {
            return fail(res, 400, 'Login expired', 'This login link is invalid, expired or already used. Open /staff again.');
        }
        let me;
        try {
            const token = await discordFetch(fetchImpl, TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: settings.clientId,
                    client_secret: settings.clientSecret,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: settings.redirectUri,
                }),
            });
            me = await discordFetch(fetchImpl, ME_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
        } catch (error) {
            logger.warn(`Staff dashboard login failed: ${error.message}`);
            return fail(res, 502, 'Login failed', 'Discord did not confirm the login. Try again.');
        }
        if (!isSnowflake(String(me?.id || ''))) return fail(res, 502, 'Login failed', 'Discord did not return a user.');
        access.forget?.(me.id);
        const decision = await access.check(me.id);
        if (!decision.allowed) {
            logger.info(`Staff dashboard login refused for ${me.id}: ${decision.reason}`);
            return fail(res, 403, 'No access', 'The staff dashboard is for administrators and ticket staff of the main server.');
        }
        const session = sessions.create({ userId: me.id, username: me.global_name || me.username || me.id });
        res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, signValue(session.id, secret), { maxAgeMs: SESSION_TTL_MS, secure: settings.secure }));
        logger.info(`Staff dashboard login: ${me.id} (${decision.reason})`);
        return res.redirect(303, '/staff/cases');
    }

    /** Session + rate limit + live permission check for every page. */
    async function requireStaff(req, res, next) {
        const session = readSession(req);
        if (!session) {
            if (req.method === 'GET') return res.redirect(302, '/staff');
            return fail(res, 401, 'Logged out', 'Your session has ended. Open /staff to log in again.');
        }
        if (!allowRequest(session, rateLimit)) {
            res.set('Retry-After', '60');
            return fail(res, 429, 'Slow down', 'Too many requests in the last minute. Wait a moment and reload.', session);
        }
        const decision = await access.check(session.userId);
        if (!decision.allowed) {
            sessions.destroy(session.id);
            res.append('Set-Cookie', clearCookie(SESSION_COOKIE, { secure: settings.secure }));
            return fail(res, 403, 'No access', 'You are no longer an administrator or ticket staff in the main server.');
        }
        req.staffSession = session;
        return next();
    }

    async function cases(req, res) {
        const session = req.staffSession;
        const query = {
            member: str(req.query?.member, 20), moderator: str(req.query?.moderator, 20), type: str(req.query?.type, 10),
            status: str(req.query?.status, 10), text: str(req.query?.text, 100), from: str(req.query?.from, 10), to: str(req.query?.to, 10),
        };
        const page = Math.min(MAX_PAGE, Math.max(0, Number.parseInt(str(req.query?.page, 6), 10) || 0));
        let filters;
        try {
            filters = normalizeSearchFilters({
                memberId: query.member, moderatorId: query.moderator, type: query.type, status: query.status,
                text: query.text, from: query.from, to: query.to,
            });
        } catch (error) {
            return sendHtml(res, 400, casesPage({ session, query, error: error.userMessage || 'Invalid filter.' }));
        }
        const { rows, total } = await data.searchCaseRecords(guildId, filters, { page, pageSize: CASES_PAGE_SIZE });
        const appealStatuses = await data.getLatestAppealStatusesForCases(rows.map((row) => row.case_code));
        return sendHtml(res, 200, casesPage({
            session, query, rows, total, page, pageSize: CASES_PAGE_SIZE,
            statusLabel: (row) => caseStatusLabel(row, appealStatuses.get(row.case_code)),
        }));
    }

    async function caseDetail(req, res) {
        const session = req.staffSession;
        const code = normalizeCaseCode(str(req.params?.code, 10));
        const record = code ? await data.getCaseByCode(code) : null;
        if (!record || record.guild_id !== guildId) return fail(res, 404, 'Case not found', 'There is no case with that code.', session);
        const [edits, evidenceRows, appeals] = await Promise.all([
            data.getCaseEdits(code, 50),
            data.listEvidence(code),
            data.getAppealHistory(code),
        ]);
        // Image URLs expire: fetch fresh ones from the stored evidence messages, server-side.
        const fresh = await data.resolveImageUrls(client, evidenceRows);
        return sendHtml(res, 200, caseDetailPage({
            session,
            record,
            statusLabel: caseStatusLabel(record, appeals[0]?.status || null),
            edits,
            evidence: evidenceRows.map((row) => ({ row, freshUrl: fresh.get(String(row.id)) || null })),
            appeals,
        }));
    }

    async function appeals(req, res) {
        const rows = await data.listPendingAppeals(100);
        return sendHtml(res, 200, appealsPage({ session: req.staffSession, appeals: rows }));
    }

    async function automod(req, res) {
        const [byRule, stats] = await Promise.all([
            data.automodRuleStats(guildId, AUTOMOD_DAYS),
            data.automodStats(guildId, AUTOMOD_DAYS),
        ]);
        return sendHtml(res, 200, automodPage({ session: req.staffSession, byRule, stats, days: AUTOMOD_DAYS }));
    }

    async function stats(req, res) {
        const requested = str(req.query?.period, 5);
        const period = Object.hasOwn(STATS_PERIODS, requested) ? requested : '30d';
        const rows = await data.staffModerationStats(guildId, client.user?.id || '0', { period });
        return sendHtml(res, 200, statsPage({ session: req.staffSession, period, rows }));
    }

    async function logout(req, res) {
        const session = req.staffSession;
        const origin = req.headers?.origin;
        if ((origin && origin !== settings.publicOrigin) || str(req.body?.csrf, 100) !== session.csrf) {
            return fail(res, 403, 'Not allowed', 'The logout request did not come from this dashboard.', session);
        }
        sessions.destroy(session.id);
        res.append('Set-Cookie', clearCookie(SESSION_COOKIE, { secure: settings.secure }));
        return fail(res, 200, 'Logged out', 'You are logged out. Open /staff to log in again.');
    }

    function notFound(req, res) {
        return fail(res, 404, 'Not found', 'There is no such page.', req.staffSession || null);
    }

    return { securityHeaders, index, callback, requireStaff, cases, caseDetail, appeals, automod, stats, logout, notFound, sessions, states };
}

/** Wraps an async handler so a thrown error becomes a plain 500 page (and a log line). */
function safe(handler) {
    return async (req, res, next) => {
        try {
            return await handler(req, res, next);
        } catch (error) {
            logger.error(`Staff dashboard ${req.method} ${req.path} failed: ${error.message}`);
            if (res.headersSent) return undefined;
            return res.status(500).type('html').send(messagePage('Something went wrong', 'The page could not be loaded. Try again in a moment.'));
        }
    };
}

/** Adds the /staff routes to the bot's web server when enabled. Returns true when registered. */
export function registerStaffDashboard(app, client, env = process.env) {
    const settings = dashboardSettings(env);
    if (!settings.requested) return false;
    if (!settings.enabled) {
        logger.error(`Staff dashboard NOT enabled: ${settings.problems.join('; ')}`);
        return false;
    }
    const d = createDashboard({ client, settings });
    const router = express.Router();
    router.use(d.securityHeaders);
    router.get('/', safe(d.index));
    router.get('/oauth/callback', safe(d.callback));
    router.post('/logout', express.urlencoded({ extended: false, limit: '2kb' }), safe(d.requireStaff), safe(d.logout));
    router.get('/cases', safe(d.requireStaff), safe(d.cases));
    router.get('/cases/:code', safe(d.requireStaff), safe(d.caseDetail));
    router.get('/appeals', safe(d.requireStaff), safe(d.appeals));
    router.get('/automod', safe(d.requireStaff), safe(d.automod));
    router.get('/stats', safe(d.requireStaff), safe(d.stats));
    router.use(safe(d.requireStaff), d.notFound);
    app.use('/staff', router);
    logger.info(`Staff dashboard enabled at /staff (OAuth redirect ${settings.redirectUri})`);
    return true;
}
