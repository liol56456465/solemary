// permissionFixRoutes.js — "Fix permissions": Mewvo gives itself the permissions a feature
// needs in one channel (channelToolsService.fixBotChannelPermissions).
//
//   GET  /dashboard/fix-permissions?channel=<id>&need=ViewChannel,SendMessages  the confirm page:
//        what is missing, what Mewvo will give itself, what only the owner can do in Discord.
//        Changes nothing. Opened from the "Fix permissions" link next to a channel picker's
//        warning or a refused post.
//   POST /dashboard/fix-permissions  the change: rate limit → same origin + CSRF → edit switch →
//        Administrator (canAct; OWNER_IDS without it are refused) → the one-time confirm token
//        from the page (same session, same channel, 5 minutes) → the overwrite → mod log line
//        (loggingService) + dashboard audit rows → flash → 303 back to the page it came from.
//
// Both are Administrator-only in permissions.js ('permissions.fix'). The page text is English
// (module-page text; docs/dashboard-i18n.md). Every value goes through the escaping `html`.

import { PermissionFlagsBits } from 'discord.js';
import { FIXABLE_PERMS, FIX_EDIT_PERMS, blockedReason, manualFixSteps, permissionLabels, planPermissionFix } from '../channelToolsService.js';
import { logger } from '../../utils/logger.js';
import { actionForm } from './enforcementPages.js';
import { FIX_PERMISSIONS_PATH, PERMS, isSnowflake, plainText, text } from './forms.js';
import { html, layout, path } from './html.js';
import { auditReason } from './memberActions.js';

/** Bits the page accepts in ?need= (anything else is dropped): what pickers ask for. */
const KNOWN_NEEDS = new Set([...FIXABLE_PERMS, ...FIX_EDIT_PERMS, 'ManageChannels']);
const SUBJECT = (channelId) => `fixperms:${channelId}`;

/** The permission names from ?need= (comma list), known ones only; none → a normal post. */
export function parseNeed(value) {
    const names = String(typeof value === 'string' ? value : '').split(',').map((p) => p.trim()).filter((p) => KNOWN_NEEDS.has(p) && PermissionFlagsBits[p] !== undefined);
    return names.length ? [...new Set(names)].slice(0, 12) : [...PERMS.post];
}

const BACK_RE = /^\/dashboard(\/[A-Za-z0-9_\-/]*)?(\?[A-Za-z0-9_\-=&%.]*)?$/;
/** A dashboard path to go back to: ?back= when it is one, else the Referer's path (same site), else Channel tools. */
export function backPathOf(req, publicOrigin) {
    const ok = (p) => typeof p === 'string' && BACK_RE.test(p) && !p.includes('//') && !p.startsWith(path(FIX_PERMISSIONS_PATH));
    const fromQuery = typeof req.query?.back === 'string' ? req.query.back : '';
    if (ok(fromQuery)) return fromQuery;
    try {
        const ref = new URL(String(req.headers?.referer || ''));
        if (publicOrigin && ref.origin === publicOrigin && ok(`${ref.pathname}${ref.search}`)) return `${ref.pathname}${ref.search}`;
    } catch {
        // No or bad Referer: the default below.
    }
    return path('/channels');
}

const list = (labels) => labels.join(', ');

