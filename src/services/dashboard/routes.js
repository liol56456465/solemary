// routes.js — the web dashboard on the bot's Express server (Phase 1: login, overview,
// records; Phase 2: module settings pages with editing).
//
//   GET  /dashboard                 → Overview when logged in, else Discord login
//   GET  /dashboard/oauth/callback  Discord OAuth2 (scope identify only) comes back here
//   GET  /dashboard/overview        bot / database / server status, Getting started checklist
//   GET  /dashboard/cases           case search (the /case search filters), paged
//   GET  /dashboard/cases/:code     one case: details, edit history, evidence, appeals
//   GET  /dashboard/appeals         pending appeals of the main server with their age
//   GET  /dashboard/staff           staff moderation stats (/staff stats)
//   GET  /dashboard/audit           dashboard changes (old → new), filter by user/module, paged
//   GET  /dashboard/<module>        a settings page (modules/*.js): current values + forms
//   POST /dashboard/<module>/<act>  a settings form: CSRF + same origin + edit switch +
//                                   access, 30 POSTs/min per session, validated by the
//                                   module through the SAME services the commands use;
//                                   success → audit rows + mod log line + flash + 303;
//                                   invalid input → 400 with the page and the message
//   Phase 3 (enforcementRoutes.js): /users (every member, filters), /users/:id (member page,
//   actions with a confirm step, roles / nickname / timeout, staff notes), case edit/void/evidence on /cases/:code,
//   /appeals/:code (dossier, accept/deny with a confirm step), /nocontact, coverage
//   heatmap and mass-action blocks on /staff. Same POST checks + Administrator (canAct).
//   GET  /dashboard/static/<file>  dashboard.css (CSP style-src 'self') and dashboard.js (script-src 'self', optional)
//   POST /dashboard/cases/:code/evidence/upload  an evidence image (multipart, 8 MB, magic-byte check)
//   POST /dashboard/logout          CSRF token + same-origin check
//   /staff, /staff/*                → 301 /dashboard (the old read-only staff dashboard)
//
// Access: CURRENT Administrators of the main server (canAct) and OWNER_IDS (view and
// settings only), re-checked on every request (cached 60 s, access.js). The login
// state is HMAC-signed, expires after 10 minutes, is single use and bound to the
// browser by a nonce cookie. Sessions are in Postgres (sessionStore.js: hashed ids,
// rotated on login, 12 h); the browser only gets a signed random id in an HttpOnly,
// SameSite=Lax cookie (Secure in production / https). The Discord access token is used
// once to read the user and then dropped.
//
// Rate limits (owner decision 7): /dashboard is exempt from the app-wide per-IP limiter;
// instead 300 requests/min per session, and 30/min per IP for the login routes.
//
// Editing: only with DASHBOARD_EDIT_ENABLED=true (default off → every page read-only
// with a notice). Administrators and OWNER_IDS may change settings (owner decision 4);
// actions marked admin (member levels, giveaways) need Administrator (canAct).
//
// Off unless DASHBOARD_ENABLED=true (STAFF_DASHBOARD_ENABLED=true still works); refuses
// to start without SESSION_SECRET (≥ 32 characters), CLIENT_ID, DISCORD_CLIENT_SECRET,
// PUBLIC_URL and MAIN_GUILD_ID. Add <PUBLIC_URL>/dashboard/oauth/callback under OAuth2 →
// Redirects in the Discord Developer Portal.

