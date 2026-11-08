// routes.js — the web dashboard on the bot's Express server (Phase 1: login, overview,
// records; Phase 2: module settings pages with editing).
//
// Multi-server (B3, docs/multi-server-b3.md): every server page lives under /dashboard/<guildId>/…
// (the paths below are relative to that), served by that server's own createDashboard instance
// (guildDashboards.js). Global routes, never under a server: /static/*, /theme, /lang, /nav,
// /oauth/callback, /logout, /owner/* and /dashboard itself (the server picker, serverPicker.js).
// Old links without a server id: GET 302, POST 307 to the same page of MAIN_GUILD_ID; the
// support server's id 302s to the main server (home servers count as one). An invalid id, a
// server the bot is not in, a blacklisted server or no access there: one uniform 404.
//
//   GET  /dashboard                 → the server picker when logged in, else Discord login (?r=<return path>)
//   GET  /dashboard/oauth/callback  Discord OAuth2 (scopes identify guilds) comes back here
//   GET  /dashboard/overview        bot / database / server status, Getting started checklist
//   GET  /dashboard/cases           case search (the /case search filters), paged
//   GET  /dashboard/cases/:code     one case: details, edit history, evidence, appeals
//   GET  /dashboard/appeals         pending appeals of the main server with their age
//   GET  /dashboard/inbox           everything waiting for staff (inboxRoutes.js); /inbox/modmail|ticket/:id read, reply, close
//   GET  /dashboard/staff           staff moderation stats (/staff stats), weekly activity, discipline (owners)
//   GET  /dashboard/audit           dashboard changes (old → new), filter by user/module, paged
//   GET  /dashboard/incidents       raid timeline: join-raid lockdowns of the last 90 days (incidentRoutes.js);
//                                   /incidents/:id one incident minute by minute (Administrator-only)
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
//   POST /dashboard/<module>/<act> with multipart/form-data: only actions marked `upload` (the
//                                   Welcome & goodbye images); login first, then the 8 MB body,
//                                   then the same checks as every settings form
//   GET/POST /dashboard/fix-permissions  Mewvo gives itself missing permissions in one channel
//                                   (permissionFixRoutes.js: confirm page, then Administrator-only POST)
//   POST /dashboard/logout          CSRF token + same-origin check, then back to the website (/)
//   /dashboard/owner/…              the Owner area (ownerRoutes.js): bot profile, servers, users,
//                                   blacklist, health + maintenance, command sync, announce, and
//                                   the Website editor (websiteRoutes.js: site text and images).
//                                   Recent errors (ownerErrors.js: grouped error_events, read-only).
//                                   OWNER_IDS only (checked live on every request; anyone else
//                                   gets 404), POSTs also need a login younger than 12 h.
//   /staff, /staff/*                → 301 /dashboard (the old read-only staff dashboard)
//
// Access (per server, access.js): CURRENT Administrators of that server (canAct), OWNER_IDS
// (view and settings only) and members with the server's moderator role (the Moderator level:
// only what permissions.js marks MODERATOR; every other page/action → 403), re-checked on
// every request (cached, access.js; every POST checks fresh). Anyone may log in; the picker
// lists only what they may open. Losing access to one server 404s that server only: the
// session is kept. The login state is HMAC-signed, expires after 10 minutes, is single use,
// bound to the browser by a nonce cookie and carries the return path (checked again with
// safeBackPath). Sessions are in Postgres (sessionStore.js: hashed ids, rotated on login,
// 12 h); the browser only gets a signed random id in an HttpOnly, SameSite=Lax cookie (Secure
// in production / https). The Discord access token is used once to read the user and the
// server list (/users/@me/guilds, kept in memory only: serverPicker.js) and then dropped.
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
import { caseNotes } from '../enforcement/caseNotesService.js';
import { activitySeries, staffAnalytics } from '../stats/activityService.js';
import { activityPage, analyticsSection } from './activityPage.js';
import { casesCsv, exportCases, exportWindowDays } from '../enforcement/caseExport.js';
import { guildPlan } from '../billing/premiumEffects.js';
import { backupPage, backupPreviewPage } from './backupPages.js';
import { BACKUP_MAX_BYTES, applyBackup, exportSettings, planBackup } from '../settings/settingsBackup.js';
import { createHash, randomBytes } from 'node:crypto';
import { listEvidence, resolveImageUrls } from '../enforcement/evidenceService.js';
import { listPendingAppeals } from '../enforcement/appealService.js';
import { needsSecondReviewer } from '../enforcement/appealReviewer.js';
import { STATS_PERIODS, staffModerationStats } from '../staffActivityService.js';
import {
    isOtherGuild, listSettingsAudit, refreshGuildSettings, resolveSetting, settingsFor,
} from '../settings/guildSettings.js';
import { createAccessChecker } from './access.js';
import { OWNER_AREA, allows, routeKey } from './permissions.js';
import {
    BASE, NAV_COOKIE, THEME_COOKIE, currentGuildId, guildPath, html, messagePage, navModeFrom, path, queryString, rootPath, runInGuild, themeFrom,
} from './html.js';
import { isHomeOnlyPage } from './homeOnly.js';
import { createGuildDashboards, createLruCache, scopedConfirms } from './guildDashboards.js';
import { collectPicker, createGuildListCache, guildListFrom, pickerPage } from './serverPicker.js';
import { blacklistHit } from '../owner/blacklistCache.js';
import { getBotOwners } from '../../config/bot.js';
import {
    currentLanguage, dashboardLanguage, dashboardText, languageContext, rememberDiscordLocale, setRequestLanguage,
} from './language.js';
import { languageCookie } from '../site/language.js';
import { LANG_CODES } from '../site/i18n.js';
import { glossaryPage, setupPage } from './helpPages.js';
import { setupStepData } from './setupForms.js';
import {
    appealsPage, auditPage, caseDetailPage, casesPage, moduleSettingsPage, statsPage,
} from './pages.js';
import { collectChecklist, collectOverview, defaultOverviewData, moduleStatesFrom, overviewPage } from './overview.js';
import { modulesPage } from './modulesPage.js';
import { MODULES, getAction, getModule } from './modules/index.js';
import { MODULE_COMMANDS, moduleCommandsSection } from './modules/commands.js';
import { topic } from './modules/common.js';
import { defaultServices } from './services.js';
import { AUDIT_PAGE_SIZE, createAuditStore, recordDashboardChange } from './audit.js';
import { defaultEnforcement } from './enforcementData.js';
import { createEnforcementHandlers } from './enforcementRoutes.js';
import { createInboxBadge, createInboxHandlers } from './inboxRoutes.js';
import { collectInbox, defaultInboxData } from './inboxData.js';
import { createMemberToolsHandlers, defaultMemberTools } from './memberToolsRoutes.js';
import { createIncidentHandlers, defaultIncidents } from './incidentRoutes.js';
import { createConfirmStore } from './confirmTokens.js';
import { confirmPage } from './enforcementPages.js';
import { createPermissionFixHandlers } from './permissionFixRoutes.js';
import { createOwnerHandlers, defaultOwnerDeps } from './ownerRoutes.js';
import { createWebsiteHandlers, defaultWebsiteDeps } from './websiteRoutes.js';
import { createOwnerErrorsHandlers, defaultErrorPageDeps } from './ownerErrors.js';
import { IMAGE_MAX_BYTES as SITE_IMAGE_MAX_BYTES } from '../site/siteImages.js';
import { InputError, plainText } from './forms.js';
import { createMemberSearch, memberSearchPage, searchJson, searchParams } from './memberSearch.js';
import { MAX_UPLOAD_BYTES, MultipartError, parseMultipart } from './multipart.js';
import { createPgSessionStore } from './sessionStore.js';
import { query } from '../enforcement/db.js';
import { pgConfig } from '../../config/database/postgres.js';
import {
    MIN_SECRET_LENGTH, SESSION_COOKIE, SESSION_TTL_MS, STATE_COOKIE, STATE_TTL_MS,
    clearCookie, createRateLimiter, createState, createStateStore, guildSegment,
    isSameOrigin, isSnowflake, parseCookies, safeEqual, serializeCookie, signValue, verifySignedValue,
} from './security.js';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const ME_URL = 'https://discord.com/api/v10/users/@me';
const GUILDS_URL = 'https://discord.com/api/v10/users/@me/guilds';
/** The OAuth2 scopes of the dashboard login: who you are, and which servers you are in (for the picker). */
export const OAUTH_SCOPES = 'identify guilds';
/** First path segments below /dashboard that are global routes, never a server or an old link. */
export const GLOBAL_SEGMENTS = Object.freeze(['static', 'theme', 'lang', 'nav', 'oauth', 'logout', 'owner']);
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
    // connect-src 'self': the member type-ahead (dashboard.js) reads /dashboard/members/search.json.
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' https://cdn.discordapp.com https://media.discordapp.net; "
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
    { key: 'nocontact', label: 'Keep apart' },
    { key: 'watchlist', label: 'Watchlist' },
    { key: 'massguard', label: 'Safety limit (bans/kicks)' },
    { key: 'staff', label: 'Staff discipline' },
    { key: 'owner', label: 'Owner area' },
    { key: 'inbox', label: 'Inbox (replies, closes)' },
    { key: 'members', label: 'Members' },
    { key: 'rolerules', label: 'Role rules' },
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
        // The support server's dashboard is the main server's (home servers count as one): its id redirects.
        supportGuildId: env.SUPPORT_GUILD_ID !== undefined ? String(env.SUPPORT_GUILD_ID).trim() : (enforcementConfig.supportGuildId || ''),
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
    return isSafeDashboardPath(text) ? text : path('/overview');
}

function isSafeDashboardPath(text) {
    return /^\/dashboard(\/[A-Za-z0-9_\-/]*)?(\?[A-Za-z0-9_\-=&%.]*)?$/.test(text) && !text.includes('//');
}

