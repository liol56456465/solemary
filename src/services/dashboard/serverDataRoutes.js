// serverDataRoutes.js — the dashboard handlers of "Delete this server's data" (owner decision
// 2026-11-07). Pages: serverDataPages.js; the work: services/privacy/serverDataDeletion.js.
//
// In a server (below /dashboard/<guildId>, Administrator route keys in permissions.js):
//   GET  /server-data           preview + status        server owner only (live guild.ownerId), else 404
//   POST /server-data/request   schedule (7-day grace)  CSRF + same origin, owner checked fresh
//   POST /server-data/cancel    cancel while scheduled
// After Mewvo was removed (global, a session is enough; ownership from the user's own OAuth server
// list, at most OAUTH_OWNER_FRESH_MS old, else "Check with Discord" logs in again silently):
//   GET  /removed/<id>/data, GET /removed/<id>/data/verify, POST …/request, POST …/cancel
// Mewvo's own servers: 404 everywhere. A server the bot is in: the removed-path redirects to the
// in-server page (its ownership check is live).

import { guildPath, rootPath } from './html.js';
import { isSnowflake } from './security.js';
import { removedServerDataPage, serverDataPage, verifyOwnerPage } from './serverDataPages.js';
import {
    cancelServerDeletion, checkServerOwner, getDeletionRequest, isPending, previewServerData, requestServerDeletion,
} from '../privacy/serverDataDeletion.js';
import { logger } from '../../utils/logger.js';

export const defaultServerDataDeps = Object.freeze({
    check: checkServerOwner, preview: previewServerData, getRequest: getDeletionRequest,
    request: requestServerDeletion, cancel: cancelServerDeletion,
});

/**
 * ctx: { client, guildId, isHomeServer, settings, sessions, guildLists, startLogin, sendHtml, shellOf,
 * fail, failT, textOfReq, checkPost, postLimiter, serverNotFound, themeOf, path, deps }.
 */