/** The confirm page. `canFix`: the form is shown (Administrator, editing on, something Mewvo can give). */
export function fixPermissionsPage({ session, access = null, moduleStates = {}, channel, plan, need = [], back, token = null, hash = null, error = null, editEnabled = true, canAct = false }) {
    const canFix = Boolean(editEnabled && canAct && plan.grantable.length && token);
    const steps = manualFixSteps(channel, plan);
    const needsOwner = plan.blockedBy || plan.cannotEdit.length || plan.notInServer.length || plan.notFixable.length || !plan.grantable.length;
    const facts = plan.missing.length ? html`<dl>
<dt>Missing</dt><dd>${list(permissionLabels(plan.missing))}</dd>
${plan.grantable.length ? html`<dt>Mewvo will give itself</dt><dd>${list(permissionLabels(plan.grantable))}</dd>` : ''}
${plan.notInServer.length ? html`<dt>Mewvo can't give itself</dt><dd>${list(permissionLabels(plan.notInServer))} <span class="muted">(its own role does not have them)</span></dd>` : ''}
${plan.notFixable.length ? html`<dt>Not changed here</dt><dd>${list(permissionLabels(plan.notFixable))} <span class="muted">(only you can give these)</span></dd>` : ''}
${blockedReason(channel, plan) ? html`<dt>Why Mewvo can't fix it</dt><dd>${blockedReason(channel, plan)}</dd>` : ''}
</dl>` : html`<p>Mewvo already has what it needs here. Nothing to fix.</p>`;
    const notes = !plan.grantable.length ? '' : !editEnabled
        ? html`<p class="notice">Editing from the dashboard is turned off, so nothing can be changed here.</p>`
        : !canAct ? html`<p class="notice">Only members with the Administrator permission in the main server can do this.</p>` : '';
    const form = canFix ? html`<p class="muted">This adds a permission just for Mewvo in #${channel.name}. Nobody else's permissions change. This confirmation works once and expires in 5 minutes.</p>
${actionForm(session.csrf, FIX_PERMISSIONS_PATH, '', { submit: 'Give Mewvo these permissions', hidden: { token, fh: hash, channel: channel.id, need: need.join(','), back } })}` : '';
    const body = html`<p><a href="${back}">← Back (cancel)</a></p>
<h1>Fix Mewvo's permissions in #${channel.name}</h1>
<section class="card confirm-card">${error ? html`<p class="error" role="alert">${error}</p>` : ''}${facts}${notes}${form}</section>
${plan.missing.length && needsOwner && steps.length ? html`<section class="card"><h2>What to do in Discord</h2><ol>${steps.map((s) => html`<li>${s}</li>`)}</ol>
<p class="muted">Then reload this page to check again.</p></section>` : ''}`;
    return layout({ title: 'Fix permissions', active: 'channels', session, access, moduleStates, body });
}

export function createPermissionFixHandlers({ client, guildId, settings, services, confirms, sessions, audits, postLimiter, checkPost, sendHtml, fail, shellOf, recordDashboardChange }) {
    const guildOf = () => client.guilds?.cache?.get(guildId) || null;

    function render(req, res, status, { channel, need, back, error = null }) {
        const guild = guildOf();
        const plan = planPermissionFix(guild, channel, need);
        const decision = req.dashboard.access;
        const canFix = Boolean(settings.editEnabled && decision.canAct && plan.grantable.length);
        const issued = canFix ? confirms.issue({ session: req.dashboard.session.idHash, subject: SUBJECT(channel.id), payload: { channelId: channel.id, need, back } }) : null;
        return sendHtml(res, status, fixPermissionsPage({
            ...shellOf(req), channel, plan, need, back, token: issued?.token, hash: issued?.hash, error, editEnabled: settings.editEnabled, canAct: Boolean(decision.canAct),
        }));
    }

    /** GET: the confirm page for ?channel= and ?need=. */
    async function page(req, res) {
        const guild = guildOf();
        if (!guild) return fail(res, 503, 'Server not available', 'Mewvo cannot see the main server right now. Try again in a minute.', req);
        const channelId = typeof req.query?.channel === 'string' ? req.query.channel.trim() : '';
        const channel = isSnowflake(channelId) ? guild.channels?.cache?.get(channelId) : null;
        if (!channel) return fail(res, 404, 'Channel not found', 'That channel is not in the server (any more). Go back and pick another one.', req);
        return render(req, res, 200, { channel, need: parseNeed(req.query?.need), back: backPathOf(req, settings.publicOrigin) });
    }

    /** POST: give Mewvo the missing bits (after the confirm page). */
    async function apply(req, res) {
        const session = req.dashboard.session;
        if (!postLimiter.allow(session.idHash)) {
            res.set('Retry-After', '60');
            return fail(res, 429, 'Slow down', 'Too many changes in the last minute. Wait a moment and try again.', req);
        }
        if (!checkPost(req)) return fail(res, 403, 'Not allowed', 'This form did not come from this dashboard (security token or origin mismatch). Reload the page and try again.', req);
        if (!settings.editEnabled) return fail(res, 403, 'Editing is off', 'Editing from the dashboard is turned off (DASHBOARD_EDIT_ENABLED). Nothing was changed.', req);
        if (!req.dashboard.access.canAct) return fail(res, 403, 'Not allowed', 'Only members with the Administrator permission in the main server can change Mewvo\'s permissions. Nothing was changed.', req);
        const guild = guildOf();
        if (!guild) return fail(res, 503, 'Server not available', 'Mewvo cannot see the main server right now. Nothing was changed.', req);
        const channelId = text(req.body, 'channel', 25);
        const channel = isSnowflake(channelId) ? guild.channels?.cache?.get(channelId) : null;
        if (!channel) return fail(res, 404, 'Channel not found', 'That channel is not in the server (any more). Nothing was changed.', req);
        const payload = confirms.consume(text(req.body, 'token', 100), { session: session.idHash, subject: SUBJECT(channel.id), hash: text(req.body, 'fh', 100) });
        if (!payload || payload.channelId !== channel.id) {
            const back = backPathOf({ query: { back: text(req.body, 'back', 300) }, headers: {} }, settings.publicOrigin);
            return render(req, res, 400, { channel, need: parseNeed(text(req.body, 'need', 300)), back, error: 'This confirmation expired or was already used. Nothing was changed. Check the list below and confirm again.' });
        }
        const before = planPermissionFix(guild, channel, payload.need);
        let result;
        try {
            result = await services.fixBotChannelPermissions({
                client, guild, channel, wanted: payload.need,
                moderator: { id: session.userId, tag: session.username || session.userId },
                auditReason: auditReason(session.username || session.userId, 'Fix permissions'),
            });
        } catch (error) {
            if (!['permission', 'validation'].includes(error?.type)) throw error;
            const message = plainText(error.userMessage || error.message);
            logger.info(`Dashboard fix-permissions in ${channel.id} refused for ${session.userId}: ${message}`);
            return render(req, res, error.type === 'permission' ? 403 : 400, { channel, need: payload.need, back: payload.back, error: message });
        }
        await recordDashboardChange({
            store: audits, postModLog: services.postModLog, client, guildId, actor: { userId: session.userId, username: session.username },
            module: 'channels', moduleLabel: 'Channel permissions',
            changes: [{ key: `permissions.${channel.id}`, old: { missing: before.missing }, new: { granted: result.grantedBits, stillMissing: result.stillMissing } }],
        });
        logger.info(`Dashboard fix-permissions by ${session.userId} in ${channel.id}: ${result.grantedBits.join(', ')}`);
        const still = result.stillMissing.length ? ` Still missing: ${result.stillMissing.join(', ')}. Only the server owner can give those (see the steps on the Fix permissions page).` : '';
        await sessions.setFlash?.(session.id, `Mewvo now has ${result.granted.join(', ')} in #${channel.name}.${still}`);
        return res.redirect(303, payload.back);
    }

    return { page, apply };
}