/**
 * Where a login comes back to: a safe dashboard path (safeBackPath's rule, at most 300
 * characters), else the server picker. Never an absolute URL, `//host`, `..` or another site.
 */
export function safeReturnPath(value) {
    const text = typeof value === 'string' ? value : '';
    return text.length <= 300 && isSafeDashboardPath(text) ? text : rootPath();
}

/** A request path with %-escapes decoded and empty segments (//) dropped; '' when it cannot be decoded. */
function decodedPath(value) {
    try {
        return decodeURIComponent(String(value || '')).replace(/\/{2,}/g, '/');
    } catch {
        return '';
    }
}

/** Express 5 may hand over arrays for repeated keys: keep strings only. */
function str(value, max = 200) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const defaultData = {
    searchCaseRecords, getCaseByCode, getCaseEdits, listEvidence, resolveImageUrls, getAppealHistory,
    listCaseNotes: (code) => caseNotes.listNotes(code, 50),
    activitySeries: (guildId) => activitySeries(guildId),
    staffAnalytics: (guildId) => staffAnalytics(guildId),
    exportCases: (guildId, planId) => exportCases(guildId, planId),
    guildPlan: (guildId) => guildPlan(guildId),
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

/**
 * Before a non-home server's pages render: its settings row must be in the cache (A3's
 * resolveSetting throws SettingsUnavailableError otherwise). Reads it once when missing; throws
 * SettingsUnavailableError (with a userMessage) when the database does not answer. Home
 * servers: nothing to do (loadAllSettings at startup).
 */
export async function ensureGuildSettings(guildId, env = process.env) {
    if (!isOtherGuild(guildId, env)) return;
    try {
        settingsFor(guildId, env);
    } catch (error) {
        if (error?.name !== 'SettingsUnavailableError') throw error;
        await refreshGuildSettings(guildId, env);
    }
}

function clientIp(req) {
    return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

// The static files (read once, shared by every server's instance): the stylesheet and the one
// script (progressive enhancement, CSP script-src 'self'). Nothing else is served.
let staticFileCache = null;
function staticFiles() {
    staticFileCache ??= new Map(Object.entries(STATIC_FILES).map(([name, type]) => {
        try {
            const body = fs.readFileSync(new URL(`./static/${name}`, import.meta.url), 'utf8');
            // The same short hash as the ?v= in html.js (CSS_PATH / JS_PATH): that URL is cached for a year.
            return [name, { type, body, version: createHash('sha256').update(body).digest('hex').slice(0, 10) }];
        } catch (error) {
            logger.error(`Dashboard static file missing (${name}): ${error.message}`);
            return [name, { type, body: '', version: null }];
        }
    }));
    return staticFileCache;
}

/** The rate limiters shared by every server's instance (one budget per session / IP, not per server). */
export function createDashboardLimiters(limits = DEFAULT_LIMITS) {
    return {
        session: createRateLimiter(limits.session),
        ip: createRateLimiter(limits.ip),
        static: createRateLimiter(limits.static),
        post: createRateLimiter(limits.post || DEFAULT_LIMITS.post),
    };
}

/**
 * One server's dashboard handlers (multi-server B3: one instance per server, guildDashboards.js),
 * with everything injectable for tests:
 * { client, settings, sessions, access, data, fetchImpl, states, limits, guildId }.
 * `guildId` defaults to MAIN_GUILD_ID (settings.mainGuildId); every handler is bound to it.
 * `sessions` is required (createPgSessionStore in production, a memory store in tests).
 * Shared between instances (createDashboardApp passes them): sessions, states, limiters,
 * auditStore, confirms (scoped per server here), memberSearch, guildLists; `picker` renders
 * GET /dashboard for a logged-in user.
 */
export function createDashboard({
    client, settings, sessions, guildId: boundGuildId = null,
    access = createAccessChecker(client, { guildId: boundGuildId || settings.mainGuildId }), data = defaultData,
    fetchImpl = globalThis.fetch, states = createStateStore(), limits = DEFAULT_LIMITS, limiters = null,
    services = defaultServices, auditStore = null, modules = MODULES, env = process.env,
    enforcement = defaultEnforcement, confirms: confirmStore = createConfirmStore(), owner = defaultOwnerDeps,
    inbox = defaultInboxData, inboxBadge = false,
    memberTools = defaultMemberTools, incidents = defaultIncidents, website = defaultWebsiteDeps,
    memberSearch = createMemberSearch(), ownerErrors = defaultErrorPageDeps,
    guildLists = createGuildListCache(), picker = null, settingsReady = ensureGuildSettings,
}) {
    const secret = settings.sessionSecret;
    const guildId = boundGuildId || settings.mainGuildId;
    // Mewvo's own servers (main + support): the home-only pages (homeOnly.js) exist only here.
    const isHomeServer = guildId === settings.mainGuildId || Boolean(settings.supportGuildId && guildId === settings.supportGuildId);
    // Confirm tokens of this server only: subjects are prefixed with the guild id.
    const confirms = scopedConfirms(confirmStore, guildId);
    const shared = limiters || createDashboardLimiters(limits);
    const sessionLimiter = shared.session;
    const ipLimiter = shared.ip;
    const staticLimiter = shared.static;
    const postLimiter = shared.post;
    const audits = auditStore || createAuditStore();
    const moduleList = modules;
    // A home-only module (homeOnly.js) does not exist in other servers: every handler that looks a
    // module up by the (decoded) :module param gets null there, so page, form and upload all 404.
    const findModule = (key) => {
        const module = modules === MODULES ? getModule(key) : modules.find((m) => m.key === key) || null;
        return module && !isHomeServer && isHomeOnlyPage(module.key) ? null : module;
    };
    const cookieOptions = { secure: settings.secure, path: BASE };
    let moduleStatesCache = { at: 0, value: {} };
    // The Inbox total on the sidebar (registerDashboard turns it on): cached, refreshed in the background.
    const badge = inboxBadge ? createInboxBadge({ load: async () => (await collectInbox({ client, guildId, inbox })).total }) : null;

    const sendHtml = (res, status, page) => res.status(status).type('html').send(page);
    // `lang`: the page's language when there is no req to read it from (login errors keep their old shell).
    const fail = (res, status, title, message, req = null, lang = null) => sendHtml(res, status, messagePage(title, message, req?.dashboard?.session || null, { ...shellOf(req), ...(lang ? { lang } : {}) }));
    /** The translator of a request: its resolved language (requireUser), else cookie / Accept-Language. */
    const textOfReq = (req) => dashboardText(req?.dashboard?.lang || (req?.headers ? dashboardLanguage(req) : currentLanguage()));
    /** fail() with catalog words: errors.<titleKey> / errors.<messageKey>. `from` reads the language without changing the shell. */
    const failT = (res, status, titleKey, messageKey, req = null, params = {}, from = req) => {
        const tr = textOfReq(from);
        return fail(res, status, tr.t(`errors.${titleKey}`), tr.t(`errors.${messageKey}`, params), req, tr.lang);
    };

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

    /** Owner-area changes are for the bot owners' eyes only (Audit page, Overview). */
    function hiddenAuditModules(req) {
        return (owner.isBotOwner || defaultOwnerDeps.isBotOwner)(req.dashboard?.session?.userId) ? [] : ['owner', 'website'];
    }

    function shellOf(req) {
        const ctx = req?.dashboard;
        if (!ctx) return req ? { session: null, theme: themeOf(req), lang: dashboardLanguage(req) } : {};
        // A copy of the session with display-only extras for the page shell. isOwner (live
        // OWNER_IDS check) shows the Owner sidebar group.
        const session = {
            ...ctx.session, theme: themeOf(req), navMode: navModeFrom(parseCookies(req?.headers?.cookie)[NAV_COOKIE]), server: serverInfo(), path: safeBackPath(req.originalUrl || req.url),
            isOwner: Boolean((owner.isBotOwner || defaultOwnerDeps.isBotOwner)(ctx.session.userId)),
            // Global pages (picker, Owner area) have no server: the sidebar's server parts stay off.
            ...(ctx.guildId === null ? { server: null } : {}),
            isHomeServer, guildId: ctx.guildId ?? guildId,
            inboxCount: badge && ctx.guildId !== null ? badge.peek() : null,
            lang: ctx.lang || dashboardLanguage(req, ctx.session.userId),
        };
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
            return failT(res, 429, 'slowDown', 'loginAttempts', null, {}, req);
        }
        return next();
    }

    function serveStatic(name, req, res) {
        if (!staticLimiter.allow(clientIp(req))) return res.status(429).type('text/plain').send('Too many requests');
        const file = staticFiles().get(name);
        if (!file) return res.status(404).type('text/plain').send('Not found');
        res.set('Cache-Control', file.version && req.query?.v === file.version ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
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
            return fail(res, error.status, textOfReq(req).t(error.status === 413 ? 'errors.tooLarge' : 'errors.uploadRefused'), error.userMessage, req);
        }
        return next();
    }

    /**
     * To Discord's authorize page. `returnTo`: the dashboard page to open afterwards (signed in
     * the state; the picker when absent). `prompt: 'none'` (Refresh server list): no consent
     * screen again for a user who already authorized these scopes (Discord OAuth2 docs).
     */
    function startLogin(req, res, { returnTo = null, prompt = null } = {}) {
        const target = returnTo ? safeReturnPath(returnTo) : null;
        const { state, nonce } = createState(secret, Date.now(), { returnTo: target && target !== rootPath() ? target : null });
        res.append('Set-Cookie', serializeCookie(STATE_COOKIE, nonce, { ...cookieOptions, maxAgeMs: STATE_TTL_MS }));
        const params = new URLSearchParams({
            client_id: settings.clientId,
            response_type: 'code',
            redirect_uri: settings.redirectUri,
            scope: OAUTH_SCOPES,
            state,
        });
        if (prompt === 'none') params.set('prompt', 'none');
        return res.redirect(302, `${AUTHORIZE_URL}?${params}`);
    }

    /**
     * GET /dashboard: the server picker when logged in (?refresh=1: log in again silently to
     * reload the server list); else the Discord login, coming back to ?r=<dashboard path>.
     */
    async function index(req, res) {
        const session = await readSession(req);
        if (!session) return startLogin(req, res, { returnTo: str(req.query?.r, 300) || null });
        if (str(req.query?.refresh, 1) === '1') return startLogin(req, res, { prompt: 'none' });
        if (typeof picker === 'function') return picker(req, res, session);
        return res.redirect(302, path('/overview'));
    }

    /** The user's servers from Discord (GET /users/@me/guilds), or null when Discord did not answer. */
    async function fetchGuildList(accessToken) {
        try {
            const raw = await discordFetch(fetchImpl, GUILDS_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
            return guildListFrom(raw, { botHas: (id) => Boolean(client.guilds?.cache?.has?.(id)) });
        } catch (error) {
            logger.warn(`Dashboard login: server list not read: ${error.message}`);
            return null;
        }
    }

    async function callback(req, res) {
        const cookies = parseCookies(req.headers?.cookie);
        res.append('Set-Cookie', clearCookie(STATE_COOKIE, cookieOptions));
        if (req.query?.error) return failT(res, 400, 'loginCancelled', 'loginCancelledText', null, { base: BASE }, req);
        const code = str(req.query?.code, 200);
        const taken = code ? (states.take || ((...a) => (states.consume(...a) ? { returnTo: null } : null)))(str(req.query?.state, 1000), cookies[STATE_COOKIE], secret) : null;
        if (!taken) {
            return failT(res, 400, 'loginExpired', 'loginExpiredText', null, { base: BASE }, req);
        }
        let me;
        let guildList = null;
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
            // The server list for the picker, read once with the same token (then the token is dropped).
            if (isSnowflake(String(me?.id || ''))) guildList = await fetchGuildList(token.access_token);
        } catch (error) {
            logger.warn(`Dashboard login failed: ${error.message}`);
            return failT(res, 502, 'loginFailed', 'loginNotConfirmed', null, {}, req);
        }
        if (!isSnowflake(String(me?.id || ''))) return failT(res, 502, 'loginFailed', 'loginNoUser', null, {}, req);
        // The Discord account's language (identify gives `locale`): used when no language cookie is set.
        rememberDiscordLocale(me.id, me.locale);
        access.forget?.(me.id);
        // Anyone may log in (owner decision 6): the picker lists what they may open, and every
        // server page checks access on its own.
        const session = await sessions.rotate(cookieSessionId(req), {
            userId: me.id,
            username: me.global_name || me.username || me.id,
            avatar: typeof me.avatar === 'string' ? me.avatar : null,
        });
        res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, signValue(session.id, secret), { ...cookieOptions, maxAgeMs: SESSION_TTL_MS }));
        // Keyed by the user: a new login replaces the list (never one list per session).
        if (guildList) guildLists.set(String(session.userId), guildList);
        logger.info(`Dashboard login: ${me.id} (${guildList ? `${guildList.length} server(s) listed` : 'server list unavailable'})`);
        return res.redirect(303, safeReturnPath(taken.returnTo));
    }

    /** One uniform 404 for a server that is not there for this user (bad id, bot absent, blacklisted, no access). */
    const serverNotFound = (req, res) => failT(res, 404, 'serverNotFound', 'serverNotFoundText', req?.dashboard ? req : null, {}, req);

    /** The access decision; `fresh` (every POST) skips the cache (A2's checkFresh when present). */
    async function accessDecision(userId, { fresh = false } = {}) {
        if (fresh) {
            if (typeof access.checkFresh === 'function') return access.checkFresh(userId, { guildId });
            if (typeof access.forget === 'function') access.forget(userId, guildId);
        }
        return access.check(userId, { guildId });
    }

    /** Session + rate limit + live permission check for every page. */
    async function requireUser(req, res, next) {
        const session = req.dashboardSession || await readSession(req);
        if (!session) {
            if (req.method === 'GET') return res.redirect(302, loginRedirect(req));
            return failT(res, 401, 'loggedOut', 'loggedOutText', null, { base: BASE }, req);
        }
        if (!req.dashboardSession && !sessionLimiter.allow(session.idHash)) {
            res.set('Retry-After', '60');
            return failT(res, 429, 'slowDown', 'tooManyRequests', null, {}, req);
        }
        // Every POST checks access fresh (owner decision 2); GETs use the access cache.
        const decision = await accessDecision(session.userId, { fresh: req.method === 'POST' });
        if (!decision.allowed) {
            // Lost access to THIS server (or never had it): 404 here only; the session is kept,
            // so the user's other servers keep working.
            logger.info(`Dashboard ${req.method} in ${guildId} refused for ${session.userId}: ${decision.reason}`);
            return serverNotFound(req, res);
        }
        // The page language: cookie → the Discord account's language → Accept-Language → English.
        const lang = dashboardLanguage(req, session.userId);
        setRequestLanguage(lang);
        req.dashboard = { session, access: decision, guildId, moduleStates: await moduleStates().catch(() => ({})), flash: null, lang };
        // A non-home server's settings must be readable before its pages render (never defaults).
        try {
            await settingsReady(guildId, env);
        } catch (error) {
            if (error?.name !== 'SettingsUnavailableError') throw error;
            logger.warn(`Dashboard ${req.method} in ${guildId}: ${error.message}`);
            return fail(res, 503, textOfReq(req).t('errors.serverUnavailable'), error.userMessage, req);
        }
        // Home-only pages (support module, settings backup) do not exist in other servers.
        // The path check sees the decoded path too (%73upport); findModule refuses the module itself.
        if (!isHomeServer && (isHomeOnlyPage(req.path) || isHomeOnlyPage(decodedPath(req.path)))) return notFound(req, res);
        // The level's permissions (permissions.js): one table for every route; unknown paths are
        // Administrator-only. The Owner area keeps its own check (requireOwner, 404).
        const key = routeKey(req.method, req.path);
        if (key !== OWNER_AREA && !allows(decision, key)) {
            logger.info(`Dashboard ${req.method} ${req.path} refused for ${session.userId} (${decision.role}): ${key || 'unknown page'} needs Administrator`);
            return decision.role === 'manager'
                ? fail(res, 403, textOfReq(req).t('errors.notAllowed'), textOfReq(req).t('general.access.managerOnly'), req)
                : failT(res, 403, 'notAllowed', 'moderatorOnly', req);
        }
        if (req.method === 'GET' && session.flash) {
            // One-shot message from the last saved form (POST → 303 → this GET).
            req.dashboard.flash = session.flash;
            await sessions.setFlash?.(session.id, null)?.catch?.(() => {});
        }
        return next();
    }

    /** Where a GET without a session goes: the login, coming back to this page afterwards. */
    function loginRedirect(req) {
        const back = safeReturnPath(String(req.originalUrl || ''));
        return back === rootPath() ? BASE : `${BASE}${queryString({ r: back })}`;
    }

    /**
     * Global pages (picker, logout): a session and the per-session limit, no server access.
     * req.dashboard.guildId is null and access is a no-access decision.
     */
    async function requireSession(req, res, next) {
        const session = await readSession(req);
        if (!session) {
            if (req.method === 'GET') return res.redirect(302, BASE);
            return failT(res, 401, 'loggedOut', 'loggedOutText', null, { base: BASE }, req);
        }
        if (!sessionLimiter.allow(session.idHash)) {
            res.set('Retry-After', '60');
            return failT(res, 429, 'slowDown', 'tooManyRequests', null, {}, req);
        }
        const lang = dashboardLanguage(req, session.userId);
        setRequestLanguage(lang);
        req.dashboard = { session, access: { allowed: false, canView: false, canAct: false, role: null }, guildId: null, moduleStates: {}, flash: null, lang };
        if (req.method === 'GET' && session.flash) {
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
        // The audit rows only for levels that may open the Audit log.
        const recentChanges = allows(req.dashboard.access, 'page:audit')
            ? await audits.list(guildId, { page: 0, pageSize: RECENT_CHANGES, excludeModules: hiddenAuditModules(req) }).then((r) => r.rows).catch(() => null)
            : [];
        let handover = null;
        try { handover = resolveSetting(guildId, 'staffHandoverNote', env); } catch { handover = null; }
        return sendHtml(res, 200, overviewPage({
            ...shellOf(req), overview: result, recentChanges, editEnabled: settings.editEnabled,
            handover, canEditHandover: Boolean(settings.editEnabled && allows(req.dashboard.access, 'staff.handover')),
            flash: req.dashboard.flash,
        }));
    }

    // ── Saved case searches (Cases page) ─────────────────────────────────
    const SEARCH_KEYS = ['member', 'moderator', 'type', 'status', 'text', 'from', 'to', 'tag'];
    // An unreadable setting throws (data-layer rule): a save must never start from a guessed empty list.
    const savedSearches = () => resolveSetting(guildId, 'savedCaseSearches', env) || [];
    function searchGuard(req, res) {
        if (!postLimiter.allow(req.dashboard.session.idHash)) { res.set('Retry-After', '60'); return failT(res, 429, 'slowDown', 'tooManyChanges', req); }
        if (!checkPost(req)) return failT(res, 403, 'notAllowed', 'csrf', req);
        if (!settings.editEnabled) return failT(res, 403, 'editingOff', 'editingOffText', req);
        if (!allows(req.dashboard.access, 'case.searches')) return failT(res, 403, 'notAllowed', 'needsStaffRole', req);
        return null;
    }
    const saveSearches = (req, list) => services.updateSettings(guildId, { savedCaseSearches: list },
        { userId: req.dashboard.session.userId, username: req.dashboard.session.username, module: 'cases' }, env);

    async function searchSave(req, res) {
        const refused = searchGuard(req, res);
        if (refused) return refused;
        const name = str(req.body?.name, 60).replace(/\s+/g, ' ').trim();
        const query = Object.fromEntries(SEARCH_KEYS.map((k) => [k, str(req.body?.[k], 100)]).filter(([, v]) => v));
        const tr = textOfReq(req);
        if (!name || name.length > 40) return fail(res, 400, tr.t('general.search.notSaved'), tr.t('general.search.nameTooLong'), req);
        if (!Object.keys(query).length) return fail(res, 400, tr.t('general.search.notSaved'), tr.t('general.search.filterFirst'), req);
        try {
            normalizeSearchFilters({ memberId: query.member, moderatorId: query.moderator, type: query.type, status: query.status, text: query.text, from: query.from, to: query.to, tag: query.tag });
        } catch (error) {
            return fail(res, 400, tr.t('general.search.notSaved'), error.userMessage || tr.t('general.search.invalid'), req);
        }
        const list = savedSearches().filter((s) => s.name.toLowerCase() !== name.toLowerCase());
        if (list.length >= 20) return fail(res, 400, tr.t('general.search.notSaved'), tr.t('general.search.full'), req);
        await saveSearches(req, [...list, { name, query }]);
        await sessions.setFlash?.(req.dashboard.session.id, tr.t('general.search.saved', { name }));
        return res.redirect(303, path(`/cases${queryString(query)}`));
    }

    async function searchDelete(req, res) {
        const refused = searchGuard(req, res);
        if (refused) return refused;
        const name = str(req.body?.name, 60);
        const list = savedSearches();
        const tr = textOfReq(req);
        if (!list.some((s) => s.name === name)) return fail(res, 400, tr.t('general.search.notDeleted'), tr.t('general.search.gone'), req);
        await saveSearches(req, list.filter((s) => s.name !== name));
        await sessions.setFlash?.(req.dashboard.session.id, tr.t('general.search.deleted', { name }));
        return res.redirect(303, path('/cases'));
    }

    /** POST /handover: the staff note on the Overview (moderators and admins); empty text clears it. */
    async function handover(req, res) {
        const session = req.dashboard.session;
        if (!postLimiter.allow(session.idHash)) { res.set('Retry-After', '60'); return failT(res, 429, 'slowDown', 'tooManyChanges', req); }
        if (!checkPost(req)) return failT(res, 403, 'notAllowed', 'csrf', req);
        if (!settings.editEnabled) return failT(res, 403, 'editingOff', 'editingOffText', req);
        if (!allows(req.dashboard.access, 'staff.handover')) return failT(res, 403, 'notAllowed', 'needsStaffRole', req);
        const text = str(req.body?.text, 1200).replace(/\r\n?/g, '\n').trim();
        if (text.length > 1000) return failT(res, 400, 'tooLong', 'handoverTooLong', req);
        const value = text ? { text, by: session.userId, byName: String(session.username || '').slice(0, 100), at: new Date().toISOString() } : null;
        await services.updateSettings(guildId, { staffHandoverNote: value }, { userId: session.userId, username: session.username, module: 'staff' }, env);
        await sessions.setFlash?.(session.id, textOfReq(req).t(text ? 'overview.handover.saved' : 'overview.handover.cleared'));
        return res.redirect(303, path('/overview'));
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
            tag: str(req.query?.tag, 21),
        };
        const page = Math.min(MAX_PAGE, Math.max(0, Number.parseInt(str(req.query?.page, 6), 10) || 0));
        let filters;
        try {
            filters = normalizeSearchFilters({
                memberId: query.member, moderatorId: query.moderator, type: query.type, status: query.status,
                text: query.text, from: query.from, to: query.to, tag: query.tag,
            });
        } catch (error) {
            return sendHtml(res, 400, casesPage({ ...shellOf(req), query, error: error.userMessage || textOfReq(req).t('general.cases.invalidFilter') }));
        }
        const { rows, total } = await data.searchCaseRecords(guildId, filters, { page, pageSize: CASES_PAGE_SIZE });
        const appealStatuses = await data.getLatestAppealStatusesForCases(rows.map((row) => row.case_code));
        const planId = data.guildPlan ? data.guildPlan(guildId) : 'free';
        // Saved searches unreadable (settings not loaded): the cases still show, but no saved
        // list and no Save button (a save must never start from a guessed empty list).
        let saved = null;
        try {
            saved = savedSearches();
        } catch (error) {
            if (error?.name !== 'SettingsUnavailableError') throw error;
            logger.warn(`Dashboard cases in ${guildId}: saved searches not read: ${error.message}`);
        }
        return sendHtml(res, 200, casesPage({
            ...shellOf(req), query, rows, total, page, pageSize: CASES_PAGE_SIZE, exportDays: exportWindowDays(planId), canExport: allows(req.dashboard.access, 'case.export'),
            canBulk: Boolean(settings.editEnabled && allows(req.dashboard.access, 'case.edit')), flash: req.dashboard.flash,
            saved: saved || [], canSaveSearch: Boolean(saved && settings.editEnabled && allows(req.dashboard.access, 'case.searches')),
            statusLabel: (row) => caseStatusLabel(row, appealStatuses.get(row.case_code)),
        }));
    }

    /** GET /cases/export.csv: a paid perk, by the server owner's plan (caseExport.js). */
    async function casesExport(req, res) {
        // The route gate already maps this path to case.export; checked again here (defence in depth).
        if (!allows(req.dashboard.access, 'case.export')) return fail(res, 403, textOfReq(req).t('errors.notAllowed'), textOfReq(req).t('general.cases.exportAdmin'), req);
        const planId = data.guildPlan ? data.guildPlan(guildId) : 'free';
        const rows = await data.exportCases(guildId, planId);
        if (rows === null) {
            return fail(res, 403, textOfReq(req).t('general.cases.exportFree'), textOfReq(req).t('general.cases.exportFreeText'), req);
        }
        logger.info(`Dashboard case export by ${req.dashboard.session.userId}: ${rows.length} case(s), plan ${planId}`);
        await audits.writeRows(guildId, { userId: req.dashboard.session.userId, username: req.dashboard.session.username }, 'cases',
            [{ key: 'export', old: null, new: `${rows.length} cases (${Number.isFinite(exportWindowDays(planId)) ? `last ${exportWindowDays(planId)} days` : 'full history'})` }])
            .catch((error) => logger.error(`Dashboard audit write failed (case export): ${error.message}`));
        res.set('Cache-Control', 'no-store');
        res.set('Content-Disposition', `attachment; filename="mewvo-cases-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.status(200).type('text/csv; charset=utf-8').send(`\ufeff${casesCsv(rows)}`);
    }

    async function renderCase(req, res, status = 200, { error = null } = {}) {
        const code = normalizeCaseCode(str(req.params?.code, 10));
        const record = code ? await data.getCaseByCode(code, guildId) : null;
        if (!record || record.guild_id !== guildId) return fail(res, 404, textOfReq(req).t('general.cases.notFound'), textOfReq(req).t('general.cases.notFoundText'), req);
        const [edits, evidenceRows, appeals, notes] = await Promise.all([
            data.getCaseEdits(code, 50),
            data.listEvidence(code),
            data.getAppealHistory(code),
            data.listCaseNotes ? data.listCaseNotes(code) : [],
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
            notes,
            top: actions.top,
            bottom: actions.bottom,
        }));
    }

    const caseDetail = (req, res) => renderCase(req, res);

    async function appeals(req, res) {
        const viewerId = req.dashboard.session.userId;
        const botUserId = client.user?.id || null;
        // Independent appeal review: mark the appeals the viewer issued (they cannot decide them).
        const rows = (await data.listPendingAppeals(100, guildId)).map((row) => ({
            ...row,
            needsSecondReviewer: needsSecondReviewer(row, { botUserId }) && String(row.moderator_id) === String(viewerId),
        }));
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

    // ── Settings backup ──────────────────────────────────────────────────
    const backupPlans = new Map(); // token → { plan, userId, at }: one use, 10 minutes
    const BACKUP_PLAN_TTL_MS = 10 * 60 * 1000;
    const canWriteSettings = (req) => Boolean(settings.editEnabled && req.dashboard.access.canAct);
    /** The same checks as every settings form; returns an error page or null. */
    function backupGuard(req, res) {
        if (!postLimiter.allow(req.dashboard.session.idHash)) { res.set('Retry-After', '60'); return failT(res, 429, 'slowDown', 'tooManyChanges', req); }
        if (!checkPost(req)) return failT(res, 403, 'notAllowed', 'csrf', req);
        if (!settings.editEnabled) return failT(res, 403, 'editingOff', 'editingOffText', req);
        if (!req.dashboard.access.canAct) return failT(res, 403, 'notAllowed', 'needsAdmin', req);
        return null;
    }

    function backup(req, res, status = 200, error = null) {
        return sendHtml(res, status, backupPage({ ...shellOf(req), canWrite: canWriteSettings(req), flash: status === 200 ? req.dashboard.flash : null, error }));
    }

    function backupDownload(req, res) {
        const file = exportSettings({ env });
        res.set('Cache-Control', 'no-store');
        res.set('Content-Disposition', `attachment; filename="mewvo-settings-${file.exportedAt.slice(0, 10)}.json"`);
        return res.status(200).type('application/json').send(`${JSON.stringify(file, null, 2)}\n`);
    }

    function backupPreview(req, res) {
        const refused = backupGuard(req, res);
        if (refused) return refused;
        const file = req.upload?.file;
        if (!file) return backup(req, res, 400, textOfReq(req).t('backups.route.chooseFile'));
        const plan = planBackup(file.data.toString('utf8'), { env });
        if (!plan.ok) return backup(req, res, 400, plan.error);
        const now = Date.now();
        for (const [t, v] of backupPlans) if (now - v.at > BACKUP_PLAN_TTL_MS) backupPlans.delete(t);
        const token = randomBytes(24).toString('base64url');
        backupPlans.set(token, { plan, userId: req.dashboard.session.userId, at: now });
        return sendHtml(res, 200, backupPreviewPage({ ...shellOf(req), plan, token }));
    }

    async function backupApply(req, res) {
        const refused = backupGuard(req, res);
        if (refused) return refused;
        const token = str(req.body?.token, 100);
        const entry = backupPlans.get(token);
        backupPlans.delete(token);
        if (!entry || entry.userId !== req.dashboard.session.userId || Date.now() - entry.at > BACKUP_PLAN_TTL_MS) {
            return backup(req, res, 400, textOfReq(req).t('backups.route.expired'));
        }
        const changed = await applyBackup(entry.plan, { userId: req.dashboard.session.userId, username: req.dashboard.session.username }, { env });
        moduleStatesCache = { at: 0, value: {} };
        logger.info(`Dashboard settings backup applied by ${req.dashboard.session.userId}: ${changed} change(s)`);
        await sessions.setFlash?.(req.dashboard.session.id, textOfReq(req).tp('backups.route.applied', changed));
        return res.redirect(303, path('/backup'));
    }

    async function activity(req, res) {
        let series = null;
        try {
            series = await data.activitySeries(guildId);
        } catch (error) {
            logger.warn(`Dashboard activity: ${error.message}`);
        }
        // Pro and Max (server owner's plan): per moderator and per automod rule.
        const planId = data.guildPlan ? data.guildPlan(guildId) : 'free';
        const locked = planId !== 'pro' && planId !== 'max';
        const analytics = locked || !data.staffAnalytics ? null : await data.staffAnalytics(guildId).catch((error) => {
            logger.warn(`Dashboard staff analytics: ${error.message}`);
            return null;
        });
        return sendHtml(res, series ? 200 : 503, activityPage({ ...shellOf(req), series, extra: analyticsSection({ analytics, locked }) }));
    }

    async function audit(req, res) {
        const userFilter = str(req.query?.user, 20);
        const moduleFilter = str(req.query?.module, 40);
        const filters = {
            user: isSnowflake(userFilter) ? userFilter : '',
            module: /^[a-z-]{1,40}$/.test(moduleFilter) ? moduleFilter : '',
        };
        const page = Math.min(MAX_PAGE, Math.max(0, Number.parseInt(str(req.query?.page, 6), 10) || 0));
        const [{ rows, total }, users] = await Promise.all([
            audits.list(guildId, { userId: filters.user || null, module: filters.module || null, excludeModules: hiddenAuditModules(req), page, pageSize: AUDIT_PAGE_SIZE }),
            audits.users(guildId).catch(() => []),
        ]);
        const tr = textOfReq(req);
        const auditLabel = (m) => {
            if (tr.lang === 'en') return m.label;
            if (tr.has(`general.auditModules.${m.key}`)) return tr.t(`general.auditModules.${m.key}`);
            return tr.has(`frame.nav.items.${m.key}`) ? tr.t(`frame.nav.items.${m.key}`) : m.label;
        };
        const moduleChoices = [...moduleList.map((m) => ({ key: m.key, label: m.label })), { key: 'appeals', label: 'Appeals (registry)' }, { key: 'logging', label: 'Logging' },
            ...ENFORCEMENT_AUDIT_MODULES]
            .filter((m, i, all) => all.findIndex((x) => x.key === m.key) === i)
            .map((m) => ({ ...m, label: auditLabel(m) }));
        return sendHtml(res, 200, auditPage({ ...shellOf(req), rows, total, page, pageSize: AUDIT_PAGE_SIZE, filters, users, modules: moduleChoices }));
    }

    /** What a module page / action sees: the guild, the services, who acts and what they may do. */
    function contextFor(req) {
        const { session, access: decision } = req.dashboard;
        // lang + t / ti / tb / tp / tpi / tx / fmtNumber / fmtDate / fmtDateTime / weekday / has (language.js dashboardText).
        return {
            ...textOfReq(req),
            client, guildId, env, services,
            guild: client.guilds?.cache?.get(guildId) || null,
            session, access: decision, csrf: session.csrf,
            // The page's query (GET only matters: e.g. Automod ?days=); module code validates what it reads.
            query: req.query || {},
            actor: { userId: session.userId, username: session.username },
            editEnabled: settings.editEnabled,
            canEdit: Boolean(settings.editEnabled && decision.canView),
            canAct: Boolean(decision.canAct),
            // An upload action's file ({ file: { data, … } | null }, parseMultipart), else null.
            upload: req.upload || null,
        };
    }

    const moduleRawBody = express.raw({ type: 'multipart/form-data', limit: MAX_UPLOAD_BYTES + 64 * 1024 });

    /**
     * For POST /dashboard/<module>/<act>, after requireUser (so an anonymous request is
     * refused before the body is read): a multipart body is read (8 MB cap) and parsed only
     * for actions marked `upload`; any other action refuses it unread. A broken or too-large
     * upload re-renders the module page with the error in that form. Other bodies pass on.
     */
    function moduleUploadBody(req, res, next) {
        if (!/^multipart\/form-data/i.test(String(req.headers?.['content-type'] || ''))) return next();
        const module = findModule(str(req.params?.module, 40));
        const action = module ? getAction(module, str(req.params?.action, 40)) : null;
        if (!module || !action) return failT(res, 404, 'notFound', 'noSuchForm', req);
        if (!action.upload) return failT(res, 415, 'uploadRefused', 'noFiles', req);
        const refuse = (status, message) => renderModule(req, res, module, status, { error: message, errorAction: str(req.params?.action, 40), errorField: 'image' });
        const parse = (error) => {
            if (error) {
                const tooLarge = error.status === 413 || error.type === 'entity.too.large';
                const tr = textOfReq(req);
                return refuse(tooLarge ? 413 : 400, tooLarge ? tr.t('errors.imageTooLarge', { max: `${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB` }) : tr.t('errors.uploadUnreadable'));
            }
            try {
                const { fields, file } = parseMultipart(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.headers?.['content-type']);
                req.body = fields;
                req.upload = { file };
            } catch (parseError) {
                if (!(parseError instanceof MultipartError)) throw parseError;
                return refuse(parseError.status, parseError.userMessage);
            }
            return next();
        };
        // Already a Buffer (tests, or a body read earlier): parse it; else read it with the cap.
        if (Buffer.isBuffer(req.body)) return parse(null);
        return moduleRawBody(req, res, (error) => Promise.resolve(parse(error)).catch(next));
    }

    async function renderModule(req, res, module, status = 200, { error = null, errorAction = null, errorField = null, errorFix = null, warnings = [] } = {}) {
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
        // A page grouped by topic gets its commands card as one more topic (each topic has its own grid).
        const rendered = module.render(ctx, data);
        const commandsPart = commandsSection && String(rendered).includes('<section class="topic"')
            ? topic(ctx.t('commands.list.title'), ctx.t('commands.list.topicLine'), commandsSection, { key: 'commands' })
            : commandsSection;
        return sendHtml(res, status, moduleSettingsPage({
            ...shellOf(req), module, body: html`${rendered}${commandsPart}`,
            flash: req.dashboard.flash, error, errorAction, errorField, errorFix, warnings, editEnabled: settings.editEnabled,
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
            return failT(res, 429, 'slowDown', 'tooManyChanges', req);
        }
        if (!checkPost(req)) return failT(res, 403, 'notAllowed', 'csrf', req);
        if (!settings.editEnabled) return failT(res, 403, 'editingOff', 'editingOffText', req);
        const module = findModule(str(req.params?.module, 40));
        const action = module ? getAction(module, str(req.params?.action, 40)) : null;
        if (!module || !action) return failT(res, 404, 'notFound', 'noSuchForm', req);
        const decision = req.dashboard.access;
        // 'settings.edit' alone lets a manager post to any module: the module's own page key must
        // be allowed too (MANAGER_PAGES, permissions.js). Without Administrator (canAct false:
        // managers, OWNER_IDS at home without it) only actions marked `manager` run; the default
        // is closed, so a new or unmarked action is Administrator-only.
        if (!decision.canView || !allows(decision, 'settings.edit') || !allows(decision, `page:${module.key}`) || (!decision.canAct && !action.manager)) {
            return failT(res, 403, 'notAllowed', 'needsAdmin', req);
        }
        const ctx = contextFor(req);
        if (!ctx.guild) return failT(res, 503, 'serverUnavailable', 'serverUnavailableText', req);
        const actionName = str(req.params?.action, 40);
        let result;
        try {
            let form = req.body || {};
            if (action.confirm) {
                // Two steps: the first POST checks the form and shows what will happen; only the
                // confirm page's one-time token (this session, this action, 5 minutes) runs it,
                // with the form stored at the first step. run() validates everything again.
                const subject = `module:${module.key}/${actionName}`;
                if (!str(form.token, 100)) {
                    const preview = await action.confirm(ctx, form);
                    const { csrf: _csrf, token: _token, fh: _fh, ...stored } = form;
                    const { token, hash } = confirms.issue({ session: session.idHash, subject, payload: stored });
                    return sendHtml(res, 200, confirmPage({
                        ...shellOf(req), active: module.key, title: preview.heading, heading: preview.heading, rows: preview.rows || [], notes: preview.notes || [],
                        actionPath: `/${module.key}/${actionName}`, hidden: { token, fh: hash }, submit: preview.submit, cancelHref: path(`/${module.key}`),
                    }));
                }
                form = confirms.consume(str(form.token, 100), { session: session.idHash, subject, hash: str(form.fh, 100) });
                if (!form) throw new InputError(textOfReq(req).t('general.confirmExpired'));
            }
            result = await action.run(ctx, form);
        } catch (error) {
            if (isInputError(error)) {
                const message = plainText(error.userMessage || error.message);
                logger.info(`Dashboard ${module.key}/${req.params.action} refused for ${session.userId}: ${message}`);
                return renderModule(req, res, module, error.status === 403 ? 403 : 400, {
                    error: message, errorAction: actionName, errorField: typeof error.field === 'string' ? error.field : null,
                    // A refused post in a channel where Mewvo lacks permissions: a Fix permissions link next to the message.
                    errorFix: error.fix && typeof error.fix === 'object' ? error.fix : null,
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
        const message = [result?.message || textOfReq(req).t(changes.length ? 'errors.saved' : 'errors.nothingChanged'), ...(result?.warnings || [])].map(plainText).join(' ');
        await sessions.setFlash?.(session.id, message);
        // `back`: the Modules page, the Overview, Setup step by step (with its step number or key) or
        // another module's page (only known names); else this module.
        const back = typeof req.body?.back === 'string' ? req.body.back : '';
        const step = str(req.body?.step, 20);
        const target = back === 'setup' ? `/setup${/^[A-Za-z0-9]{1,20}$/.test(step) ? `?step=${step}` : ''}`
            : back === 'modules' || back === 'overview' || (back && findModule(back)) ? `/${back}` : `/${module.key}`;
        return res.redirect(303, path(target));
    }

    // Phase 3: enforcement and records (enforcementRoutes.js), with the same POST
    // checks; renderCase / renderStaff re-render those pages with an error.
    const enforcementHandlers = createEnforcementHandlers({
        client, guildId, settings, sessions, audits, services, enforcement, confirms,
        sendHtml, fail, shellOf, checkPost, postLimiter, recordDashboardChange,
        renderCase: (...args) => renderCase(...args), renderStaff: (...args) => renderStaff(...args),
    });

    // Members → Role rules and Insights (memberToolsRoutes.js), with the Members POST guard.
    const memberToolsHandlers = createMemberToolsHandlers({
        client, guildId, settings, sendHtml, fail, shellOf, confirms, memberTools, helpers: enforcementHandlers.helpers,
    });

    // The Owner area (ownerRoutes.js): bot owners only, same POST checks + a fresh login.
    const inboxHandlers = createInboxHandlers({
        client, guildId, settings, inbox, confirms, sendHtml, fail, shellOf, enforcement: enforcementHandlers, badge,
    });

    const ownerHandlers = createOwnerHandlers({
        client, guildId, settings, sessions, audits, confirms, sendHtml, fail, shellOf, checkPost, postLimiter, owner,
    });
    // Fix permissions (permissionFixRoutes.js): Mewvo gives itself missing bits in one channel.
    const permissionFixHandlers = createPermissionFixHandlers({
        client, guildId, settings, services, confirms, sessions, audits, postLimiter, checkPost, sendHtml, fail, shellOf, recordDashboardChange,
    });
    // Owner → Website (websiteRoutes.js): the same owner checks, through the owner helpers.
    const websiteHandlers = createWebsiteHandlers({ sendHtml, fail, helpers: ownerHandlers.helpers, website });
    // Owner → Recent errors (ownerErrors.js): read-only, the same owner checks.
    const ownerErrorsHandlers = createOwnerErrorsHandlers({ client, sendHtml, fail, helpers: ownerHandlers.helpers, errors: ownerErrors });

    async function logout(req, res) {
        if (!checkPost(req)) return failT(res, 403, 'notAllowed', 'logoutCsrf', req);
        await sessions.destroy(req.dashboard.session.id);
        res.append('Set-Cookie', clearCookie(SESSION_COOKIE, cookieOptions));
        guildLists.delete(String(req.dashboard.session.userId));
        // To the website, not a dashboard page: one would start a new Discord login (often silent).
        return res.redirect(303, '/');
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

    /**
     * GET /dashboard/lang?code=de&next=/dashboard/… — the language picker: the mewvo_lang cookie
     * (Path=/, shared with the website; the same Set-Cookie as the website's picker) and a redirect
     * back to a dashboard path (safeBackPath: never another site). An unknown code changes nothing.
     */
    function setLanguage(req, res) {
        const code = str(req.query?.code, 10);
        if (LANG_CODES.includes(code)) res.append('Set-Cookie', languageCookie(code, { secure: Boolean(settings.secure) }));
        res.set('Cache-Control', 'no-store');
        return res.redirect(303, safeBackPath(str(req.query?.next, 300)));
    }

    /** GET /dashboard/nav?mode=all|main&next=…: the sidebar shows all pages or the main ones (cookie, like the theme). */
    function setNav(req, res) {
        const mode = navModeFrom(str(req.query?.mode, 10));
        res.append('Set-Cookie', serializeCookie(NAV_COOKIE, mode, { ...cookieOptions, httpOnly: false, maxAgeMs: 365 * 24 * 3600 * 1000 }));
        return res.redirect(303, safeBackPath(str(req.query?.next, 300)));
    }

    function help(req, res) {
        return sendHtml(res, 200, glossaryPage(shellOf(req)));
    }

    async function setup(req, res) {
        const steps = await collectChecklist({ client, guildId, data: data.overview || defaultOverviewData }).catch(() => null);
        // The step's own small form posts to the module's existing save route (back=setup).
        const ctx = contextFor(req);
        const forms = steps ? await setupStepData(ctx).catch(() => null) : null;
        return sendHtml(res, 200, setupPage({ ...shellOf(req), steps, query: req.query, ctx, forms, flash: req.dashboard.flash }));
    }

    function notFound(req, res) {
        return failT(res, 404, 'notFound', 'noSuchPage', req);
    }

    // ── Find a member (memberSearch.js): the no-JS results page and the type-ahead JSON ──
    // Both are GETs behind requireUser (session + Administrator per request, permissions.js
    // 'member.search'); a read only, so no CSRF token, but a cross-site request is refused and
    // each user has their own limit (Discord's member search is rate limited too).
    const crossSite = (req) => String(req.headers?.['sec-fetch-site'] || '') === 'cross-site';

    async function memberSearchHtml(req, res) {
        if (crossSite(req)) return failT(res, 403, 'notAllowed', 'csrf', req);
        const params = searchParams(req.query || {}, safeBackPath);
        let results = null;
        let error = null;
        if (params.q) {
            if (!memberSearch.allow(req.dashboard.session.idHash)) {
                res.set('Retry-After', '60');
                return failT(res, 429, 'slowDown', 'tooManyRequests', req);
            }
            ({ results, error } = await memberSearch.search(client.guilds?.cache?.get(guildId) || null, params.q, { includeBans: params.bans }));
        }
        return sendHtml(res, 200, memberSearchPage({ ...shellOf(req), params, results, error }));
    }

    async function memberSearchJsonHandler(req, res) {
        const send = (status, value) => res.status(status).type('application/json').send(searchJson(value));
        if (crossSite(req)) return send(403, { error: textOfReq(req).t('general.search.json.notAllowed') });
        const q = str(req.query?.q, 100);
        if (!q) return send(200, { results: [] });
        if (!memberSearch.allow(req.dashboard.session.idHash)) {
            res.set('Retry-After', '60');
            return send(429, { error: textOfReq(req).t('general.search.json.tooMany') });
        }
        const { results, error } = await memberSearch.search(client.guilds?.cache?.get(guildId) || null, q, { includeBans: str(req.query?.bans, 1) === '1' });
        return send(200, { results: results.map(({ id, name, username, bot, banned }) => ({ id, name, username, bot, banned })), error });
    }

    return {
        memberSearch: memberSearchHtml, memberSearchJson: memberSearchJsonHandler,
        guildId, isHomeServer, access, guildLists, startLogin, readSession, serverNotFound, requireSession, limiters: shared,
        securityHeaders, limitByIp, stylesheet, staticFile, parseUpload, moduleUploadBody, index, callback, requireUser, checkPost,
        overview, handover, searchSave, searchDelete, modulesHub, cases, casesExport, caseDetail, appeals, staff, activity, audit, backup: (req, res) => backup(req, res), backupDownload, backupPreview, backupApply, modulePage, moduleAction, logout, notFound, setTheme, setNav, setLanguage, help, setup,
        sessions, states, confirms, permissionFix: permissionFixHandlers, enforcement: enforcementHandlers, owner: ownerHandlers, website: websiteHandlers, ownerErrors: ownerErrorsHandlers, inbox: inboxHandlers, badge, memberTools: memberToolsHandlers,
        incidents: createIncidentHandlers({ client, guildId, incidents, sendHtml, shellOf, notFound }),
    };
}

/** Wraps an async handler so a thrown error becomes a plain 500 page (and a log line). */
function safe(handler) {
    const run = async (req, res, next) => {
        try {
            return await handler(req, res, next);
        } catch (error) {
            logger.error(`Dashboard ${req.method} ${req.path} failed: ${error.message}`);
            if (res.headersSent) return undefined;
            // After a form, say what matters: the change may not be saved (never a silent failure).
            const tr = dashboardText(currentLanguage());
            const message = tr.t(req.method === 'POST' ? 'errors.wrongPost' : 'errors.wrongGet');
            return res.status(500).type('html').send(messagePage(tr.t('errors.wrong'), message));
        }
    };
    // Under /dashboard/<guildId>/ the handler runs in that server's context (path() keeps the
    // prefix), even when a body parser's callback came back outside it.
    return (req, res, next) => (req.dashboardGuildId && currentGuildId() !== req.dashboardGuildId
        ? runInGuild(req.dashboardGuildId, () => run(req, res, next))
        : run(req, res, next));
}

/**
 * express.raw for multipart bodies with a hard limit; a body that is too large (or
 * broken) becomes a plain error page instead of Express's default error output.
 */
export function uploadBody(limitBytes, maxLabel = '8 MB') {
    const raw = express.raw({ type: 'multipart/form-data', limit: limitBytes });
    return (req, res, next) => raw(req, res, (error) => {
        if (!error) return next();
        const tooLarge = error.status === 413 || error.type === 'entity.too.large';
        return res.status(tooLarge ? 413 : 400).type('html')
            .send(((tr) => messagePage(tr.t(tooLarge ? 'errors.tooLarge' : 'errors.uploadRefused'), tooLarge ? tr.t('errors.imageTooLarge', { max: maxLabel }) : tr.t('errors.uploadUnreadable')))(dashboardText(currentLanguage())));
    });
}

/**
 * The whole multi-server dashboard (B3): the shared parts, the per-server registry
 * (guildDashboards.js), the picker and the router. `options` are createDashboard's (shared by
 * every instance). `accessFor(guildId)` builds a server's access checker (default
 * createAccessChecker(client, { guildId })); `blacklist` is blacklistHit (injectable).
 * Returns { router, registry, home, accessOf, guildLists, picker }.
 */
export function createDashboardApp({
    client, settings, sessions, env = process.env, accessFor = null, blacklist = blacklistHit, owners = getBotOwners,
    maxGuilds = undefined, idleMs = undefined, ...options
}) {
    const shared = {
        states: options.states || createStateStore(),
        limiters: options.limiters || createDashboardLimiters(options.limits || DEFAULT_LIMITS),
        auditStore: options.auditStore || createAuditStore(),
        confirms: options.confirms || createConfirmStore(),
        memberSearch: options.memberSearch || createMemberSearch(),
        guildLists: options.guildLists || createGuildListCache(),
    };
    // One access checker per server (its own cache), kept like the instances (bounded, idle 2 h).
    const accessCheckers = createLruCache({ max: maxGuilds ?? 500, ttlMs: idleMs ?? 2 * 60 * 60 * 1000 });
    const accessOf = (guildId) => accessCheckers.get(guildId)
        ?? accessCheckers.set(guildId, accessFor ? accessFor(guildId) : createAccessChecker(client, { guildId }));
    const isOwner = (userId) => (typeof owners === 'function' ? owners() : owners).includes(String(userId));

    async function picker(req, res, session) {
        const lang = dashboardLanguage(req, session.userId);
        setRequestLanguage(lang);
        const tr = dashboardText(lang);
        if (blacklist({ userId: session.userId })?.kind === 'user') {
            return res.status(403).type('html').send(messagePage(tr.t('errors.noAccess'), tr.t('errors.blockedText'), null, { lang }));
        }
        const data = await collectPicker({
            client, list: shared.guildLists.get(String(session.userId)) ?? null, mainGuildId: settings.mainGuildId,
            isOwner: isOwner(session.userId), checkAccess: (id) => accessOf(id).check(session.userId, { guildId: id, force: false }),
            isBlockedGuild: (id) => blacklist({ guildId: id })?.kind === 'guild', clientId: settings.clientId,
        });
        let flash = null;
        if (session.flash) {
            flash = session.flash;
            await sessions.setFlash?.(session.id, null)?.catch?.(() => {});
        }
        const theme = themeFrom(parseCookies(req.headers?.cookie)[THEME_COOKIE]);
        return res.status(200).type('html').send(pickerPage({ session: { ...session, isOwner: isOwner(session.userId) }, picker: data, lang, theme, flash }));
    }

    const build = (guildId) => {
        const d = createDashboard({ ...options, client, settings, sessions, env, ...shared, guildId, access: accessOf(guildId), picker });
        d.router = guildRouter(d);
        return d;
    };
    // The main server's instance also serves the global routes (login, logout, Owner area).
    const home = build(settings.mainGuildId);
    const registry = createGuildDashboards({
        build: (guildId) => (guildId === settings.mainGuildId ? home : build(guildId)),
        ...(maxGuilds ? { max: maxGuilds } : {}), ...(idleMs ? { idleMs } : {}),
    });
    const router = dashboardAppRouter({ home, registry, settings, client, blacklist, limiters: shared.limiters, accessOf });
    return { router, registry, home, accessOf, guildLists: shared.guildLists, picker };
}

/** Adds the /dashboard routes (and the /staff redirect) when enabled. Returns true when registered. */
export function registerDashboard(app, client, env = process.env, { sessions = null } = {}) {
    const settings = dashboardSettings(env);
    if (!settings.requested) return false;
    if (!settings.enabled) {
        logger.error(`Dashboard NOT enabled: ${settings.problems.join('; ')}`);
        return false;
    }
    const dashboard = createDashboardApp({
        client, settings, env, sessions: sessions || createPgSessionStore({ query, table: pgConfig.tables.dashboard_sessions }), inboxBadge: true,
    });
    app.use(BASE, dashboard.router);
    // The old read-only staff dashboard lived at /staff.
    app.use('/staff', (req, res) => res.redirect(301, BASE));
    logger.info(`Dashboard enabled at ${BASE} (OAuth redirect ${settings.redirectUri}; per-server pages at ${BASE}/<guildId>/; editing ${settings.editEnabled ? 'ON' : 'off (DASHBOARD_EDIT_ENABLED)'})`);
    return true;
}

/** The part of the original URL after `prefix` ("/dashboard/overview?x=1", "/dashboard" → "/overview?x=1"). */
function restOf(req, prefix) {
    const url = String(req.originalUrl || req.url || '');
    const rest = url.startsWith(prefix) ? url.slice(prefix.length) : '';
    // Only a path that stays below the prefix: "/…" or "?…" (never "//host" after the redirect).
    if (!rest || rest === '/') return '';
    if (rest.startsWith('?')) return rest;
    return rest.startsWith('/') && !rest.startsWith('//') ? rest : '';
}

/** GET/HEAD → 302, POST → 307 (the browser re-sends the form), anything else → 404. */
function redirectKeepingMethod(req, res, location, notFound) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return res.redirect(302, location);
    if (method === 'POST') return res.redirect(307, location);
    return notFound(req, res);
}

/**
 * The multi-server router (mounted at /dashboard): global routes first, then
 * /:guildId → validation → that server's instance (runInGuild: path() keeps the prefix).
 * Old links and the support server's id redirect to the main server.
 */
export function dashboardAppRouter({ home, registry, settings, client, blacklist = blacklistHit, limiters = home.limiters, accessOf = null }) {
    const router = express.Router();
    router.use(home.securityHeaders);
    // The request's language for helpers without a context (language.js); pages get it explicitly.
    router.use(languageContext);
    addGlobalRoutes(router, home);
    const notFound = (req, res) => home.serverNotFound(req, res);
    const mainId = settings.mainGuildId;
    const supportId = settings.supportGuildId && settings.supportGuildId !== mainId ? settings.supportGuildId : null;

    async function guildDispatch(req, res, next) {
        const segment = typeof req.params?.guildId === 'string' ? req.params.guildId : '';
        const { guildId, invalid } = guildSegment(segment);
        if (!guildId) {
            if (invalid) return notFound(req, res);
            if (GLOBAL_SEGMENTS.includes(segment)) return next();
            // An old link (/dashboard/cases/abcde): the same page of the main server. 302 for now
            // (owner decision 5: 301 in a later release), 307 for a POST so the form is re-sent.
            return redirectKeepingMethod(req, res, `${guildPath(mainId)}${restOf(req, BASE)}`, notFound);
        }
        if (supportId && guildId === supportId) {
            return redirectKeepingMethod(req, res, `${guildPath(mainId)}${restOf(req, guildPath(supportId))}`, notFound);
        }
        const session = await home.readSession(req);
        if (!session) {
            const method = String(req.method || 'GET').toUpperCase();
            if (method === 'GET' || method === 'HEAD') {
                const back = safeReturnPath(String(req.originalUrl || ''));
                return res.redirect(302, back === rootPath() ? BASE : `${BASE}${queryString({ r: back })}`);
            }
            const tr = dashboardText(currentLanguage());
            return res.status(401).type('html').send(messagePage(tr.t('errors.loggedOut'), tr.t('errors.loggedOutText', { base: BASE })));
        }
        if (!limiters.session.allow(session.idHash)) {
            res.set('Retry-After', '60');
            return res.status(429).type('html').send(messagePage(dashboardText(currentLanguage()).t('errors.slowDown'), dashboardText(currentLanguage()).t('errors.tooManyRequests')));
        }
        // The bot must be in the server, and the server must not be blacklisted: else the same 404.
        if (!client?.guilds?.cache?.has?.(guildId)) return notFound(req, res);
        const hit = blacklist({ userId: session.userId, guildId });
        if (hit?.kind === 'user') {
            const tr = dashboardText(currentLanguage());
            return res.status(403).type('html').send(messagePage(tr.t('errors.noAccess'), tr.t('errors.blockedText')));
        }
        if (hit?.kind === 'guild') return notFound(req, res);
        // Access before the instance: a stranger gets the same 404 on every path (also the bare
        // /dashboard/<id>/ redirect, which would otherwise say "the bot is in this server") and
        // never builds or refreshes an instance in the registry (no LRU churn). The access cache
        // answers here; requireUser still checks fresh on every POST.
        if (accessOf) {
            const decision = await accessOf(guildId).check(session.userId, { guildId });
            if (!decision?.allowed) return notFound(req, res);
        }
        const instance = registry.get(guildId);
        req.dashboardSession = session; // read once: requireUser reuses it (and the limit is counted once)
        req.dashboardGuildId = guildId;
        return runInGuild(guildId, () => instance.router(req, res, next));
    }

    router.use('/:guildId', safe(guildDispatch));
    router.use(safe(async (req, res) => home.notFound(req, res)));
    return router;
}

/** The global routes (never under a server), on the home instance `d`. */
function addGlobalRoutes(router, d) {
    const user = safe(d.requireUser);
    router.get('/static/:file', d.staticFile);
    router.get('/theme', d.limitByIp, d.setTheme);
    router.get('/lang', d.limitByIp, d.setLanguage);
    router.get('/nav', d.limitByIp, d.setNav);
    router.get('/', d.limitByIp, safe(d.index));
    router.get('/oauth/callback', d.limitByIp, safe(d.callback));
    // Logout needs a session, not access to any server.
    router.post('/logout', express.urlencoded({ extended: false, limit: '2kb' }), safe(d.requireSession), safe(d.logout));
    const form = express.urlencoded({ extended: false, limit: '16kb' });
    // Owner area: login → live owner check (404 otherwise) → body. Image uploads: the owner check
    // runs before any of the body is read.
    const ow = d.owner;
    const owner = [user, ow.requireOwner];
    const ownerUpload = [...owner, uploadBody(MAX_UPLOAD_BYTES + 64 * 1024), safe(d.parseUpload)];
    router.post('/owner/profile/username', ...owner, form, safe(ow.username));
    router.post('/owner/profile/about', ...owner, form, safe(ow.about));
    router.post('/owner/profile/presence', ...owner, form, safe(ow.presence));
    router.post('/owner/profile/avatar', ...ownerUpload, safe(ow.avatar));
    router.post('/owner/profile/banner', ...ownerUpload, safe(ow.banner));
    router.post('/owner/servers/:id/invite', ...owner, form, safe(ow.invite));
    router.post('/owner/servers/:id/leave/preview', ...owner, form, safe(ow.leavePreview));
    router.post('/owner/servers/:id/leave', ...owner, form, safe(ow.leave));
    router.post('/owner/blacklist/add', ...owner, form, safe(ow.blacklistAdd));
    router.post('/owner/blacklist/remove', ...owner, form, safe(ow.blacklistRemove));
    router.post('/owner/health/maintenance', ...owner, form, safe(ow.maintenance));
    router.post('/owner/commands/register/preview', ...owner, form, safe(ow.registerPreview));
    router.post('/owner/commands/register', ...owner, form, safe(ow.register));
    router.post('/owner/announce/preview', ...owner, form, safe(ow.announcePreview));
    router.post('/owner/announce/send', ...owner, form, safe(ow.announceSend));
    router.post('/owner/premium/generate', ...owner, form, safe(ow.premiumGenerate));
    router.post('/owner/premium/revoke', ...owner, form, safe(ow.premiumRevoke));
    router.post('/owner/premium/end', ...owner, form, safe(ow.premiumEnd));
    router.post('/owner/premium/grant', ...owner, form, safe(ow.premiumGrant));
    router.post('/owner/premium/roles', ...owner, form, safe(ow.premiumRolesSave));
    router.post('/owner/erase/preview', ...owner, form, safe(ow.erasePreview));
    router.post('/owner/erase', ...owner, form, safe(ow.eraseRun));
    // Owner → Website: texts up to 5,000 characters (non-Latin text is ~6 bytes per character
    // url-encoded), images up to 2 MB + form overhead.
    const wb = d.website;
    const websiteForm = express.urlencoded({ extended: false, limit: '64kb' });
    router.post('/owner/website/text/save', ...owner, websiteForm, safe(wb.save));
    router.post('/owner/website/text/reset', ...owner, form, safe(wb.reset));
    router.post('/owner/website/text/restore', ...owner, form, safe(wb.restore));
    router.post('/owner/website/images/:slot/upload', ...owner, uploadBody(SITE_IMAGE_MAX_BYTES + 64 * 1024, '2 MB'), safe(d.parseUpload), safe(wb.imageUpload));
    router.post('/owner/website/images/:slot/reset', ...owner, form, safe(wb.imageReset));
    router.get('/owner', ...owner, ow.index);
    router.get('/owner/home', ...owner, safe(ow.home));
    router.get('/owner/activity', ...owner, safe(ow.activity));
    router.get('/owner/profile', ...owner, safe(ow.profile));
    router.get('/owner/servers', ...owner, safe(ow.servers));
    router.get('/owner/servers/:id', ...owner, safe(ow.server));
    router.get('/owner/users', ...owner, safe(ow.users));
    router.get('/owner/users/:id/data', ...owner, safe(ow.userData));
    router.get('/owner/blacklist', ...owner, safe(ow.blacklist));
    router.get('/owner/health', ...owner, safe(ow.health));
    router.get('/owner/commands', ...owner, safe(ow.commands));
    router.get('/owner/erase', ...owner, safe(ow.erase));
    router.get('/owner/errors', ...owner, safe(d.ownerErrors.errors));
    router.get('/owner/website', ...owner, safe(wb.home));
    router.get('/owner/website/images', ...owner, safe(wb.images));
    router.get('/owner/website/ns/:ns', ...owner, safe(wb.namespace));
    router.get('/owner/website/key', ...owner, safe(wb.key));
    router.get('/owner/announce', ...owner, safe(ow.announce));
    router.get('/owner/premium', ...owner, safe(ow.premium));
}

/** One server's routes (below /dashboard/<guildId>, or below /dashboard in the flat router). */
function addGuildRoutes(router, d) {
    const user = safe(d.requireUser);
    // Phase 3 forms (enforcement and records): registered before the settings catch-all.
    const form = express.urlencoded({ extended: false, limit: '16kb' });
    const en = d.enforcement;
    const mt = d.memberTools;
    router.post('/users/rules/preview', form, user, safe(mt.preview));
    router.post('/users/rules/save', form, user, safe(mt.save));
    router.post('/users/rules/:rid/disable', form, user, safe(mt.disable));
    router.post('/users/rules/:rid/delete', form, user, safe(mt.remove));
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
    router.post('/cases/bulk', form, user, safe(en.caseBulk));
    router.post('/cases/bulk/void', form, user, safe(en.caseBulkVoid));
    router.post('/cases/searches/save', form, user, safe(d.searchSave));
    router.post('/cases/searches/delete', form, user, safe(d.searchDelete));
    router.post('/cases/:code/edit', form, user, safe(en.caseEdit));
    router.post('/cases/:code/void', form, user, safe(en.caseVoid));
    router.post('/cases/:code/evidence/add', form, user, safe(en.evidenceAdd));
    // Image upload: login is checked first (cookie only), so an anonymous request is refused before
    // any of the body is read; then the raw body, capped at 8 MB + 64 kB of form overhead.
    router.post('/cases/:code/evidence/upload', user, uploadBody(MAX_UPLOAD_BYTES + 64 * 1024), safe(d.parseUpload), safe(en.evidenceUpload));
    router.post('/backup/preview', user, uploadBody(BACKUP_MAX_BYTES + 16 * 1024), safe(d.parseUpload), safe(d.backupPreview));
    router.post('/backup/apply', form, user, safe(d.backupApply));
    router.post('/handover', form, user, safe(d.handover));
    router.post('/fix-permissions', form, user, safe(d.permissionFix.apply));
    router.post('/cases/:code/evidence/remove', form, user, safe(en.evidenceRemove));
    router.post('/cases/:code/notes', form, user, safe(en.caseNote));
    router.post('/cases/:code/tags', form, user, safe(en.caseTags));
    router.post('/appeals/:code/preview', form, user, safe(en.appealPreview));
    router.post('/appeals/:code/decide', form, user, safe(en.appealDecide));
    router.post('/nocontact/add', form, user, safe(en.noContactAdd));
    router.post('/nocontact/end', form, user, safe(en.noContactEnd));
    router.post('/watchlist/end', form, user, safe(en.watchlistEnd));
    router.post('/staff/blocks/lift', form, user, safe(en.blockLift));
    router.post('/staff/warn', form, user, safe(en.staffWarn));
    router.post('/staff/restore', form, user, safe(en.staffRestore));
    const ib = d.inbox;
    router.post('/inbox/:kind/:id/reply', form, user, safe(ib.reply));
    router.post('/inbox/:kind/:id/close/preview', form, user, safe(ib.closePreview));
    router.post('/inbox/:kind/:id/close', form, user, safe(ib.close));
    // Settings forms: the body parser is mounted here only (32 kB, no nested objects).
    // urlencoded skips multipart bodies, so an upload is read only after the login check.
    router.post('/:module/:action', express.urlencoded({ extended: false, limit: '32kb' }), user, safe(d.moduleUploadBody), safe(d.moduleAction));
    router.get('/overview', user, safe(d.overview));
    router.get('/inbox', user, safe(ib.list));
    router.get('/inbox/:kind/:id', user, safe(ib.conversation));
    router.get('/modules', user, safe(d.modulesHub));
    router.get('/cases', user, safe(d.cases));
    router.get('/cases/export.csv', user, safe(d.casesExport));
    router.get('/cases/:code', user, safe(d.caseDetail));
    router.get('/appeals', user, safe(d.appeals));
    router.get('/appeals/:code', user, safe(en.appealDetail));
    router.get('/users', user, safe(en.users));
    router.get('/bans', user, safe(en.bans));
    router.get('/users/rules', user, safe(mt.rules));
    router.get('/users/insights', user, safe(mt.insights));
    router.get('/users/bulk/:job', user, safe(en.bulkJob));
    router.get('/users/:id', user, safe(en.userPage));
    router.get('/nocontact', user, safe(en.noContact));
    router.get('/members/search.json', user, safe(d.memberSearchJson));
    router.get('/members/search', user, safe(d.memberSearch));
    router.get('/staff', user, safe(d.staff));
    router.get('/activity', user, safe(d.activity));
    router.get('/incidents', user, safe(d.incidents.list));
    router.get('/incidents/:id', user, safe(d.incidents.detail));
    router.get('/backup', user, safe(d.backup));
    router.get('/backup/download', user, safe(d.backupDownload));
    router.get('/audit', user, safe(d.audit));
    router.get('/help', user, safe(d.help));
    router.get('/setup', user, safe(d.setup));
    router.get('/fix-permissions', user, safe(d.permissionFix.page));
    router.get('/:module', user, safe(d.modulePage));
    router.use(user, safe(d.notFound));
}

/** One server's router: the guild routes, and /dashboard/<guildId> itself → its Overview. */
export function guildRouter(d) {
    const router = express.Router();
    router.get('/', (req, res) => res.redirect(302, path('/overview')));
    addGuildRoutes(router, d);
    return router;
}

/**
 * Every route of ONE dashboard instance on one flat router (no server prefix): local previews
 * and tests. Production uses createDashboardApp (registerDashboard).
 */
export function dashboardRouter(d) {
    const router = express.Router();
    router.use(d.securityHeaders);
    router.use(languageContext);
    addGlobalRoutes(router, d);
    addGuildRoutes(router, d);
    return router;
}