import fs from 'node:fs';
import express from 'express';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { recordOwnerOverride } from '../ownerOverride.js';
import { normalizeCaseCode } from '../enforcement/format.js';
import { normalizeSearchFilters, searchCaseRecords } from '../enforcement/caseSearchService.js';
import {
    caseStatusLabel, getAppealHistory, getCaseByCode, getLatestAppealStatusesForCases,
} from '../enforcement/caseService.js';
import { getCaseEdits } from '../enforcement/caseEditService.js';
import { listEvidence, resolveImageUrls } from '../enforcement/evidenceService.js';
import { listPendingAppeals } from '../enforcement/appealService.js';
import { STATS_PERIODS, staffModerationStats } from '../staffActivityService.js';
import { listSettingsAudit } from '../settings/guildSettings.js';
import { createAccessChecker } from './access.js';
import { BASE, THEME_COOKIE, html, messagePage, path, themeFrom } from './html.js';
import {
    appealsPage, auditPage, caseDetailPage, casesPage, moduleSettingsPage, statsPage,
} from './pages.js';
import { collectChecklist, collectOverview, defaultOverviewData, moduleStatesFrom, overviewPage } from './overview.js';
import { modulesPage } from './modulesPage.js';
import { MODULES, getAction, getModule } from './modules/index.js';
import { MODULE_COMMANDS, moduleCommandsSection } from './modules/commands.js';
import { defaultServices } from './services.js';
import { AUDIT_PAGE_SIZE, createAuditStore, recordDashboardChange } from './audit.js';
import { defaultEnforcement } from './enforcementData.js';
import { createEnforcementHandlers } from './enforcementRoutes.js';
import { createConfirmStore } from './confirmTokens.js';
import { InputError, plainText } from './forms.js';
import { MAX_UPLOAD_BYTES, MultipartError, parseMultipart } from './multipart.js';
import { createPgSessionStore } from './sessionStore.js';
import { query } from '../enforcement/db.js';
import { pgConfig } from '../../config/database/postgres.js';
import {
    MIN_SECRET_LENGTH, SESSION_COOKIE, SESSION_TTL_MS, STATE_COOKIE, STATE_TTL_MS,
    clearCookie, createRateLimiter, createState, createStateStore,
    isSameOrigin, isSnowflake, parseCookies, safeEqual, serializeCookie, signValue, verifySignedValue,
} from './security.js';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const ME_URL = 'https://discord.com/api/v10/users/@me';
const HTTP_TIMEOUT_MS = 10000;
const CASES_PAGE_SIZE = 25;
const MAX_PAGE = 10000;
const MODULE_STATES_TTL_MS = 60 * 1000;
// Dashboard changes listed on the Overview.
const RECENT_CHANGES = 6;
/** The only files under /dashboard/static, with their Content-Type. */
export const STATIC_FILES = {
    'dashboard.css': 'text/css',
    'dashboard.js': 'text/javascript',
};

export const DEFAULT_LIMITS = {
    session: { limit: 300, windowMs: 60 * 1000 },
    ip: { limit: 30, windowMs: 60 * 1000 },
    static: { limit: 300, windowMs: 60 * 1000 },
    post: { limit: 30, windowMs: 60 * 1000 },
};

export const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' https://cdn.discordapp.com https://media.discordapp.net; "
        + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // same-origin (not no-referrer): with no-referrer, browsers send "Origin: null" on
    // form POSTs, which the same-origin check would refuse.
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
};

/** Audit-log modules written by the Phase 3 enforcement pages (for the filter). */
export const ENFORCEMENT_AUDIT_MODULES = [
    { key: 'actions', label: 'Enforcement actions' },
    { key: 'cases', label: 'Case changes' },
    { key: 'appeal-decisions', label: 'Appeal decisions' },
    { key: 'notes', label: 'Staff notes' },
    { key: 'nocontact', label: 'No-contact orders' },
    { key: 'massguard', label: 'Mass-action guard' },
];

const truthy = (value) => String(value || '').trim().toLowerCase() === 'true';