export function createServerDataHandlers(ctx) {
    const {
        client, guildId, isHomeServer, settings, sessions, guildLists, startLogin, sendHtml, shellOf,
        fail, failT, textOfReq, checkPost, postLimiter, serverNotFound, themeOf, path, deps = defaultServerDataDeps,
    } = ctx;
    const d = { ...defaultServerDataDeps, ...deps };
    const userOf = (req) => String(req.dashboard.session.userId);
    const guildName = (id) => client?.guilds?.cache?.get?.(id)?.name || '';
    const dateOf = (tr, iso) => (Number.isNaN(Date.parse(iso)) ? '' : tr.fmtDateTime(new Date(iso)));

    /** Rate limit, CSRF + origin, editing switch. A response when refused, else null. */
    function guard(req, res) {
        if (!postLimiter.allow(req.dashboard.session.idHash)) {
            res.set('Retry-After', '60');
            return failT(res, 429, 'slowDown', 'tooManyChanges', req);
        }
        if (!checkPost(req)) return failT(res, 403, 'notAllowed', 'csrf', req);
        if (!settings.editEnabled) return failT(res, 403, 'editingOff', 'editingOffText', req);
        return null;
    }

    /** A refused owner check: 404 for "not the owner" (the page does not exist for them), else a short page. */
    function refused(req, res, reason) {
        const tr = textOfReq(req);
        if (reason === 'unknown') return fail(res, 503, tr.t('serverData.errors.title'), tr.t('serverData.errors.unknown'), req);
        return serverNotFound(req, res);
    }

    const flash = (req, text) => sessions.setFlash?.(req.dashboard.session.id, text);

    // ── In a server ───────────────────────────────────────────────────────

    async function page(req, res) {
        if (isHomeServer) return serverNotFound(req, res);
        const ok = await d.check({ client, guildId, userId: userOf(req) });
        if (!ok.allowed) return refused(req, res, ok.reason);
        const record = await d.getRequest(guildId);
        const preview = isPending(record) ? null : await d.preview(guildId);
        return sendHtml(res, 200, serverDataPage({
            ...shellOf(req), preview, record, guildName: guildName(guildId), editEnabled: settings.editEnabled, flash: req.dashboard.flash,
        }));
    }

    async function request(req, res) {
        const stop = guard(req, res);
        if (stop) return stop;
        if (isHomeServer) return serverNotFound(req, res);
        const ok = await d.check({ client, guildId, userId: userOf(req) });
        if (!ok.allowed) return refused(req, res, ok.reason);
        const tr = textOfReq(req);
        const removeBot = String(req.body?.removeBot ?? '') === '1';
        const { record, created } = await d.request({ guildId, userId: userOf(req), removeBot, source: 'dashboard', lang: tr.lang, guildName: guildName(guildId) });
        await flash(req, tr.t(created ? 'serverData.flash.scheduled' : 'serverData.flash.already', { date: dateOf(tr, record?.dueAt) }));
        return res.redirect(303, path('/server-data'));
    }

    async function cancel(req, res) {
        const stop = guard(req, res);
        if (stop) return stop;
        if (isHomeServer) return serverNotFound(req, res);
        const ok = await d.check({ client, guildId, userId: userOf(req) });
        if (!ok.allowed) return refused(req, res, ok.reason);
        const tr = textOfReq(req);
        const { cancelled, record } = await d.cancel({ guildId, userId: userOf(req) });
        await flash(req, tr.t(cancelled ? 'serverData.flash.cancelled' : record?.status === 'running' ? 'serverData.flash.running' : 'serverData.flash.notScheduled'));
        return res.redirect(303, path('/server-data'));
    }

    // ── After Mewvo was removed (global routes, on the home instance) ──────

    /** The id from the URL when this path applies, else a response (404 / redirect into the server). */
    function removedTarget(req, res) {
        const id = typeof req.params?.id === 'string' ? req.params.id : '';
        if (!isSnowflake(id)) return { done: serverNotFound(req, res) };
        if (client?.guilds?.cache?.has?.(id)) {
            return { done: res.redirect(req.method === 'POST' ? 303 : 302, guildPath(id, '/server-data')) };
        }
        return { id };
    }

    const entryOf = (req, id) => (guildLists?.get?.(userOf(req)) || []).find((g) => g?.id === id) || null;

    async function removedCheck(req, id) {
        return d.check({ client, guildId: id, userId: userOf(req), oauthEntry: entryOf(req, id) });
    }

    async function removedPage(req, res) {
        const target = removedTarget(req, res);
        if (target.done) return target.done;
        const { id } = target;
        const ok = await removedCheck(req, id);
        const lang = req.dashboard.lang;
        const theme = themeOf(req);
        const name = entryOf(req, id)?.name || '';
        if (ok.reason === 'stale') return sendHtml(res, 200, verifyOwnerPage({ lang, theme, guildId: id, guildName: name }));
        if (!ok.allowed) return refused(req, res, ok.reason);
        const record = await d.getRequest(id);
        const preview = isPending(record) ? null : await d.preview(id);
        return sendHtml(res, 200, removedServerDataPage({
            csrf: req.dashboard.session.csrf, lang, theme, guildId: id, guildName: name, preview, record,
            editEnabled: settings.editEnabled, flash: req.dashboard.flash,
        }));
    }

    /** "Check with Discord": log in again without the consent screen, then back to the page. */
    function removedVerify(req, res) {
        const id = typeof req.params?.id === 'string' ? req.params.id : '';
        if (!isSnowflake(id)) return serverNotFound(req, res);
        return startLogin(req, res, { returnTo: rootPath(`/removed/${id}/data`), prompt: 'none' });
    }

    async function removedAction(req, res, action) {
        const stop = guard(req, res);
        if (stop) return stop;
        const target = removedTarget(req, res);
        if (target.done) return target.done;
        const { id } = target;
        const back = rootPath(`/removed/${id}/data`);
        const ok = await removedCheck(req, id);
        if (ok.reason === 'stale') return res.redirect(303, back);
        if (!ok.allowed) return refused(req, res, ok.reason);
        const tr = textOfReq(req);
        if (action === 'request') {
            const { record, created } = await d.request({ guildId: id, userId: userOf(req), removeBot: false, source: 'dashboard-removed', lang: tr.lang, guildName: entryOf(req, id)?.name || null });
            await flash(req, tr.t(created ? 'serverData.flash.scheduled' : 'serverData.flash.already', { date: dateOf(tr, record?.dueAt) }));
        } else {
            const { cancelled, record } = await d.cancel({ guildId: id, userId: userOf(req) });
            await flash(req, tr.t(cancelled ? 'serverData.flash.cancelled' : record?.status === 'running' ? 'serverData.flash.running' : 'serverData.flash.notScheduled'));
        }
        return res.redirect(303, back);
    }

    /** For the Overview card: { record } when this user owns the server (bot's cache; the page re-checks live), else null. */
    async function overviewInfo(req) {
        if (isHomeServer) return null;
        const guild = client?.guilds?.cache?.get?.(guildId);
        if (!guild?.ownerId || String(guild.ownerId) !== userOf(req)) return null;
        try {
            const record = await d.getRequest(guildId);
            return { record: isPending(record) ? record : null };
        } catch (error) {
            logger.warn(`Dashboard overview of ${guildId}: deletion status not read: ${error.message}`);
            return { record: null };
        }
    }

    return {
        page, request, cancel, overviewInfo,
        removedPage, removedVerify,
        removedRequest: (req, res) => removedAction(req, res, 'request'),
        removedCancel: (req, res) => removedAction(req, res, 'cancel'),
    };
}