/** The dashboard's configuration from the environment: { enabled, requested, problems, … }. */
export function dashboardSettings(env = process.env) {
    const requested = truthy(env.DASHBOARD_ENABLED) || truthy(env.STAFF_DASHBOARD_ENABLED);
    const publicUrl = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
    const settings = {
        requested,
        editEnabled: truthy(env.DASHBOARD_EDIT_ENABLED),
        clientId: String(env.CLIENT_ID || '').trim(),
        clientSecret: String(env.DISCORD_CLIENT_SECRET || '').trim(),
        sessionSecret: String(env.SESSION_SECRET || ''),
        redirectUri: publicUrl ? `${publicUrl}${BASE}/oauth/callback` : '',
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

/**
 * A dashboard path to come back to (theme switch): only /dashboard/<letters, digits,
 * - / _> with an optional simple query; anything else → the Overview. Never an
 * absolute URL, never another site.
 */
export function safeBackPath(value) {
    const text = typeof value === 'string' ? value : '';
    return /^\/dashboard(\/[A-Za-z0-9_\-/]*)?(\?[A-Za-z0-9_\-=&%.]*)?$/.test(text) && !text.includes('//') ? text : path('/overview');
}

/** Express 5 may hand over arrays for repeated keys: keep strings only. */
function str(value, max = 200) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const defaultData = {
    searchCaseRecords, getCaseByCode, getCaseEdits, listEvidence, resolveImageUrls, getAppealHistory,
    listPendingAppeals, staffModerationStats, getLatestAppealStatusesForCases,
    listSettingsAudit, overview: defaultOverviewData,
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

function clientIp(req) {
    return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

/**
 * The dashboard's handlers, with everything injectable for tests:
 * { client, settings, sessions, access, data, fetchImpl, states, limits }.
 * `sessions` is required (createPgSessionStore in production, a memory store in tests).
 */
export function createDashboard({
    client, settings, sessions, access = createAccessChecker(client, { guildId: settings.mainGuildId }), data = defaultData,
    fetchImpl = globalThis.fetch, states = createStateStore(), limits = DEFAULT_LIMITS,
    services = defaultServices, auditStore = null, modules = MODULES, env = process.env,
    enforcement = defaultEnforcement, confirms = createConfirmStore(),
}) {
    const secret = settings.sessionSecret;
    const guildId = settings.mainGuildId;
    const sessionLimiter = createRateLimiter(limits.session);
    const ipLimiter = createRateLimiter(limits.ip);
    const staticLimiter = createRateLimiter(limits.static);
    const postLimiter = createRateLimiter(limits.post || DEFAULT_LIMITS.post);
    const audits = auditStore || createAuditStore();
    const moduleList = modules;
    const findModule = (key) => (modules === MODULES ? getModule(key) : modules.find((m) => m.key === key) || null);
    const cookieOptions = { secure: settings.secure, path: BASE };
    let moduleStatesCache = { at: 0, value: {} };

    const sendHtml = (res, status, page) => res.status(status).type('html').send(page);
    const fail = (res, status, title, message, req = null) => sendHtml(res, status, messagePage(title, message, req?.dashboard?.session || null, shellOf(req)));

    /** The server shown in the top bar: name and icon (Discord CDN, allowed by the CSP img-src). */
    function serverInfo() {
        const guild = client.guilds?.cache?.get(guildId);
        if (!guild) return null;
        let iconUrl = null;
        try {
            iconUrl = typeof guild.iconURL === 'function' ? guild.iconURL({ size: 64, extension: 'png' }) : null;
        } catch {
            iconUrl = null;
        }
        return { name: guild.name, iconUrl: iconUrl && /^https:\/\/cdn\.discordapp\.com\//.test(iconUrl) ? iconUrl : null };
    }

    /** The theme cookie (light / dark / system): set on <html> server-side, so no flash. */
    function themeOf(req) {
        return themeFrom(parseCookies(req?.headers?.cookie)[THEME_COOKIE]);
    }

    function shellOf(req) {
        const ctx = req?.dashboard;
        if (!ctx) return req ? { session: null, theme: themeOf(req) } : {};
        // A copy of the session with display-only extras for the page shell.
        const session = { ...ctx.session, theme: themeOf(req), server: serverInfo(), path: safeBackPath(req.originalUrl || req.url) };
        return { session, access: ctx.access, moduleStates: ctx.moduleStates || {} };
    }

    function cookieSessionId(req) {
        const cookies = parseCookies(req.headers?.cookie);
        return verifySignedValue(cookies[SESSION_COOKIE], secret);
    }

    async function readSession(req) {
        const id = cookieSessionId(req);
        return id ? sessions.get(id) : null;
    }

    async function moduleStates() {
        const now = Date.now();
        if (now - moduleStatesCache.at < MODULE_STATES_TTL_MS) return moduleStatesCache.value;
        const overviewData = data.overview || defaultOverviewData;
        const [config, welcome, automodSettings, joinToCreate, applications] = await Promise.all([
            overviewData.getGuildConfig(client, guildId).catch(() => null),
            overviewData.getWelcomeConfig(client, guildId).catch(() => null),
            Promise.resolve().then(() => services.getAutomodSettings(guildId)).catch(() => null),
            Promise.resolve().then(() => services.getJoinToCreateConfiguration(client, guildId)).catch(() => null),
            Promise.resolve().then(() => services.getApplicationSettings(client, guildId)).catch(() => null),
        ]);
        moduleStatesCache = { at: now, value: moduleStatesFrom(config, welcome, { automod: automodSettings, joinToCreate, applications }) };
        return moduleStatesCache.value;
    }

    function securityHeaders(req, res, next) {
        res.set(SECURITY_HEADERS);
        // Served over HTTPS: browsers must not try plain HTTP for a year (no downgrade on a first
        // visit from a hostile network). Not sent for a local http:// preview.
        if (settings.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
        next();
    }

    /** Per-IP limit for the routes reachable without a session (login, callback). */
    function limitByIp(req, res, next) {
        if (!ipLimiter.allow(clientIp(req))) {
            res.set('Retry-After', '60');
            return fail(res, 429, 'Slow down', 'Too many login attempts from your address. Wait a minute and try again.');
        }
        return next();
    }

    // The static files (read once): the stylesheet, the one script (progressive
    // enhancement, CSP script-src 'self') and the icon sprite. Nothing else is served.
    const staticFiles = new Map(Object.entries(STATIC_FILES).map(([name, type]) => {
        try {
            return [name, { type, body: fs.readFileSync(new URL(`./static/${name}`, import.meta.url), 'utf8') }];
        } catch (error) {
            logger.error(`Dashboard static file missing (${name}): ${error.message}`);
            return [name, { type, body: '' }];
        }
    }));

    function serveStatic(name, req, res) {
        if (!staticLimiter.allow(clientIp(req))) return res.status(429).type('text/plain').send('Too many requests');
        const file = staticFiles.get(name);
        if (!file) return res.status(404).type('text/plain').send('Not found');
        res.set('Cache-Control', 'public, max-age=3600');
        return res.status(200).type(file.type).send(file.body);
    }

    const stylesheet = (req, res) => serveStatic('dashboard.css', req, res);
    const staticFile = (req, res) => serveStatic(typeof req.params?.file === 'string' ? req.params.file : '', req, res);

    /**
     * After requireUser on the upload route: the size-capped raw body (express.raw) →
     * fields in req.body (so the CSRF check works as usual) and the file in req.upload.
     */
    function parseUpload(req, res, next) {
        try {
            const { fields, file } = parseMultipart(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.headers?.['content-type']);
            req.body = fields;
            req.upload = { file };
        } catch (error) {
            if (!(error instanceof MultipartError)) throw error;
            return fail(res, error.status, error.status === 413 ? 'Too large' : 'Upload refused', error.userMessage, req);
        }
        return next();
    }

    function startLogin(req, res) {
        const { state, nonce } = createState(secret);
        res.append('Set-Cookie', serializeCookie(STATE_COOKIE, nonce, { ...cookieOptions, maxAgeMs: STATE_TTL_MS }));
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
        if (await readSession(req)) return res.redirect(302, path('/overview'));
        return startLogin(req, res);
    }

    async function callback(req, res) {
        const cookies = parseCookies(req.headers?.cookie);
        res.append('Set-Cookie', clearCookie(STATE_COOKIE, cookieOptions));
        if (req.query?.error) return fail(res, 400, 'Login cancelled', `You did not authorize. Open ${BASE} again to log in.`);
        const code = str(req.query?.code, 200);
        if (!code || !states.consume(str(req.query?.state, 1000), cookies[STATE_COOKIE], secret)) {
            return fail(res, 400, 'Login expired', `This login link is invalid, expired or already used. Open ${BASE} again.`);
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
            logger.warn(`Dashboard login failed: ${error.message}`);
            return fail(res, 502, 'Login failed', 'Discord did not confirm the login. Try again.');
        }
        if (!isSnowflake(String(me?.id || ''))) return fail(res, 502, 'Login failed', 'Discord did not return a user.');
        access.forget?.(me.id);
        const decision = await access.check(me.id);
        if (!decision.allowed) {
            logger.info(`Dashboard login refused for ${me.id}: ${decision.reason}`);
            return fail(res, 403, 'No access', 'The dashboard is for administrators of the main server and the bot owners.');
        }
        // Rotation: whatever session this browser had is dropped; a fresh id is issued.
        const session = await sessions.rotate(cookieSessionId(req), {
            userId: me.id,
            username: me.global_name || me.username || me.id,
            avatar: typeof me.avatar === 'string' ? me.avatar : null,
        });
        res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, signValue(session.id, secret), { ...cookieOptions, maxAgeMs: SESSION_TTL_MS }));
        logger.info(`Dashboard login: ${me.id} (${decision.reason})`);
        return res.redirect(303, path('/overview'));
    }

    /** Session + rate limit + live permission check for every page. */
    async function requireUser(req, res, next) {
        const session = await readSession(req);
        if (!session) {
            if (req.method === 'GET') return res.redirect(302, BASE);
            return fail(res, 401, 'Logged out', `Your session has ended. Open ${BASE} to log in again.`);
        }
        if (!sessionLimiter.allow(session.idHash)) {
            res.set('Retry-After', '60');
            return fail(res, 429, 'Slow down', 'Too many requests in the last minute. Wait a moment and reload.');
        }
        const decision = await access.check(session.userId);
        if (!decision.allowed) {
            await sessions.destroy(session.id);
            res.append('Set-Cookie', clearCookie(SESSION_COOKIE, cookieOptions));
            return fail(res, 403, 'No access', 'You are no longer an administrator of the main server.');
        }
        req.dashboard = { session, access: decision, moduleStates: await moduleStates().catch(() => ({})), flash: null };
        if (req.method === 'GET' && session.flash) {
            // One-shot message from the last saved form (POST → 303 → this GET).
            req.dashboard.flash = session.flash;
            await sessions.setFlash?.(session.id, null)?.catch?.(() => {});
        }
        return next();
    }

    /** CSRF token + same origin, for every POST. */
    function checkPost(req) {
        const session = req.dashboard.session;
        return isSameOrigin(req, settings.publicOrigin) && safeEqual(str(req.body?.csrf, 100), session.csrf);
    }

    async function overview(req, res) {
        const result = await collectOverview({ client, guildId, data: data.overview || defaultOverviewData });
        // Fresh config-based states on top of the full set (automod, join-to-create, applications).
        req.dashboard.moduleStates = { ...req.dashboard.moduleStates, ...result.moduleStates };
        const recentChanges = await audits.list(guildId, { page: 0, pageSize: RECENT_CHANGES })
            .then((r) => r.rows).catch(() => null);
        return sendHtml(res, 200, overviewPage({ ...shellOf(req), overview: result, recentChanges }));
    }

    /** GET /dashboard/modules[?show=on|off]: every module as a card with its switch. */
    async function modulesHub(req, res) {
        const checklist = await collectChecklist({ client, guildId, data: data.overview || defaultOverviewData });
        return sendHtml(res, 200, modulesPage({
            ...shellOf(req), flash: req.dashboard.flash, editEnabled: settings.editEnabled, show: str(req.query?.show, 5), q: str(req.query?.q, 60), checklist,
        }));
    }

    async function cases(req, res) {
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
            return sendHtml(res, 400, casesPage({ ...shellOf(req), query, error: error.userMessage || 'Invalid filter.' }));
        }
        const { rows, total } = await data.searchCaseRecords(guildId, filters, { page, pageSize: CASES_PAGE_SIZE });
        const appealStatuses = await data.getLatestAppealStatusesForCases(rows.map((row) => row.case_code));
        return sendHtml(res, 200, casesPage({
            ...shellOf(req), query, rows, total, page, pageSize: CASES_PAGE_SIZE,
            statusLabel: (row) => caseStatusLabel(row, appealStatuses.get(row.case_code)),
        }));
    }

    async function renderCase(req, res, status = 200, { error = null } = {}) {
        const code = normalizeCaseCode(str(req.params?.code, 10));
        const record = code ? await data.getCaseByCode(code) : null;
        if (!record || record.guild_id !== guildId) return fail(res, 404, 'Case not found', 'There is no case with that code.', req);
        const [edits, evidenceRows, appeals] = await Promise.all([
            data.getCaseEdits(code, 50),
            data.listEvidence(code),
            data.getAppealHistory(code),
        ]);
        // Image URLs expire: fetch fresh ones from the stored evidence messages, server-side.
        const fresh = await data.resolveImageUrls(client, evidenceRows);
        const evidence = evidenceRows.map((row) => ({ row, freshUrl: fresh.get(String(row.id)) || null }));
        const actions = enforcementHandlers.caseActionForms({
            record, evidence, csrf: req.dashboard.session.csrf, canWrite: enforcementHandlers.canWrite(req),
            flash: status === 200 ? req.dashboard.flash : null, error, editEnabled: settings.editEnabled, canAct: req.dashboard.access.canAct,
        });
        return sendHtml(res, status, caseDetailPage({
            ...shellOf(req),
            record,
            statusLabel: caseStatusLabel(record, appeals[0]?.status || null),
            edits,
            evidence,
            appeals,
            top: actions.top,
            bottom: actions.bottom,
        }));
    }

    const caseDetail = (req, res) => renderCase(req, res);

    async function appeals(req, res) {
        const rows = await data.listPendingAppeals(100, guildId);
        return sendHtml(res, 200, appealsPage({ ...shellOf(req), appeals: rows, flash: req.dashboard.flash, canWrite: enforcementHandlers.canWrite(req) }));
    }

    async function renderStaff(req, res, status = 200, { error = null } = {}) {
        const requested = str(req.query?.period, 5);
        const period = Object.hasOwn(STATS_PERIODS, requested) ? requested : '30d';
        const [rows, sections] = await Promise.all([
            data.staffModerationStats(guildId, client.user?.id || '0', { period }),
            enforcementHandlers.staffSections(req, period),
        ]);
        return sendHtml(res, status, statsPage({ ...shellOf(req), period, rows, sections, flash: status === 200 ? req.dashboard.flash : null, error }));
    }

    const staff = (req, res) => renderStaff(req, res);

    async function audit(req, res) {
        const userFilter = str(req.query?.user, 20);
        const moduleFilter = str(req.query?.module, 40);
        const filters = {
            user: isSnowflake(userFilter) ? userFilter : '',
            module: /^[a-z-]{1,40}$/.test(moduleFilter) ? moduleFilter : '',
        };
        const page = Math.min(MAX_PAGE, Math.max(0, Number.parseInt(str(req.query?.page, 6), 10) || 0));
        const [{ rows, total }, users] = await Promise.all([
            audits.list(guildId, { userId: filters.user || null, module: filters.module || null, page, pageSize: AUDIT_PAGE_SIZE }),
            audits.users(guildId).catch(() => []),
        ]);
        const moduleChoices = [...moduleList.map((m) => ({ key: m.key, label: m.label })), { key: 'appeals', label: 'Appeals (registry)' }, { key: 'logging', label: 'Logging' },
            ...ENFORCEMENT_AUDIT_MODULES]
            .filter((m, i, all) => all.findIndex((x) => x.key === m.key) === i);
        return sendHtml(res, 200, auditPage({ ...shellOf(req), rows, total, page, pageSize: AUDIT_PAGE_SIZE, filters, users, modules: moduleChoices }));
    }

    /** What a module page / action sees: the guild, the services, who acts and what they may do. */
    function contextFor(req) {
        const { session, access: decision } = req.dashboard;
        return {
            client, guildId, env, services,
            guild: client.guilds?.cache?.get(guildId) || null,
            session, access: decision, csrf: session.csrf,
            actor: { userId: session.userId, username: session.username },
            editEnabled: settings.editEnabled,
            canEdit: Boolean(settings.editEnabled && decision.canView),
            canAct: Boolean(decision.canAct),
        };
    }

    async function renderModule(req, res, module, status = 200, { error = null, errorAction = null, errorField = null, warnings = [] } = {}) {
        const ctx = contextFor(req);
        const data = await module.load(ctx);
        // The module's own commands with their switches (not on the Commands page itself).
        let commandsSection = '';
        if (module.key !== 'commands' && client?.commands && MODULE_COMMANDS[module.key]) {
            try {
                const config = await services.getGuildConfig(client, guildId);
                commandsSection = moduleCommandsSection(ctx, module.key, services.getCommandAccessSnapshot(client, config));
            } catch (error) {
                logger.warn(`Dashboard: commands of ${module.key} not shown: ${error.message}`);
            }
        }
        return sendHtml(res, status, moduleSettingsPage({
            ...shellOf(req), module, body: html`${module.render(ctx, data)}${commandsSection}`,
            flash: req.dashboard.flash, error, errorAction, errorField, warnings, editEnabled: settings.editEnabled,
        }));
    }

    async function modulePage(req, res, next) {
        const module = findModule(str(req.params?.module, 40));
        if (!module) return next();
        return renderModule(req, res, module);
    }

    /** True for errors whose message is meant for the person who filled in the form. */
    function isInputError(error) {
        return error instanceof InputError
            || ['validation', 'user_input', 'permission', 'configuration'].includes(error?.type)
            || Array.isArray(error?.problems);
    }

    /**
     * POST /dashboard/<module>/<action>. Order: rate limit → same origin + CSRF → edit
     * switch → module/action → Administrator for admin actions → run → audit + mod log →
     * flash → 303. Every refusal changes nothing.
     */
    async function moduleAction(req, res) {
        const session = req.dashboard.session;
        if (!postLimiter.allow(session.idHash)) {
            res.set('Retry-After', '60');
            return fail(res, 429, 'Slow down', 'Too many changes in the last minute. Wait a moment and try again.', req);
        }
        if (!checkPost(req)) return fail(res, 403, 'Not allowed', 'This form did not come from this dashboard (security token or origin mismatch). Reload the page and try again.', req);
        if (!settings.editEnabled) return fail(res, 403, 'Editing is off', 'Editing from the dashboard is turned off (DASHBOARD_EDIT_ENABLED). Nothing was changed.', req);
        const module = findModule(str(req.params?.module, 40));
        const action = module ? getAction(module, str(req.params?.action, 40)) : null;
        if (!module || !action) return fail(res, 404, 'Not found', 'There is no such form.', req);
        const decision = req.dashboard.access;
        if (!decision.canView || (action.admin && !decision.canAct)) {
            return fail(res, 403, 'Not allowed', 'This needs Administrator in the main server.', req);
        }
        const ctx = contextFor(req);
        if (!ctx.guild) return fail(res, 503, 'Server unavailable', 'The bot cannot see the main server right now. Try again in a moment.', req);
        let result;
        try {
            result = await action.run(ctx, req.body || {});
        } catch (error) {
            if (isInputError(error)) {
                const message = plainText(error.userMessage || error.message);
                logger.info(`Dashboard ${module.key}/${req.params.action} refused for ${session.userId}: ${message}`);
                return renderModule(req, res, module, error.status === 403 ? 403 : 400, {
                    error: message, errorAction: str(req.params?.action, 40), errorField: typeof error.field === 'string' ? error.field : null,
                });
            }
            throw error;
        }
        if (!decision.canAct && decision.role === 'owner') {
            await recordOwnerOverride({ client, guildId, userId: session.userId, username: session.username, action: `${module.key}/${str(req.params?.action, 40)}`, via: 'dashboard' });
        }
        const changes = result?.changes || [];
        await recordDashboardChange({
            store: audits, postModLog: services.postModLog, client, guildId, actor: ctx.actor,
            module: module.key, moduleLabel: module.label, changes, audited: Boolean(result?.audited),
        });
        if (changes.length) {
            moduleStatesCache = { at: 0, value: {} };
            logger.info(`Dashboard change by ${session.userId} in ${module.key}: ${changes.map((c) => c.key).join(', ')}`);
        }
        const message = [result?.message || (changes.length ? 'Saved.' : 'Nothing changed.'), ...(result?.warnings || [])].map(plainText).join(' ');
        await sessions.setFlash?.(session.id, message);
        // `back`: the Modules page or another module's page (only known names); else this module.
        const back = typeof req.body?.back === 'string' ? req.body.back : '';
        const target = back === 'modules' || (back && findModule(back)) ? `/${back}` : `/${module.key}`;
        return res.redirect(303, path(target));
    }

    // Phase 3: enforcement and records (enforcementRoutes.js), with the same POST
    // checks; renderCase / renderStaff re-render those pages with an error.
    const enforcementHandlers = createEnforcementHandlers({
        client, guildId, settings, sessions, audits, services, enforcement, confirms,
        sendHtml, fail, shellOf, checkPost, postLimiter, recordDashboardChange,
        renderCase: (...args) => renderCase(...args), renderStaff: (...args) => renderStaff(...args),
    });

    async function logout(req, res) {
        if (!checkPost(req)) return fail(res, 403, 'Not allowed', 'The logout request did not come from this dashboard.', req);
        await sessions.destroy(req.dashboard.session.id);
        res.append('Set-Cookie', clearCookie(SESSION_COOKIE, cookieOptions));
        return fail(res, 200, 'Logged out', `You are logged out. Open ${BASE} to log in again.`);
    }

    /**
     * GET /dashboard/theme?mode=light|dark|system&next=/dashboard/… — the theme switch
     * without JS: a one-year cookie (not secret, not HttpOnly so the script can switch in
     * place) and a redirect back to a dashboard path. Changes nothing on the server.
     */
    function setTheme(req, res) {
        const mode = themeFrom(str(req.query?.mode, 10));
        res.append('Set-Cookie', serializeCookie(THEME_COOKIE, mode, { ...cookieOptions, httpOnly: false, maxAgeMs: 365 * 24 * 3600 * 1000 }));
        return res.redirect(303, safeBackPath(str(req.query?.next, 300)));
    }

    function notFound(req, res) {
        return fail(res, 404, 'Not found', 'There is no such page.', req);
    }

    return {
        securityHeaders, limitByIp, stylesheet, staticFile, parseUpload, index, callback, requireUser, checkPost,
        overview, modulesHub, cases, caseDetail, appeals, staff, audit, modulePage, moduleAction, logout, notFound, setTheme,
        sessions, states, confirms, enforcement: enforcementHandlers,
    };
}

/** Wraps an async handler so a thrown error becomes a plain 500 page (and a log line). */
function safe(handler) {
    return async (req, res, next) => {
        try {
            return await handler(req, res, next);
        } catch (error) {
            logger.error(`Dashboard ${req.method} ${req.path} failed: ${error.message}`);
            if (res.headersSent) return undefined;
            // After a form, say what matters: the change may not be saved (never a silent failure).
            const message = req.method === 'POST'
                ? 'Your change may not have been saved. Reload the page to check, then try again.'
                : 'The page could not be loaded. Try again in a moment.';
            return res.status(500).type('html').send(messagePage('Something went wrong', message));
        }
    };
}

/**
 * express.raw for multipart bodies with a hard limit; a body that is too large (or
 * broken) becomes a plain error page instead of Express's default error output.
 */
export function uploadBody(limitBytes) {
    const raw = express.raw({ type: 'multipart/form-data', limit: limitBytes });
    return (req, res, next) => raw(req, res, (error) => {
        if (!error) return next();
        const tooLarge = error.status === 413 || error.type === 'entity.too.large';
        return res.status(tooLarge ? 413 : 400).type('html')
            .send(messagePage(tooLarge ? 'Too large' : 'Upload refused', tooLarge ? 'The image is larger than 8 MB.' : 'The upload could not be read.'));
    });
}

/** Adds the /dashboard routes (and the /staff redirect) when enabled. Returns true when registered. */
export function registerDashboard(app, client, env = process.env, { sessions = null } = {}) {
    const settings = dashboardSettings(env);
    if (!settings.requested) return false;
    if (!settings.enabled) {
        logger.error(`Dashboard NOT enabled: ${settings.problems.join('; ')}`);
        return false;
    }
    const d = createDashboard({ client, settings, sessions: sessions || createPgSessionStore({ query, table: pgConfig.tables.dashboard_sessions }) });
    const router = express.Router();
    const user = safe(d.requireUser);
    router.use(d.securityHeaders);
    router.get('/static/:file', d.staticFile);
    router.get('/theme', d.limitByIp, d.setTheme);
    router.get('/', d.limitByIp, safe(d.index));
    router.get('/oauth/callback', d.limitByIp, safe(d.callback));
    router.post('/logout', express.urlencoded({ extended: false, limit: '2kb' }), user, safe(d.logout));
    // Phase 3 forms (enforcement and records): registered before the settings catch-all.
    const form = express.urlencoded({ extended: false, limit: '16kb' });
    const en = d.enforcement;
    router.post('/users/:id/action/preview', form, user, safe(en.actionPreview));
    router.post('/users/:id/action/execute', form, user, safe(en.actionExecute));
    router.post('/users/bulk/preview', form, user, safe(en.bulkPreview));
    router.post('/users/bulk/execute', form, user, safe(en.bulkExecute));
    router.post('/users/:id/roles/add', form, user, safe(en.roleAdd));
    router.post('/users/:id/roles/remove', form, user, safe(en.roleRemove));
    router.post('/users/:id/nickname', form, user, safe(en.nickname));
    router.post('/users/:id/timeout', form, user, safe(en.timeout));
    router.post('/users/:id/unverify', form, user, safe(en.unverify));
    router.post('/users/:id/notes/add', form, user, safe(en.noteAdd));
    router.post('/users/:id/notes/remove', form, user, safe(en.noteRemove));
    router.post('/cases/:code/edit', form, user, safe(en.caseEdit));
    router.post('/cases/:code/void', form, user, safe(en.caseVoid));
    router.post('/cases/:code/evidence/add', form, user, safe(en.evidenceAdd));
    // Image upload: login is checked first (cookie only), so an anonymous request is refused before
    // any of the body is read; then the raw body, capped at 8 MB + 64 kB of form overhead.
    router.post('/cases/:code/evidence/upload', user, uploadBody(MAX_UPLOAD_BYTES + 64 * 1024), safe(d.parseUpload), safe(en.evidenceUpload));
    router.post('/cases/:code/evidence/remove', form, user, safe(en.evidenceRemove));
    router.post('/appeals/:code/preview', form, user, safe(en.appealPreview));
    router.post('/appeals/:code/decide', form, user, safe(en.appealDecide));
    router.post('/nocontact/add', form, user, safe(en.noContactAdd));
    router.post('/nocontact/end', form, user, safe(en.noContactEnd));
    router.post('/staff/blocks/lift', form, user, safe(en.blockLift));
    // Settings forms: the body parser is mounted here only (32 kB, no nested objects).
    router.post('/:module/:action', express.urlencoded({ extended: false, limit: '32kb' }), user, safe(d.moduleAction));
    router.get('/overview', user, safe(d.overview));
    router.get('/modules', user, safe(d.modulesHub));
    router.get('/cases', user, safe(d.cases));
    router.get('/cases/:code', user, safe(d.caseDetail));
    router.get('/appeals', user, safe(d.appeals));
    router.get('/appeals/:code', user, safe(en.appealDetail));
    router.get('/users', user, safe(en.users));
    router.get('/users/bulk/:job', user, safe(en.bulkJob));
    router.get('/users/:id', user, safe(en.userPage));
    router.get('/nocontact', user, safe(en.noContact));
    router.get('/staff', user, safe(d.staff));
    router.get('/audit', user, safe(d.audit));
    router.get('/:module', user, safe(d.modulePage));
    router.use(user, d.notFound);
    app.use(BASE, router);
    // The old read-only staff dashboard lived at /staff.
    app.use('/staff', (req, res) => res.redirect(301, BASE));
    logger.info(`Dashboard enabled at ${BASE} (OAuth redirect ${settings.redirectUri}; editing ${settings.editEnabled ? 'ON' : 'off (DASHBOARD_EDIT_ENABLED)'})`);
    return true;
}
