// enforcementRoutes.js — Phase 3 handlers: member lookup and actions, case changes,
// appeal decisions, no-contact orders, staff coverage and mass-action blocks.
//
//   GET  /dashboard/users?q=                     member lookup (ID or name prefix)
//   GET  /dashboard/users/:id[?reason=]          member page (standing, notes, cases, actions)
//   POST /dashboard/users/:id/action/preview     builds the flow (flowBuilder, like the panel) → confirm page
//   POST /dashboard/users/:id/action/execute     single-use token → executeAction → flash + 303
//   POST /dashboard/users/:id/notes/add|remove   staff notes
//   POST /dashboard/users/:id/unverify          removeVerification (like /verification remove)
//   POST /dashboard/cases/:code/edit|void        caseEditService
//   POST /dashboard/cases/:code/evidence/add|upload|remove   links, or an uploaded image (re-hosted)
//   GET  /dashboard/appeals/:code                appeal dossier
//   POST /dashboard/appeals/:code/preview|decide confirm step → decideAppeal
//   GET  /dashboard/nocontact (also lists the staff watchlist), POST /dashboard/nocontact/add|end,
//   POST /dashboard/watchlist/end
//   POST /dashboard/staff/blocks/lift            OWNER_IDS only (like /staff restore)
//   POST /dashboard/staff/warn|restore           OWNER_IDS only (/staff warn, /staff restore's roles)
//
// Every POST: 30/min per session, same origin + CSRF, edit switch (DASHBOARD_EDIT_ENABLED),
// then Administrator in the main server (canAct; OWNER_IDS without it get 403, owner
// decision 4) — except lifting a mass-action block, warning staff and restoring staff
// roles, which are for OWNER_IDS (like /staff), and what permissions.js lets the Moderator
// level run (warn, mute, unmute, kick, timeout): the moderator role is re-checked on a
// fresh member fetch, and hierarchy + the mass-action guard apply as usual. Actions run
// with the logged-in user's GuildMember fetched fresh, through the SAME services as the
// Discord commands (DMs, ladder, hierarchy, bot permissions, mass-action guard, logs).

import { PermissionFlagsBits } from 'discord.js';
import { CUSTOM_REASON_KEY, enforcementConfig, getReason } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { recordOwnerOverride } from '../ownerOverride.js';
import { isAdministrator, previewWarn } from '../enforcement/enforcementService.js';
import { normalizeCaseCode } from '../enforcement/format.js';
import { parseEditDuration } from '../enforcement/caseEditService.js';
import { parseEvidenceUrls } from '../enforcement/evidenceService.js';
import { appealAnswers, assertAppealReviewer } from '../enforcement/appealService.js';
import { checkAppealReviewer, needsSecondReviewer } from '../enforcement/appealReviewer.js';
import { NO_CONTACT_MAX_DAYS } from '../enforcement/noContactService.js';
import {
    ACTION_LABELS, ACTION_TYPES, RECORD_ACTIONS, availableActions, flowSummary, isKnownReasonKey, liftReasonPatch,
    parseFlowInput, reasonPatch, startFlow,
} from '../enforcement/flowBuilder.js';
import { COVERAGE_PERIODS, buildCoverageReport } from '../staffCoverageService.js';
import { weekStart } from '../staffActivityService.js';
import { automodConfig } from '../../config/automod.js';
import { InputError, multiline, plainText, queryText, text } from './forms.js';
import { JOINED_FILTERS, SORTS, STATE_FILTERS, listMembers } from './membersData.js';
import { NICKNAME_MAX, REASON_MAX, TIMEOUTS, assignableRoles, auditReason, roleProblem, targetProblem } from './memberActions.js';
import { BULK_ACTIONS, BULK_LIMIT, createJobStore, planBulk } from './bulkActions.js';
import { BAN_FILTERS, listBans } from './bansData.js';
import { TEMP_ROLE_LENGTHS } from '../members/tempRoleService.js';
import { html, layout, path, queryString } from './html.js';
import { isSnowflake } from './security.js';
import { currentLanguage, currentText, dashboardText } from './language.js';
import { parseUserRef } from './memberSearch.js';
import { MODERATOR, mayRun, moderatorActionTypes, requiredLevel } from './permissions.js';
import { memberHasConfiguredModeratorRole } from '../../utils/permissionGuard.js';
import { caseActions as caseActionForms } from './enforcementPages.js';
import { normalizeTags } from '../enforcement/caseNotesService.js';
import { evidenceFileName, sniffImage } from './multipart.js';
import {
    actionConfirmPage, activitySection, appealConfirmPage, confirmPage, appealDetailPage, blocksSection, disciplineSection, bansPage, bulkJobPage, bulkPreviewPage, membersPage, coverageSection, noContactPage, userPage,
} from './enforcementPages.js';

const SEARCH_LIMIT = 25;

// The words of this file: src/content/dashboard/<lang>/moderation.json. Route handlers use the
// request's language (req.dashboard.lang, else the running request's); the exported helpers use
// currentText() (English outside a request, e.g. in tests). Audit rows and logs stay English.
const textOf = (req) => dashboardText(req?.dashboard?.lang || currentLanguage());
const ACTION_KEYS = {
    ban: 'moderation.action.ban', kick: 'moderation.action.kick', mute: 'moderation.action.mute', warn: 'moderation.action.warn',
    unban: 'moderation.action.unban', unmute: 'moderation.action.unmute', removewarn: 'moderation.action.removewarn',
};
const TIMEOUT_KEYS = {
    '60s': 'moderation.length.60s', '5m': 'moderation.length.5m', '10m': 'moderation.length.10m', '1h': 'moderation.length.1h',
    '1d': 'moderation.length.1d', '1w': 'moderation.length.1w', '28d': 'moderation.length.28d', '3d': 'moderation.length.3d',
    '7d': 'moderation.length.7d', '30d': 'moderation.length.30d',
};
const BULK_KEYS = {
    'role-add': 'moderation.bulk.action.roleAdd', 'role-remove': 'moderation.bulk.action.roleRemove', timeout: 'moderation.bulk.action.timeout',
    kick: 'moderation.bulk.action.kick', ban: 'moderation.bulk.action.ban',
};
/** An action's label ("Ban") in a language; unknown types keep their English label. */
const actionLabel = (tr, type) => (ACTION_KEYS[type] ? tr.t(ACTION_KEYS[type]) : ACTION_LABELS[type]);
/** A timeout / temporary-role length ("1 hour") in a language; `fallback` is the English label. */
const lengthLabel = (tr, key, fallback) => (TIMEOUT_KEYS[key] ? tr.t(TIMEOUT_KEYS[key]) : fallback);
const bulkLabel = (tr, action) => (BULK_KEYS[action] ? tr.t(BULK_KEYS[action]) : BULK_ACTIONS[action]);
/** "reason and duration": the changed fields of a case edit. */
function fieldList(tr, fields) {
    const label = (f) => (f === 'reason' ? tr.t('moderation.case.field.reason') : f === 'duration' ? tr.t('moderation.case.field.duration') : f);
    return fields.map(label).reduce((a, b) => tr.t('moderation.case.fieldsAnd', { a, b }));
}
const RECENT_CASES = 10;

/** Expected service errors carry a message for the moderator (createError(..., { expected: true })). */
export function isExpectedError(error) {
    return error instanceof InputError || Boolean(error?.context?.expected)
        || Boolean(error?.userMessage && ['validation', 'permission', 'user_input', 'configuration'].includes(error?.type));
}

function errorStatus(error) {
    if ([403, 404, 500].includes(error?.status)) return error.status;
    return error?.type === 'permission' ? 403 : 400;
}

/** A case code from the URL (5–7 letters/digits of the case alphabet) or null. */
function caseCodeParam(req) {
    const raw = typeof req.params?.code === 'string' ? req.params.code.slice(0, 10) : '';
    return normalizeCaseCode(raw);
}

function userIdParam(req) {
    const raw = typeof req.params?.id === 'string' ? req.params.id : '';
    return isSnowflake(raw) ? raw : null;
}

/** Members of the guild cache whose username, display name or nickname starts with `q` (case-insensitive). */
export function searchMembers(guild, q, limit = SEARCH_LIMIT) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return [];
    const out = [];
    for (const member of guild?.members?.cache?.values?.() || []) {
        const user = member.user || {};
        const names = [user.username, user.globalName, member.nickname].filter(Boolean).map((n) => String(n).toLowerCase());
        if (names.some((n) => n.startsWith(needle))) {
            out.push({ id: user.id || member.id, username: user.username || member.id, globalName: user.globalName || null, nickname: member.nickname || null, bot: Boolean(user.bot) });
            if (out.length >= limit) break;
        }
    }
    return out.sort((a, b) => String(a.username).localeCompare(String(b.username), 'en', { sensitivity: 'base' }));
}

/**
 * The flow for a record action from the dashboard form, built with the SAME steps as
 * the panel (startFlow → reasonPatch → parseFlowInput → completeFlowDetails). Throws an
 * InputError with the panel's message when the input is refused.
 * form: { reason, custom_reason, duration, unappealable (default|yes|no), name, evidence }.
 */
export async function buildRecordFlow({ guild, moderator, moderatorId, targetUser, type, form, completeFlowDetails }) {
    const flow = startFlow({ type, moderatorId, targetUser });
    const reasonKey = text(form, 'reason', 50);
    if (!isKnownReasonKey(reasonKey)) throw new InputError(currentText().t('moderation.flow.chooseReason'));
    Object.assign(flow, reasonPatch(flow, reasonKey));
    const choice = text(form, 'unappealable', 10) || 'default';
    if (!['default', 'yes', 'no'].includes(choice)) throw new InputError(currentText().t('moderation.flow.unknownAppealChoice'));
    const parsed = parseFlowInput(flow, {
        customReason: reasonKey === CUSTOM_REASON_KEY ? text(form, 'custom_reason', 500) : '',
        durationInput: text(form, 'duration', 20),
        unappealable: choice === 'default' ? flow.unappealable : choice === 'yes',
        evidenceInput: multiline(form, 'evidence', 1000),
    });
    if (parsed.error) throw new InputError(plainText(parsed.error));
    const { patch, error, fatal } = await completeFlowDetails({
        guild, moderator, targetUser, flow, patch: parsed.patch, customName: text(form, 'name', 100),
    });
    if (fatal) throw new InputError(plainText(fatal), 403);
    if (error) throw new InputError(plainText(error));
    return Object.assign(flow, patch);
}

/** What voiding this case does, for the confirm page (same rules as voidCase). */
export function voidEffect(record) {
    const tr = currentText();
    const dm = tr.t('moderation.void.dm');
    if (record.is_test) return tr.t('moderation.void.test', { dm });
    if (!['active', 'appeal_pending'].includes(record.status)) {
        return tr.t(record.status === 'expired' ? 'moderation.void.alreadyEnded' : 'moderation.void.alreadyLifted', { dm });
    }
    const lift = {
        ban: 'moderation.void.lift.ban',
        mute: 'moderation.void.lift.mute',
        warn: 'moderation.void.lift.warn',
        kick: 'moderation.void.lift.kick',
    }[record.type] || 'moderation.void.lift.fallback';
    return tr.t('moderation.void.effect', { lift: tr.t(lift), dm });
}

/** A flow without the in-memory helpers, for the audit row. */
function auditFlow(flow, result) {
    return {
        target: `${flow.targetUsername} (${flow.targetId})`,
        case: result?.record?.case_code || null,
        reason: flow.reason || null,
        ...(flow.durationMs !== undefined ? { durationMs: flow.durationMs } : {}),
        ...(flow.type === 'ban' ? { unappealable: Boolean(flow.unappealable) } : {}),
        ...(flow.warnCode ? { warn: flow.warnCode } : {}),
        ...(result?.banRecord ? { ladderBan: result.banRecord.case_code } : {}),
        dmDelivered: result?.dmDelivered ?? null,
    };
}

/** The result of an action as one flash line. */
export function resultMessage(flow, result) {
    const tr = currentText();
    const parts = [tr.t('moderation.result.done', { action: actionLabel(tr, flow.type), name: flow.targetUsername })];
    if (result.record) parts.push(tr.t('moderation.result.case', { code: result.record.case_code, name: result.record.name }));
    if (result.dmDelivered === false) parts.push(tr.t('moderation.result.dmFailed'));
    else if (result.dmDelivered === true) parts.push(tr.t('moderation.result.dmDelivered'));
    parts.push(...(result.notes || []));
    const warning = `${tr.t('moderation.result.warning')} `;
    return parts.map((p) => plainText(p).replace(/⚠️\s*/g, warning)).join(' ');
}

export function createEnforcementHandlers(core) {
    const {
        client, guildId, settings, sessions, audits, services, enforcement: e, confirms,
        sendHtml, fail, shellOf, checkPost, postLimiter,
    } = core;

    const guildOf = () => client.guilds?.cache?.get(guildId) || null;
    const actorOf = (req) => ({ userId: req.dashboard.session.userId, username: req.dashboard.session.username });
    const canWrite = (req) => Boolean(settings.editEnabled && req.dashboard.access.canAct);
    const isOwner = (req) => Boolean(e.isBotOwner(req.dashboard.session.userId) || guildOf()?.ownerId === req.dashboard.session.userId);

    async function audit(req, module, changes, { modLog = false, label = module } = {}) {
        if (!changes.length) return;
        if (modLog) {
            await core.recordDashboardChange({
                store: audits, postModLog: services.postModLog, client, guildId, actor: actorOf(req), module, moduleLabel: label, changes,
            });
            return;
        }
        // The enforcement services already post to the mod log; only the audit rows here.
        await audits.writeRows(guildId, actorOf(req), module, changes)
            .catch((error) => logger.error(`Dashboard audit write failed (${module}): ${error.message}`));
    }

    /** The configured moderator role (guild config modRole) as an id, or null; a failed read → null (fail closed). */
    async function moderatorRoleId() {
        const config = await Promise.resolve().then(() => e.getGuildConfig(client, guildId)).catch(() => null);
        const role = config?.modRole;
        return typeof role === 'string' ? role : role?.id || null;
    }

    /**
     * The logged-in user's member in the main server, fetched fresh: must still be
     * Administrator — or, for a key the Moderator level may run (permissions.js), still hold
     * the moderator role. `key` defaults to the route's (guardedPost). Sets
     * req.dashboard.fresh = { level, roleId } for the enforcement service's own check.
     */
    async function freshModerator(req, key = req.dashboard.perm || null) {
        const guild = guildOf();
        const member = await guild?.members?.fetch?.({ user: req.dashboard.session.userId, force: true }).catch(() => null);
        if (member && isAdministrator(member)) {
            req.dashboard.fresh = { level: 'admin', roleId: null };
            return member;
        }
        if (member && requiredLevel(key) === MODERATOR) {
            const roleId = await moderatorRoleId();
            if (roleId && memberHasConfiguredModeratorRole(member, { modRole: roleId })) {
                req.dashboard.fresh = { level: MODERATOR, roleId };
                return member;
            }
            throw new InputError(textOf(req).t('moderation.access.needModRole'), 403);
        }
        throw new InputError(textOf(req).t('moderation.access.needAdmin'), 403);
    }

    /** What executeAction needs for a moderator (the service re-checks role + action type). */
    const staffRoleOf = (req) => (req.dashboard.fresh?.level === MODERATOR
        ? { roleId: req.dashboard.fresh.roleId, actions: moderatorActionTypes() } : null);

    /** Refuses an enforcement type the level may not run (ban, unban, remove warn for moderators). */
    function assertActionAllowed(req, type) {
        if (!mayRun(req.dashboard.access, `action:${type}`)) {
            const tr = textOf(req);
            throw new InputError(tr.t('moderation.access.actionNeedsAdmin', { action: actionLabel(tr, type) || tr.t('moderation.access.thisAction') }), 403);
        }
    }

    async function flash(req, message) {
        await sessions.setFlash?.(req.dashboard.session.id, plainText(message));
    }

    /**
     * The POST framework for every Phase 3 form: rate limit → same origin + CSRF → edit
     * switch → Administrator (or OWNER_IDS for `owner`) → main server reachable → run.
     * Expected errors (bad input, service refusals, the mass-action guard) re-render the
     * page with the message; nothing is changed.
     */
    function guardedPost(run, { rerender, need = 'act', perm = null }) {
        return async (req, res) => {
            const session = req.dashboard.session;
            const tr = textOf(req);
            if (!postLimiter.allow(session.idHash)) {
                res.set('Retry-After', '60');
                return fail(res, 429, tr.t('errors.slowDown'), tr.t('errors.tooManyChanges'), req);
            }
            if (!checkPost(req)) return fail(res, 403, tr.t('errors.notAllowed'), tr.t('errors.csrf'), req);
            if (!settings.editEnabled) return fail(res, 403, tr.t('errors.editingOff'), tr.t('errors.editingOffText'), req);
            // perm: the permissions.js key; null → Administrator only (canAct), as before.
            const allowed = need === 'owner' ? isOwner(req) : mayRun(req.dashboard.access, perm);
            if (!allowed) {
                return fail(res, 403, tr.t('errors.notAllowed'), need === 'owner'
                    ? tr.t('moderation.access.ownerOnly')
                    : tr.t('moderation.access.enforcementAdmin'), req);
            }
            if (!guildOf()) return fail(res, 503, tr.t('errors.serverUnavailable'), tr.t('errors.serverUnavailableText'), req);
            req.dashboard.perm = perm;
            try {
                const result = await run(req, res);
                // Owner-only actions (lift a mass-action block) by an owner without Administrator.
                if (!req.dashboard.access.canAct && isOwner(req)) {
                    await recordOwnerOverride({ client, guildId, userId: session.userId, username: session.username, action: req.path, via: 'dashboard' });
                }
                return result;
            } catch (error) {
                if (!isExpectedError(error)) throw error;
                const message = plainText(error.userMessage || error.message);
                logger.info(`Dashboard ${req.method} ${req.path || ''} refused for ${session.userId}: ${message}`);
                return rerender(req, res, errorStatus(error), message);
            }
        };
    }

    // ── Members ──────────────────────────────────────────────────────────

    // The member cache can be incomplete after a restart; fetch everyone at most every 5 minutes.
    let lastMemberFetch = 0;
    async function completeMemberCache(guild) {
        if (!guild?.memberCount || guild.members.cache.size >= guild.memberCount * 0.9) return;
        if (Date.now() - lastMemberFetch < 5 * 60 * 1000) return;
        lastMemberFetch = Date.now();
        await Promise.race([guild.members.fetch().catch(() => null), new Promise((resolve) => setTimeout(resolve, 8000))]);
    }

    /** GET /dashboard/users: the Members list (filters in the query); an ID opens that member. */
    /** GET /dashboard/bans: everyone banned in the main server, with their case; ?q=&filter=&page= */
    async function bans(req, res) {
        const guild = guildOf();
        const filters = { q: queryText(req.query, 'q', 40), filter: Object.hasOwn(BAN_FILTERS, queryText(req.query, 'filter', 12)) ? queryText(req.query, 'filter', 12) : '' };
        const page = Math.max(0, Number.parseInt(queryText(req.query, 'page', 6), 10) || 0);
        let list = null;
        let error = null;
        if (!guild) {
            error = textOf(req).t('errors.serverUnavailableText');
        } else {
            try {
                const [banned, cases] = await Promise.all([
                    guild.bans.fetch({ limit: 1000 }).then((c) => [...c.values()]),
                    e.activeBanCases(guildId),
                ]);
                const plain = banned.map((b) => ({
                    reason: b.reason || null,
                    user: { id: b.user.id, username: b.user.username, globalName: b.user.globalName || null, avatarUrl: typeof b.user.displayAvatarURL === 'function' ? b.user.displayAvatarURL({ size: 64 }) : null },
                }));
                list = listBans(plain, cases, { ...filters, page });
            } catch (err) {
                logger.warn(`Dashboard bans list failed: ${err.message}`);
                error = textOf(req).t('moderation.members.bansFailed');
            }
        }
        return sendHtml(res, error && !list ? 503 : 200, bansPage({ ...shellOf(req), list, filters, error, canAct: req.dashboard.access.canAct }));
    }

    async function users(req, res) {
        const filters = {
            q: queryText(req.query, 'q', 40), role: queryText(req.query, 'role', 20), joined: queryText(req.query, 'joined', 5),
            state: queryText(req.query, 'state', 10), sort: queryText(req.query, 'sort', 12),
        };
        if (!Object.hasOwn(JOINED_FILTERS, filters.joined)) filters.joined = '';
        if (!Object.hasOwn(STATE_FILTERS, filters.state)) filters.state = '';
        if (!Object.hasOwn(SORTS, filters.sort)) filters.sort = 'joined_desc';
        if (!isSnowflake(filters.role)) filters.role = '';
        const page = Math.max(0, Number.parseInt(queryText(req.query, 'page', 5), 10) || 0);
        const guild = guildOf();
        const render = (status, extra = {}) => sendHtml(res, status, membersPage({ ...shellOf(req), filters, ...extra }));
        if (!guild) return render(200, { loading: true });
        const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id)
            .sort((a, b) => (b.position || 0) - (a.position || 0)).map((r) => ({ id: r.id, name: r.name }));
        if (isSnowflake(filters.q) && !guild.members.cache.has(filters.q)) {
            // Not in the server: still open the page when the user exists (cases, bans, notes).
            const user = await client.users.fetch(filters.q).catch(() => null);
            if (user) return res.redirect(302, path(`/users/${filters.q}`));
            return render(404, { roles, error: textOf(req).t('moderation.members.noUserWithId', { id: filters.q }) });
        }
        if (isSnowflake(filters.q)) return res.redirect(302, path(`/users/${filters.q}`));
        await completeMemberCache(guild);
        const standings = await e.memberStandings(guildId);
        return render(200, { roles, canWrite: canWrite(req), list: listMembers(guild, standings, { ...filters, page }) });
    }

    async function loadUserView(req, userId, { precedentReason = '' } = {}) {
        const guild = guildOf();
        if (!guild) return null;
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) return null;
        const state = await e.getTargetState(guild, userId);
        const [{ rows: cases, total }, appealStatuses, countedWarns, notes, block, precedent] = await Promise.all([
            e.listCasesForUser(guildId, userId, { limit: RECENT_CASES }),
            e.getLatestAppealStatuses(userId),
            e.getCountedWarns(guildId, userId, state.ladder.level),
            e.listNotes(guildId, userId),
            e.getMassActionBlock(guildId, req.dashboard.session.userId).catch(() => null),
            precedentReason && isKnownReasonKey(precedentReason) && precedentReason !== CUSTOM_REASON_KEY
                ? e.precedentHint(guildId, precedentReason, getReason(precedentReason)?.label || precedentReason).catch(() => null) : null,
        ]);
        // The timeline is extra: a database problem leaves it out (the page says so), never the page.
        const timeline = e.memberTimeline
            ? await e.memberTimeline(guildId, userId, { includeReports: Boolean(req.dashboard.access.canAct) }).catch(() => null) : [];
        const noContact = e.getActiveOrdersFor(guildId, userId) || [];
        const noContactNames = new Map(noContact.map((o) => [o.otherId, client.users.cache?.get?.(o.otherId)?.username || null]));
        const member = state.member;
        // What this moderator may change on this member (roles, nickname, timeout).
        let memberEdit = null;
        if (member) {
            const actorMember = await guild.members.fetch({ user: req.dashboard.session.userId }).catch(() => null);
            const ctx = { guild, target: member, actorId: req.dashboard.session.userId, actorMember, actorIsOwner: isOwner(req), botMember: guild.members.me };
            const until = member.communicationDisabledUntilTimestamp;
            // The verified role, when verification is on and they have it (for "Unverify").
            const verification = (await e.getGuildConfig(client, guildId).catch(() => null))?.verification;
            const verifiedRole = verification?.enabled && verification.roleId && member.roles?.cache?.has?.(verification.roleId)
                ? (guild.roles.cache.get(verification.roleId) || null) : null;
            memberEdit = {
                verifiedRole: verifiedRole ? { id: verifiedRole.id, name: verifiedRole.name } : null,
                problem: targetProblem(ctx),
                assignable: assignableRoles(ctx).filter((r) => !member.roles?.cache?.has?.(r.id)),
                removable: new Set([...(member.roles?.cache?.values?.() || [])].filter((r) => !roleProblem({ ...ctx, role: r })).map((r) => r.id)),
                timeoutUntil: until > Date.now() ? new Date(until) : null,
                tempRoles: new Map((await e.listTempRoles(guildId, userId).catch(() => [])).map((row) => [row.role_id, new Date(row.expires_at)])),
            };
        }
        return {
            timeline,
            user: {
                id: user.id, username: user.username, globalName: user.globalName || null, bot: Boolean(user.bot), createdAt: user.createdAt,
                avatarUrl: typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 128 }) : null,
            },
            member: member ? {
                nickname: member.nickname || null,
                joinedAt: member.joinedAt || null,
                roles: [...(member.roles?.cache?.values?.() || [])].filter((r) => r.id !== guild.id)
                    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0)).map((r) => ({ id: r.id, name: r.name })),
            } : null,
            memberEdit,
            state, cases, casesTotal: total, appealStatuses, countedWarns, notes, block,
            noContact, noContactNames,
            actions: availableActions(state),
            precedentReason: precedentReason && isKnownReasonKey(precedentReason) ? precedentReason : '',
            precedent: precedent ? plainText(precedent) : null,
        };
    }

    async function renderUser(req, res, status = 200, { error = null, values = {} } = {}) {
        const userId = userIdParam(req);
        const view = userId ? await loadUserView(req, userId, { precedentReason: queryText(req.query, 'reason', 50) }) : null;
        if (!view) return fail(res, 404, textOf(req).t('errors.notFound'), textOf(req).t('moderation.members.noUser'), req);
        return sendHtml(res, status, userPage({
            ...shellOf(req), view, canAct: req.dashboard.access.canAct, editEnabled: settings.editEnabled,
            allow: (key) => mayRun(req.dashboard.access, key),
            flash: status === 200 ? req.dashboard.flash : null, error, values,
        }));
    }

    const userPageHandler = (req, res) => renderUser(req, res);
    const rerenderUser = (req, res, status, message) => renderUser(req, res, status, { error: message, values: { ...(req.body || {}), csrf: undefined } });

    const actionPreview = guardedPost(async (req, res) => {
        const userId = userIdParam(req);
        if (!userId) throw new InputError(textOf(req).t('moderation.members.notUserId'));
        const type = text(req.body, 'type', 20);
        if (!ACTION_TYPES.includes(type)) throw new InputError(textOf(req).t('moderation.members.unknownAction'));
        assertActionAllowed(req, type);
        const guild = guildOf();
        const targetUser = await client.users.fetch(userId).catch(() => null);
        if (!targetUser) throw new InputError(textOf(req).t('moderation.members.noUser'));
        const state = await e.getTargetState(guild, userId);
        if (!availableActions(state).includes(type)) {
            throw new InputError(textOf(req).t('moderation.members.notAvailable', { action: actionLabel(textOf(req), type), name: targetUser.username }));
        }
        const moderator = await freshModerator(req, `action:${type}`);
        // A dashboard moderator cannot ban, so not through the warn ladder either (executeAction checks again under the lock).
        if (type === 'warn' && req.dashboard.fresh?.level === MODERATOR && !isAdministrator(moderator) && previewWarn(state.ladder).escalates) {
            throw new InputError(textOf(req).t('moderation.members.warnWouldBan', { name: targetUser.username }), 403);
        }
        const moderatorId = req.dashboard.session.userId;
        let flow;
        if (RECORD_ACTIONS.has(type)) {
            flow = await buildRecordFlow({ guild, moderator, moderatorId, targetUser, type, form: req.body || {}, completeFlowDetails: e.completeFlowDetails });
        } else {
            flow = startFlow({ type, moderatorId, targetUser });
            if (type === 'removewarn') {
                const warnCode = normalizeCaseCode(text(req.body, 'warn', 10));
                const counted = await e.getCountedWarns(guildId, userId, state.ladder.level);
                if (!warnCode || !counted.some((w) => w.case_code === warnCode)) throw new InputError(textOf(req).t('moderation.members.chooseCountedWarn'));
                flow.warnCode = warnCode;
            }
            Object.assign(flow, liftReasonPatch(flow, text(req.body, 'reason', 500), 'the dashboard'));
        }
        const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: `user:${userId}`, payload: flow });
        const block = await e.getMassActionBlock(guildId, moderatorId).catch(() => null);
        return sendHtml(res, 200, actionConfirmPage({ ...shellOf(req), userId, type, summary: flowSummary(flow, { guildId }), token, hash, block }));
    }, { rerender: rerenderUser, perm: 'member.action' });

    const actionExecute = guardedPost(async (req, res) => {
        const userId = userIdParam(req);
        if (!userId) throw new InputError(textOf(req).t('moderation.members.notUserId'));
        const flow = confirms.consume(text(req.body, 'token', 100), {
            session: req.dashboard.session.idHash, subject: `user:${userId}`, hash: text(req.body, 'fh', 100),
        });
        if (!flow) throw new InputError(textOf(req).t('moderation.expired.action'));
        assertActionAllowed(req, flow.type);
        const moderator = await freshModerator(req, `action:${flow.type}`);
        const targetUser = await client.users.fetch(userId).catch(() => null);
        if (!targetUser) throw new InputError(textOf(req).t('moderation.members.noUser'));
        let result;
        try {
            result = await e.executeAction({ guild: guildOf(), moderator, targetUser, flow, staffRole: staffRoleOf(req) });
        } catch (error) {
            if (isExpectedError(error)) throw error;
            logger.error('Dashboard enforcement action failed', { action: flow.type, targetId: flow.targetId, error });
            throw new InputError(textOf(req).t('moderation.members.actionFailed'), 500);
        }
        result.notes = [...(result.notes || []), ...await e.attachFlowEvidence(flow, result.record, moderator.user || { id: moderator.id, username: req.dashboard.session.username })];
        await audit(req, 'actions', [{ key: flow.type, old: null, new: auditFlow(flow, result) }]);
        logger.info(`Dashboard ${flow.type} by ${req.dashboard.session.userId} on ${userId}${result.record ? ` (${result.record.case_code})` : ''}`);
        await flash(req, resultMessage(flow, result));
        return res.redirect(303, path(`/users/${userId}`));
    }, { rerender: rerenderUser, perm: 'member.action' });

    // ── Member changes: roles, nickname, timeout (same hierarchy rule as enforcement) ──

    /** The member of the URL, the moderator as a member, and whether they may change them. */
    async function memberContext(req) {
        const userId = userIdParam(req);
        if (!userId) throw new InputError(textOf(req).t('moderation.members.notUserId'));
        const guild = guildOf();
        // The moderator is fetched fresh and must still be an Administrator, or a moderator for
        // what that level may do (the access check on the request can be up to a minute old).
        const [target, actorMember] = await Promise.all([
            guild.members.fetch({ user: userId, force: true }).catch(() => null),
            freshModerator(req),
        ]);
        const ctx = { guild, userId, target, actorMember, actorIsOwner: isOwner(req), botMember: guild.members.me, actorId: req.dashboard.session.userId };
        const problem = targetProblem(ctx);
        if (problem) throw new InputError(problem);
        return ctx;
    }

    const roleChange = (mode) => guardedPost(async (req, res) => {
        const ctx = await memberContext(req);
        const roleId = text(req.body, 'roleId', 20);
        const role = isSnowflake(roleId) ? ctx.guild.roles.cache.get(roleId) : null;
        const problem = roleProblem({ ...ctx, role });
        if (problem) throw new InputError(problem);
        const has = ctx.target.roles.cache.has(role.id);
        const tr = textOf(req);
        if (mode === 'add' && has && !text(req.body, 'for', 4)) throw new InputError(tr.t('moderation.members.alreadyHasRole', { name: ctx.target.user.username, role: role.name }));
        if (mode === 'remove' && !has) throw new InputError(tr.t('moderation.members.lacksRole', { name: ctx.target.user.username, role: role.name }));
        const typed = text(req.body, 'reason', REASON_MAX);
        const reason = auditReason(req.dashboard.session.username, typed);
        const forKey = mode === 'add' ? text(req.body, 'for', 4) : '';
        if (forKey && !Object.hasOwn(TEMP_ROLE_LENGTHS, forKey)) throw new InputError(tr.t('moderation.members.chooseHowLong'), 400, 'for');
        let until = null;
        if (mode === 'add' && forKey) {
            until = await e.addTempRole({ guildId, member: ctx.target, role, ms: TEMP_ROLE_LENGTHS[forKey].ms, by: { id: req.dashboard.session.userId, username: req.dashboard.session.username }, reason: typed || null, auditReason: reason });
        } else if (mode === 'add') {
            await ctx.target.roles.add(role.id, reason);
        } else {
            await ctx.target.roles.remove(role.id, reason);
            await e.endTempRole(guildId, ctx.userId, role.id);
        }
        const label = `@${role.name}${forKey ? ` for ${TEMP_ROLE_LENGTHS[forKey].label}` : ''}`;
        await audit(req, 'members', [{ key: `role:${ctx.userId}`, old: mode === 'add' ? null : `@${role.name}`, new: mode === 'add' ? label : null }],
            { modLog: true, label: 'Members' });
        const shown = forKey ? tr.t('moderation.members.roleFor', { role: role.name, length: lengthLabel(tr, forKey, TEMP_ROLE_LENGTHS[forKey].label) }) : `@${role.name}`;
        await flash(req, mode === 'add' ? tr.t('moderation.members.gaveRole', { label: shown, name: ctx.target.user.username }) : tr.t('moderation.members.tookRole', { role: role.name, name: ctx.target.user.username }));
        return res.redirect(303, path(`/users/${ctx.userId}`));
    }, { rerender: rerenderUser, perm: 'member.roles' });
    const roleAdd = roleChange('add');
    const roleRemove = roleChange('remove');

    const nickname = guardedPost(async (req, res) => {
        const ctx = await memberContext(req);
        const nick = text(req.body, 'nickname', NICKNAME_MAX);
        const before = ctx.target.nickname || null;
        if ((nick || null) === before) throw new InputError(textOf(req).t('moderation.members.sameNickname'));
        await ctx.target.setNickname(nick || null, auditReason(req.dashboard.session.username, text(req.body, 'reason', REASON_MAX)));
        await audit(req, 'members', [{ key: `nickname:${ctx.userId}`, old: before, new: nick || null }], { modLog: true, label: 'Members' });
        await flash(req, nick ? textOf(req).t('moderation.members.nicknameSet', { nick }) : textOf(req).t('moderation.members.nicknameRemoved'));
        return res.redirect(303, path(`/users/${ctx.userId}`));
    }, { rerender: rerenderUser, perm: 'member.nickname' });

    const timeout = guardedPost(async (req, res) => {
        const ctx = await memberContext(req);
        const choice = text(req.body, 'duration', 5);
        const lift = choice === 'off';
        const tr = textOf(req);
        if (!lift && !Object.hasOwn(TIMEOUTS, choice)) throw new InputError(tr.t('moderation.members.chooseTimeout'), 400, 'duration');
        if (!lift && ctx.target.permissions?.has?.(PermissionFlagsBits.Administrator)) {
            throw new InputError(tr.t('moderation.members.timeoutAdmin'));
        }
        const until = ctx.target.communicationDisabledUntilTimestamp;
        if (lift && !(until > Date.now())) throw new InputError(tr.t('moderation.members.notTimedOut', { name: ctx.target.user.username }));
        const reason = auditReason(req.dashboard.session.username, text(req.body, 'reason', REASON_MAX));
        await ctx.target.timeout(lift ? null : TIMEOUTS[choice].ms, reason);
        await audit(req, 'members', [{ key: `timeout:${ctx.userId}`, old: until > Date.now() ? new Date(until).toISOString() : null, new: lift ? null : TIMEOUTS[choice].label }],
            { modLog: true, label: 'Members' });
        await flash(req, lift ? tr.t('moderation.members.timeoutRemoved', { name: ctx.target.user.username }) : tr.t('moderation.members.timedOut', { name: ctx.target.user.username, length: lengthLabel(tr, choice, TIMEOUTS[choice].label) }));
        return res.redirect(303, path(`/users/${ctx.userId}`));
    }, { rerender: rerenderUser, perm: 'member.timeout' });

    // Same service as /verification remove: takes the verified role, logs it to the verification log.
    const unverify = guardedPost(async (req, res) => {
        const ctx = await memberContext(req);
        const typed = text(req.body, 'reason', REASON_MAX);
        const result = await e.removeVerification(client, guildId, ctx.userId, { moderatorId: req.dashboard.session.userId, reason: typed || 'admin_removal' });
        if (result?.status === 'not_verified') throw new InputError(textOf(req).t('moderation.members.notVerified', { name: ctx.target.user.username }));
        await audit(req, 'members', [{ key: `verification:${ctx.userId}`, old: 'verified', new: typed ? { verified: false, reason: typed } : null }],
            { modLog: true, label: 'Members' });
        await flash(req, textOf(req).t('moderation.members.unverified', { name: ctx.target.user.username }));
        return res.redirect(303, path(`/users/${ctx.userId}`));
    }, { rerender: rerenderUser, perm: 'member.unverify' });

    // ── Bulk: one action on many members (preview → confirm → background job) ──

    const jobs = createJobStore();
    const listFilters = (src) => {
        const f = { q: text(src, 'q', 40), role: text(src, 'frole', 20), joined: text(src, 'joined', 5), state: text(src, 'state', 10), sort: text(src, 'sort', 12) };
        if (!Object.hasOwn(JOINED_FILTERS, f.joined)) f.joined = '';
        if (!Object.hasOwn(STATE_FILTERS, f.state)) f.state = '';
        if (!Object.hasOwn(SORTS, f.sort)) f.sort = 'joined_desc';
        if (!isSnowflake(f.role)) f.role = '';
        return f;
    };
    const bulkBack = (req, res, status, message) => fail(res, status, textOf(req).t('moderation.bulk.notDone'), message, req);

    /** The members the form points at: ticked ones, or everyone matching the list filters (max BULK_LIMIT). */
    async function bulkTargets(req, guild) {
        if (text(req.body, 'scope', 10) === 'filter') {
            const filters = listFilters(req.body);
            const standings = await e.memberStandings(guildId);
            const all = listMembers(guild, standings, { ...filters, page: 0, pageSize: BULK_LIMIT + 1 });
            if (all.total > BULK_LIMIT) throw new InputError(textOf(req).t('moderation.bulk.tooManyMatch', { total: textOf(req).fmtNumber(all.total), max: textOf(req).fmtNumber(BULK_LIMIT) }));
            return all.rows.map((row) => guild.members.cache.get(row.id)).filter(Boolean);
        }
        const raw = req.body?.ids;
        const ids = [...new Set((Array.isArray(raw) ? raw : raw ? [raw] : []).filter((id) => isSnowflake(String(id))))];
        if (!ids.length) throw new InputError(textOf(req).t('moderation.bulk.tickMember'));
        if (ids.length > BULK_LIMIT) throw new InputError(textOf(req).t('moderation.bulk.tooMany', { max: textOf(req).fmtNumber(BULK_LIMIT) }));
        const members = await Promise.all(ids.map((id) => guild.members.fetch({ user: id }).catch(() => null)));
        return members.filter(Boolean);
    }

    const bulkPreview = guardedPost(async (req, res) => {
        const guild = guildOf();
        const action = text(req.body, 'action', 12);
        if (!Object.hasOwn(BULK_ACTIONS, action)) throw new InputError(textOf(req).t('moderation.bulk.chooseAction'));
        const moderator = await freshModerator(req);
        const roleId = text(req.body, 'roleId', 20);
        const role = action.startsWith('role-') ? (isSnowflake(roleId) ? guild.roles.cache.get(roleId) : null) : null;
        if (action.startsWith('role-') && !role) throw new InputError(textOf(req).t('moderation.bulk.chooseRole'));
        const timeoutKey = text(req.body, 'timeout', 5);
        if (action === 'timeout' && !Object.hasOwn(TIMEOUTS, timeoutKey)) throw new InputError(textOf(req).t('moderation.members.chooseTimeout'));
        const members = await bulkTargets(req, guild);
        const owner = e.isBotOwner(req.dashboard.session.userId);
        let guardLeft = Infinity;
        if ((action === 'kick' || action === 'ban') && !owner) {
            if (await e.getMassActionBlock(guildId, req.dashboard.session.userId)) throw new InputError(textOf(req).t('moderation.bulk.blocked'));
            guardLeft = Math.max(0, enforcementConfig.massActionLimit - await e.recentBanKickCount(guildId, req.dashboard.session.userId));
        }
        const plan = planBulk({ guild, members, action, role, timeoutKey, actorId: req.dashboard.session.userId, actorMember: moderator, actorIsOwner: isOwner(req), botMember: guild.members.me, guardLeft });
        // Kick / ban: the enforcement form is checked now (same flow builder as one member), so the run cannot fail on it.
        const recordForm = { reason: text(req.body, 'reasonKey', 50), custom_reason: text(req.body, 'custom_reason', 500), duration: text(req.body, 'duration', 20), unappealable: text(req.body, 'unappealable', 10) || 'default' };
        let precedent = null;
        if ((action === 'kick' || action === 'ban') && plan.run.length) {
            const first = guild.members.cache.get(plan.run[0].id)?.user || await client.users.fetch(plan.run[0].id);
            // The similar-cases hint applies to every member (same reason); the ladder line does not.
            ({ precedent = null } = await buildRecordFlow({ guild, moderator, moderatorId: moderator.id, targetUser: first, type: action, form: recordForm, completeFlowDetails: e.completeFlowDetails }));
        }
        const forKey = action === 'role-add' ? text(req.body, 'for', 4) : '';
        if (forKey && !Object.hasOwn(TEMP_ROLE_LENGTHS, forKey)) throw new InputError(textOf(req).t('moderation.members.chooseHowLong'));
        const payload = { action, roleId: role?.id || null, timeoutKey, forKey, reason: text(req.body, 'reason', REASON_MAX), recordForm, run: plan.run };
        const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: 'bulk', payload });
        return sendHtml(res, 200, bulkPreviewPage({ ...shellOf(req), action, label: BULK_ACTIONS[action], role, timeout: TIMEOUTS[timeoutKey] || TEMP_ROLE_LENGTHS[forKey] || null, plan, token, hash, guardLeft, precedent }));
    }, { rerender: bulkBack, perm: 'member.bulk' });

    const bulkExecute = guardedPost(async (req, res) => {
        const payload = confirms.consume(text(req.body, 'token', 100), { session: req.dashboard.session.idHash, subject: 'bulk', hash: text(req.body, 'fh', 100) });
        if (!payload) throw new InputError(textOf(req).t('moderation.expired.bulk'));
        const guild = guildOf();
        const moderator = await freshModerator(req);
        const session = req.dashboard.session;
        const role = payload.roleId ? guild.roles.cache.get(payload.roleId) : null;
        const reason = auditReason(session.username, payload.reason);
        const label = `${BULK_ACTIONS[payload.action]}${role ? ` @${role.name}` : ''}${payload.forKey ? ` for ${TEMP_ROLE_LENGTHS[payload.forKey].label}` : ''}${payload.action === 'timeout' ? ` (${TIMEOUTS[payload.timeoutKey].label})` : ''}`;
        // The job page shows the label in the moderator's language; the audit row keeps the English one.
        const tr = textOf(req);
        let shownLabel = bulkLabel(tr, payload.action);
        if (role) shownLabel = tr.t('moderation.bulk.labelRole', { label: shownLabel, role: role.name });
        if (payload.forKey) shownLabel = tr.t('moderation.bulk.labelFor', { label: shownLabel, length: lengthLabel(tr, payload.forKey, TEMP_ROLE_LENGTHS[payload.forKey].label) });
        if (payload.action === 'timeout') shownLabel = tr.t('moderation.bulk.labelTimeout', { label: shownLabel, length: lengthLabel(tr, payload.timeoutKey, TIMEOUTS[payload.timeoutKey].label) });
        // The moderator must still be an Administrator for every member; once that fails, the
        // rest of the job stops without touching Discord.
        let revoked = null;
        const work = async (item) => {
            if (revoked) throw revoked;
            const moderator = await freshModerator(req).catch((error) => { revoked = error; throw error; });
            // Checked again per member at run time (roles and positions can change meanwhile).
            const member = await guild.members.fetch({ user: item.id, force: true }).catch(() => null);
            const problem = targetProblem({ guild, target: member, actorId: session.userId, actorMember: moderator, actorIsOwner: isOwner(req), botMember: guild.members.me })
                || (role ? roleProblem({ guild, role, actorMember: moderator, actorIsOwner: isOwner(req), botMember: guild.members.me }) : null);
            if (problem) throw new InputError(problem);
            if (payload.action === 'role-add' && payload.forKey) {
                return e.addTempRole({ guildId, member, role, ms: TEMP_ROLE_LENGTHS[payload.forKey].ms, by: { id: session.userId, username: session.username }, reason: payload.reason || null, auditReason: reason });
            }
            if (payload.action === 'role-add') return member.roles.add(role.id, reason);
            if (payload.action === 'role-remove') {
                await member.roles.remove(role.id, reason);
                return e.endTempRole(guildId, member.id, role.id);
            }
            if (payload.action === 'timeout') return member.timeout(TIMEOUTS[payload.timeoutKey].ms, reason);
            const flow = await buildRecordFlow({ guild, moderator, moderatorId: moderator.id, targetUser: member.user, type: payload.action, form: payload.recordForm, completeFlowDetails: e.completeFlowDetails });
            return e.executeAction({ guild, moderator, targetUser: member.user, flow });
        };
        const job = jobs.start({
            session: session.idHash, label: shownLabel, items: payload.run, work,
            onDone: async (finished) => {
                await audit(req, 'members', [{ key: `bulk:${payload.action}`, old: null, new: `${label}: ${finished.done.length} done, ${finished.failed.length} failed` }],
                    { modLog: true, label: 'Members (bulk)' });
            },
        });
        logger.info(`Dashboard bulk ${payload.action} by ${session.userId}: ${payload.run.length} members (job ${job.id})`);
        return res.redirect(303, path(`/users/bulk/${job.id}`));
    }, { rerender: bulkBack, perm: 'member.bulk' });

    /** GET /dashboard/users/bulk/:job: progress (refreshes itself while running), then the result. */
    async function bulkJob(req, res) {
        const id = typeof req.params?.job === 'string' ? req.params.job.slice(0, 40) : '';
        const job = jobs.get(id, req.dashboard.session.idHash);
        if (!job) return fail(res, 404, textOf(req).t('errors.notFound'), textOf(req).t('moderation.bulk.unknownJob'), req);
        return sendHtml(res, 200, bulkJobPage({ ...shellOf(req), job }));
    }

    const noteAdd = guardedPost(async (req, res) => {
        const userId = userIdParam(req);
        if (!userId) throw new InputError(textOf(req).t('moderation.members.notUserId'));
        const content = multiline(req.body, 'note', 1000);
        if (!content) throw new InputError(textOf(req).t('moderation.notes.empty'));
        const note = await e.addNote(guildId, userId, content, { id: req.dashboard.session.userId, tag: req.dashboard.session.username });
        await audit(req, 'notes', [{ key: `note:${userId}`, old: null, new: note?.content ?? content }], { modLog: true, label: 'Staff notes' });
        await flash(req, textOf(req).t('moderation.notes.added'));
        return res.redirect(303, path(`/users/${userId}`));
    }, { rerender: rerenderUser, perm: 'member.notes' });

    const noteRemove = guardedPost(async (req, res) => {
        const userId = userIdParam(req);
        if (!userId) throw new InputError(textOf(req).t('moderation.members.notUserId'));
        const noteId = text(req.body, 'note', 20);
        if (!/^\d{1,16}$/.test(noteId)) throw new InputError(textOf(req).t('moderation.notes.notNote'));
        const removed = await e.removeNote(guildId, userId, { id: noteId });
        if (!removed) throw new InputError(textOf(req).t('moderation.notes.gone'));
        await audit(req, 'notes', [{ key: `note:${userId}`, old: removed.content, new: null }], { modLog: true, label: 'Staff notes' });
        await flash(req, textOf(req).t('moderation.notes.removed'));
        return res.redirect(303, path(`/users/${userId}`));
    }, { rerender: rerenderUser, perm: 'member.notes' });

    // ── Cases ────────────────────────────────────────────────────────────

    /** Loads the case of the URL in the main server, or throws a 404-ish InputError. */
    async function caseOf(req) {
        const code = caseCodeParam(req);
        const record = code ? await e.getCaseByCode(code) : null;
        if (!record || record.guild_id !== guildId) throw new InputError(textOf(req).t('moderation.case.noCase'), 404);
        return record;
    }

    const rerenderCase = (req, res, status, message) => core.renderCase(req, res, status, { error: message });

    const caseEdit = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        const reasonRaw = text(req.body, 'reason', 500);
        const reason = reasonRaw && reasonRaw !== record.reason ? reasonRaw : undefined;
        const durationMs = parseEditDuration(text(req.body, 'duration', 20));
        if (reason === undefined && durationMs === undefined) throw new InputError(textOf(req).t('moderation.case.giveChange'));
        const moderator = await freshModerator(req);
        const { after, changes } = await e.editCase(client, {
            guildId, caseCode: record.case_code, editor: { id: moderator.id, username: moderator.user?.username || req.dashboard.session.username }, reason, durationMs,
        });
        await audit(req, 'cases', changes.map((c) => ({ key: `${record.case_code}.${c.field}`, old: c.oldValue, new: c.newValue })));
        const ended = changes.some((c) => c.field === 'duration') && after.expires_at && new Date(after.expires_at) <= new Date();
        const tr = textOf(req);
        await flash(req, tr.t(ended ? 'moderation.case.editedEnded' : 'moderation.case.edited', { code: record.case_code, fields: fieldList(tr, changes.map((c) => c.field)) }));
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase, perm: 'case.edit' });

    /**
     * POST /cases/:code/void. Without a token: checks the case and the reason and shows the
     * confirm page (nothing changes). With the page's one-time token: the stored reason is
     * used, the case and the moderator are checked again, then the case is voided.
     */
    const caseVoid = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        if (!text(req.body, 'token', 100)) {
            const tr = textOf(req);
            const reason = text(req.body, 'reason', 500);
            if (!reason) throw new InputError(tr.t('moderation.case.reasonEmpty'));
            if (record.voided_at) throw new InputError(tr.t('moderation.case.alreadyRemoved', { code: record.case_code }));
            await freshModerator(req);
            const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: `void:${record.case_code}`, payload: { caseCode: record.case_code, reason } });
            return sendHtml(res, 200, confirmPage({
                ...shellOf(req), active: 'cases', title: tr.t('moderation.case.voidTitle', { code: record.case_code }), heading: tr.t('moderation.case.voidHeading', { code: record.case_code }),
                rows: [
                    { label: tr.t('moderation.case.rowCase'), value: `${record.case_code} · ${record.type} · ${record.name}` },
                    { label: tr.t('moderation.case.rowMember'), value: `${record.target_username} (${record.target_user_id})` },
                    { label: tr.t('moderation.case.rowReason'), value: reason },
                    { label: tr.t('moderation.case.rowEffect'), value: voidEffect(record) },
                ],
                actionPath: `/cases/${record.case_code}/void`, hidden: { token, fh: hash }, submit: tr.t('moderation.case.removeSubmit'), cancelHref: path(`/cases/${record.case_code}`),
            }));
        }
        const payload = confirms.consume(text(req.body, 'token', 100), { session: req.dashboard.session.idHash, subject: `void:${record.case_code}`, hash: text(req.body, 'fh', 100) });
        if (!payload) throw new InputError(textOf(req).t('moderation.expired.void'));
        const moderator = await freshModerator(req);
        const admin = { id: moderator.id, username: moderator.user?.username || req.dashboard.session.username };
        const { record: voided, notes, dmDelivered } = await e.voidCase(client, { guildId, caseCode: record.case_code, admin, reason: payload.reason });
        await audit(req, 'cases', [{ key: `${record.case_code}.void`, old: null, new: payload.reason }]);
        const tr = textOf(req);
        await flash(req, [tr.t('moderation.case.removed', { code: voided.case_code }), ...notes, tr.t(dmDelivered ? 'moderation.case.dmDelivered' : 'moderation.case.dmNotDelivered')].join(' '));
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase, perm: 'case.edit' });

    const evidenceAdd = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        const entries = parseEvidenceUrls(text(req.body, 'link', 500));
        if (entries.length !== 1) throw new InputError(textOf(req).t('moderation.evidence.oneLink'));
        const note = text(req.body, 'note', 300) || null;
        const [entry] = await e.captureLinks(guildOf(), entries);
        const row = await e.addEvidence(record.case_code, {
            kind: 'link', url: entry.url, sourceMessageUrl: entry.sourceMessageUrl, excerpt: entry.excerpt, note,
            addedBy: { id: req.dashboard.session.userId, username: req.dashboard.session.username },
        });
        await audit(req, 'cases', [{ key: `${record.case_code}.evidence`, old: null, new: entry.url }], { modLog: true, label: `Case ${record.case_code} evidence` });
        await flash(req, textOf(req).t(entry.sourceMessageUrl && !entry.excerpt ? 'moderation.evidence.addedLinkOnly' : 'moderation.evidence.added', { id: row.id }));
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase, perm: 'case.evidence' });

    // An evidence image from the web: the multipart body was size-capped (express.raw)
    // and parsed by multipart.js before this runs (req.upload); only PNG / JPEG / GIF /
    // WebP recognised by their first bytes are accepted, then re-hosted in the evidence
    // channel by addImageEvidence (the same function /case evidence add uses).
    const evidenceUpload = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        const file = req.upload?.file || null;
        if (!file) throw new InputError(textOf(req).t('moderation.evidence.chooseImage'));
        const image = sniffImage(file.data);
        if (!image) throw new InputError(textOf(req).t('moderation.evidence.notImage'));
        const note = text(req.body, 'note', 300) || null;
        const row = await e.addImageEvidence(client, record.case_code, {
            data: file.data, name: evidenceFileName(record.case_code, image.ext), contentType: image.type,
        }, { note, addedBy: { id: req.dashboard.session.userId, username: req.dashboard.session.username }, guildId: record.guild_id });
        await audit(req, 'cases', [{ key: `${record.case_code}.evidence`, old: null, new: `image #${row.id} (${image.type}, ${file.data.length} bytes)` }], { modLog: true, label: `Case ${record.case_code} evidence` });
        await flash(req, textOf(req).t('moderation.evidence.imageAdded', { id: row.id }));
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase, perm: 'case.evidence' });

    const evidenceRemove = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        const id = text(req.body, 'id', 12);
        if (!/^\d{1,12}$/.test(id)) throw new InputError(textOf(req).t('moderation.evidence.notNumber'));
        const removed = await e.removeEvidence(record.case_code, Number(id));
        if (!removed) throw new InputError(textOf(req).t('moderation.evidence.none', { code: record.case_code, id }));
        await audit(req, 'cases', [{ key: `${record.case_code}.evidence`, old: removed.url || `image #${id}`, new: null }], { modLog: true, label: `Case ${record.case_code} evidence` });
        await flash(req, textOf(req).t(removed.kind === 'image' ? 'moderation.evidence.removedImage' : 'moderation.evidence.removed', { id }));
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase, perm: 'case.evidence' });

    /**
     * POST /cases/bulk: one action on the ticked cases of the Cases page. Add or remove a tag
     * (up to 25 cases), or void (up to 10, with a reason; a confirm page lists them first: each one lifts what is
     * still in effect and DMs the member, exactly like voiding one case). Audited per case.
     */
    const bulkCasesError = (req, res, status, message) => {
        const tr = textOf(req);
        return sendHtml(res, status, layout({
            ...shellOf(req), title: tr.t('frame.nav.items.cases'), active: 'cases',
            body: html`<header class="page-head"><h1>${tr.t('moderation.cases.nothingChanged')}</h1></header><p class="error" role="alert">${message}</p><p><a href="${path('/cases')}">${tr.t('moderation.cases.backToCases')}</a></p>`,
        }));
    };
    const BULK_TAG_MAX = 25;
    const BULK_VOID_MAX = 10;
    const caseBulk = guardedPost(async (req, res) => {
        const raw = req.body?.codes;
        const codes = [...new Set((Array.isArray(raw) ? raw : [raw]).map((c) => normalizeCaseCode(String(c || ''))).filter(Boolean))];
        const action = text(req.body, 'action', 20);
        const tr = textOf(req);
        if (!codes.length) throw new InputError(tr.t('moderation.cases.tickCase'));
        if (!['tag-add', 'tag-remove', 'void'].includes(action)) throw new InputError(tr.t('moderation.cases.chooseAction'));
        const records = [];
        for (const code of codes) {
            const record = await e.getCaseByCode(code);
            if (record && record.guild_id === guildId) records.push(record);
        }
        if (!records.length) throw new InputError(tr.t('moderation.cases.noneExist'));
        const done = [];
        const skipped = [];
        if (action === 'void') {
            if (records.length > BULK_VOID_MAX) throw new InputError(tr.t('moderation.cases.removeMax', { max: BULK_VOID_MAX }));
            const reason = text(req.body, 'reason', 500);
            if (!reason) throw new InputError(tr.t('moderation.cases.giveReason'));
            await freshModerator(req);
            const open = records.filter((r) => !r.voided_at);
            if (!open.length) throw new InputError(tr.t('moderation.cases.allRemoved'));
            const payload = { codes: open.map((r) => r.case_code), reason };
            const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: 'cases:void', payload });
            const already = records.filter((r) => r.voided_at).map((r) => r.case_code);
            return sendHtml(res, 200, confirmPage({
                ...shellOf(req), active: 'cases', title: tr.t('moderation.cases.removeTitle'), heading: tr.tp('moderation.cases.removeHeading', open.length),
                rows: [{ label: tr.t('moderation.cases.rowReason'), value: reason }],
                list: { title: tr.t('moderation.cases.willRemove', { count: tr.fmtNumber(open.length) }), items: open.map((r) => `${r.case_code} · ${r.type} · ${r.target_username} (${r.target_user_id}): ${voidEffect(r)}`) },
                notes: already.length ? [tr.t('moderation.cases.skippedRemoved', { codes: already.join(', ') })] : [],
                actionPath: '/cases/bulk/void', hidden: { token, fh: hash }, submit: tr.tp('moderation.cases.removeSubmit', open.length), cancelHref: path('/cases'),
            }));
        }
        if (records.length > BULK_TAG_MAX) throw new InputError(tr.t('moderation.cases.tagMax', { max: BULK_TAG_MAX }));
        let tag;
        try { [tag] = normalizeTags(text(req.body, 'tag', 21)); } catch (error) { throw new InputError(error.userMessage); }
        if (!tag) throw new InputError(tr.t('moderation.cases.giveTag'));
        for (const record of records) {
            const before = record.tags || [];
            const next = action === 'tag-add' ? [...new Set([...before, tag])].sort() : before.filter((t) => t !== tag);
            if (next.length === before.length && next.every((t, i) => t === before[i])) continue;
            if (next.length > 10) { skipped.push(tr.t('moderation.cases.tagLimit', { code: record.case_code })); continue; }
            await e.setCaseTags(guildId, record.case_code, next);
            await audit(req, 'cases', [{ key: `${record.case_code}.tags`, old: before.join(', ') || null, new: next.join(', ') || null }]);
            done.push(record.case_code);
        }
        await flash(req, [tr.tp(action === 'tag-add' ? 'moderation.cases.tagged' : 'moderation.cases.untagged', done.length, { tag }),
            ...(skipped.length ? [tr.t('moderation.cases.skipped', { list: skipped.join(', ') })] : [])].join(' '));
        return res.redirect(303, path('/cases'));
    }, { rerender: bulkCasesError, perm: 'case.edit' });

    /** POST /cases/bulk/void: runs the bulk void the confirm page showed (one-time token). */
    const caseBulkVoid = guardedPost(async (req, res) => {
        const payload = confirms.consume(text(req.body, 'token', 100), { session: req.dashboard.session.idHash, subject: 'cases:void', hash: text(req.body, 'fh', 100) });
        if (!payload) throw new InputError(textOf(req).t('moderation.expired.cases'));
        const moderator = await freshModerator(req);
        const admin = { id: moderator.id, username: moderator.user?.username || req.dashboard.session.username };
        const done = [];
        const skipped = [];
        const tr = textOf(req);
        for (const code of payload.codes) {
            const record = await e.getCaseByCode(code);
            if (!record || record.guild_id !== guildId) { skipped.push(tr.t('moderation.cases.goneItem', { code })); continue; }
            if (record.voided_at) { skipped.push(tr.t('moderation.cases.removedItem', { code })); continue; }
            try {
                await e.voidCase(client, { guildId, caseCode: code, admin, reason: payload.reason });
                await audit(req, 'cases', [{ key: `${code}.void`, old: null, new: payload.reason }]);
                done.push(code);
            } catch (error) {
                skipped.push(tr.t('moderation.cases.failedItem', { code, error: plainText(error.userMessage || tr.t('moderation.cases.notRemoved')) }));
            }
        }
        await flash(req, [tr.t('moderation.cases.removedList', { list: done.join(', ') || tr.t('moderation.cases.none') }),
            ...(skipped.length ? [tr.t('moderation.cases.skipped', { list: skipped.join(', ') })] : [])].join(' '));
        return res.redirect(303, path('/cases'));
    }, { rerender: bulkCasesError, perm: 'case.edit' });

    /** Notes and tags on a case (staff-only; caseNotesService.js). */
    const noteError = (error) => (error?.userMessage && !(error instanceof InputError) ? new InputError(error.userMessage) : error);
    const caseNote = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        const note = text(req.body, 'text', 1000).trim();
        if (!note) throw new InputError(textOf(req).t('moderation.notes.empty'));
        try {
            await e.addCaseNote(guildId, record.case_code, { id: req.dashboard.session.userId, username: req.dashboard.session.username }, note);
        } catch (error) { throw noteError(error); }
        await audit(req, 'cases', [{ key: `${record.case_code}.note`, old: null, new: 'added' }]);
        await flash(req, textOf(req).t('moderation.case.noteAdded'));
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase, perm: 'case.evidence' });

    const caseTags = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        let result;
        try {
            result = await e.setCaseTags(guildId, record.case_code, normalizeTags(text(req.body, 'tags', 250)));
        } catch (error) { throw noteError(error); }
        await audit(req, 'cases', [{ key: `${record.case_code}.tags`, old: result.before.join(', ') || null, new: result.after.join(', ') || null }]);
        await flash(req, result.after.length ? textOf(req).t('moderation.case.tagsSaved', { tags: result.after.map((t) => `#${t}`).join(' ') }) : textOf(req).t('moderation.case.tagsRemoved'));
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase, perm: 'case.evidence' });

    // ── Appeals ──────────────────────────────────────────────────────────

    /** Independent appeal review, for the page: { required, issuer, blocked, ownerOverride }. */
    function appealReviewState(record, viewerId) {
        const botUserId = client.user?.id || null;
        if (!needsSecondReviewer(record, { botUserId })) return { required: false };
        const check = checkAppealReviewer(record, viewerId, { botUserId, isOwner: e.isBotOwner });
        return { required: true, issuer: record.moderator_username, blocked: !check.allowed, message: check.message || null, ownerOverride: Boolean(check.ownerOverride) };
    }

    async function renderAppeal(req, res, status = 200, { error = null } = {}) {
        const code = caseCodeParam(req);
        const record = code ? await e.getCaseByCode(code) : null;
        if (!record || record.guild_id !== guildId) return fail(res, 404, textOf(req).t('errors.notFound'), textOf(req).t('moderation.case.noCase'), req);
        const [appeals, { rows: otherRows, total }, ladder, evidenceRows] = await Promise.all([
            e.getAppealHistory(code),
            e.listCasesForUser(guildId, record.target_user_id, { limit: 16 }),
            e.getLadder(guildId, record.target_user_id).catch(() => null),
            e.listEvidence(code),
        ]);
        const fresh = await e.resolveImageUrls(client, evidenceRows).catch(() => new Map());
        const appeal = appeals.find((a) => a.status === 'pending') || appeals[0] || null;
        let answers = [];
        try {
            answers = appeal ? appealAnswers(appeal.body) : [];
        } catch {
            answers = [{ label: textOf(req).t('moderation.appeal.answers'), value: textOf(req).t('moderation.appeal.unreadable') }];
        }
        const data = {
            record, appeal, answers,
            history: appeals.filter((a) => a !== appeal),
            others: otherRows.filter((c) => c.case_code !== code).slice(0, 15),
            othersTotal: Math.max(0, total - 1),
            ladder,
            evidence: evidenceRows.map((row) => ({ row, freshUrl: fresh.get(String(row.id)) || null })),
            review: appealReviewState(record, req.dashboard.session.userId),
        };
        return sendHtml(res, status, appealDetailPage({
            ...shellOf(req), data, canWrite: canWrite(req), editEnabled: settings.editEnabled, canAct: req.dashboard.access.canAct,
            flash: status === 200 ? req.dashboard.flash : null, error,
        }));
    }

    const appealDetail = (req, res) => renderAppeal(req, res);
    const rerenderAppeal = (req, res, status, message) => renderAppeal(req, res, status, { error: message });

    const appealPreview = guardedPost(async (req, res) => {
        const code = caseCodeParam(req);
        const record = code ? await e.getCaseByCode(code) : null;
        if (!record || record.guild_id !== guildId) throw new InputError(textOf(req).t('moderation.case.noCase'), 404);
        const decision = text(req.body, 'decision', 10);
        if (decision !== 'accept' && decision !== 'deny') throw new InputError(textOf(req).t('moderation.appeal.chooseDecision'));
        const appeals = await e.getAppealHistory(code);
        if (!appeals.some((a) => a.status === 'pending')) throw new InputError(textOf(req).t('moderation.appeal.noPending', { code }));
        const moderator = await freshModerator(req);
        // Independent appeal review: refuse before the confirm step (decideAppeal checks again).
        assertAppealReviewer(record, moderator.id || req.dashboard.session.userId, { client, isOwner: e.isBotOwner });
        const note = multiline(req.body, 'note', 500);
        const payload = { caseCode: code, decision, note };
        const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: `appeal:${code}`, payload });
        return sendHtml(res, 200, appealConfirmPage({ ...shellOf(req), record, decision, note, token, hash }));
    }, { rerender: rerenderAppeal, perm: 'appeal.decide' });

    const appealDecide = guardedPost(async (req, res) => {
        const code = caseCodeParam(req);
        if (!code) throw new InputError(textOf(req).t('moderation.case.noCase'), 404);
        const payload = confirms.consume(text(req.body, 'token', 100), {
            session: req.dashboard.session.idHash, subject: `appeal:${code}`, hash: text(req.body, 'fh', 100),
        });
        if (!payload) throw new InputError(textOf(req).t('moderation.expired.appeal'));
        const moderator = await freshModerator(req);
        const admin = moderator.user || { id: moderator.id, username: req.dashboard.session.username };
        const result = await e.decideAppeal({ client, admin, caseCode: code, decision: payload.decision, note: payload.note || null, via: 'dashboard', callerGuildId: guildId });
        await audit(req, 'appeal-decisions', [{ key: code, old: 'pending', new: { decision: result.label, note: payload.note || null, dmDelivered: result.dmDelivered } }]);
        const tr = textOf(req);
        const decided = result.label === 'accepted' ? tr.t('moderation.appeal.accepted', { code })
            : result.label === 'denied' ? tr.t('moderation.appeal.denied', { code }) : `Appeal on ${code} ${result.label}.`;
        await flash(req, [decided, tr.t(result.dmDelivered ? 'moderation.case.dmDelivered' : 'moderation.case.dmNotDelivered'), ...(result.notes || []),
            ...(result.ownerOverride ? [tr.t('moderation.appeal.ownerOverride')] : [])].join(' '));
        return res.redirect(303, path('/appeals'));
    }, { rerender: rerenderAppeal, perm: 'appeal.decide' });

    // ── No-contact orders ────────────────────────────────────────────────

    async function renderNoContact(req, res, status = 200, { error = null, values = {} } = {}) {
        // The watchlist is Administrator-only (like /case watch list): a moderator may be on it.
        const showWatch = mayRun(req.dashboard.access, 'watchlist.view');
        const [rows, watchRows] = await Promise.all([e.listActiveNoContactOrders(guildId, 100), showWatch ? e.listActiveWatches(guildId, 100) : []]);
        const ids = new Set([...rows.flatMap((o) => [o.user_a, o.user_b, o.created_by]), ...watchRows.flatMap((w) => [w.user_id, w.created_by])]);
        const names = new Map([...ids].map((id) => [id, client.users.cache?.get?.(id)?.username || null]));
        return sendHtml(res, status, noContactPage({
            ...shellOf(req), rows, watchRows, showWatch, names, canWrite: canWrite(req), editEnabled: settings.editEnabled, canAct: req.dashboard.access.canAct,
            flash: status === 200 ? req.dashboard.flash : null, error, values, guild: guildOf(),
        }));
    }

    // GET: members picked with "Find a member" come back as ?user_a= / ?user_b=.
    const noContact = (req, res) => renderNoContact(req, res, 200, {
        values: Object.fromEntries(['user_a', 'user_b'].map((k) => [k, parseUserRef(queryText(req.query, k, 25)) || ''])),
    });
    const rerenderNoContact = (req, res, status, message) => renderNoContact(req, res, status, { error: message, values: { ...(req.body || {}), csrf: undefined } });

    const noContactAdd = guardedPost(async (req, res) => {
        // A picked member (ID), a pasted ID or an @mention.
        const userA = parseUserRef(text(req.body, 'user_a', 40));
        const userB = parseUserRef(text(req.body, 'user_b', 40));
        if (!userA || !userB) throw new InputError(textOf(req).t('moderation.keepApart.pickBoth'));
        const days = Number(text(req.body, 'days', 4));
        if (!Number.isInteger(days) || days < 1 || days > NO_CONTACT_MAX_DAYS) throw new InputError(textOf(req).t('moderation.keepApart.days', { max: NO_CONTACT_MAX_DAYS }));
        const reason = text(req.body, 'reason', 500);
        if (!reason) throw new InputError(textOf(req).t('moderation.keepApart.reasonRequired'));
        const [a, b] = await Promise.all([client.users.fetch(userA).catch(() => null), client.users.fetch(userB).catch(() => null)]);
        if (!a || !b) throw new InputError(textOf(req).t('moderation.keepApart.notUser'));
        if (a.bot || b.bot) throw new InputError(textOf(req).t('moderation.keepApart.noBots'));
        const moderator = await freshModerator(req);
        const { order, delivered } = await e.addNoContactOrder(client, {
            guildId, userA, userB, days, reason, createdBy: { id: moderator.id, username: moderator.user?.username || req.dashboard.session.username },
        });
        await audit(req, 'nocontact', [{ key: `order:${order.id}`, old: null, new: { userA, userB, days, reason } }]);
        await flash(req, [textOf(req).t('moderation.keepApart.started', { id: order.id, a: a.username, b: b.username }), textOf(req).t(delivered.every(Boolean) ? 'moderation.keepApart.bothDmed' : 'moderation.keepApart.dmFailed')].join(' '));
        return res.redirect(303, path('/nocontact'));
    }, { rerender: rerenderNoContact, perm: 'nocontact.edit' });

    const noContactEnd = guardedPost(async (req, res) => {
        const id = text(req.body, 'id', 12);
        if (!/^\d{1,12}$/.test(id)) throw new InputError(textOf(req).t('moderation.keepApart.notOrder'));
        const moderator = await freshModerator(req);
        const result = await e.endNoContactOrder(client, { guildId, id: Number(id), endedBy: { id: moderator.id, username: moderator.user?.username || req.dashboard.session.username } });
        if (!result) throw new InputError(textOf(req).t('moderation.keepApart.noOrder', { id }));
        await audit(req, 'nocontact', [{ key: `order:${id}`, old: 'active', new: 'ended' }]);
        await flash(req, [textOf(req).t('moderation.keepApart.ended', { id }), textOf(req).t(result.delivered.every(Boolean) ? 'moderation.keepApart.bothDmed' : 'moderation.keepApart.dmFailed')].join(' '));
        return res.redirect(303, path('/nocontact'));
    }, { rerender: rerenderNoContact, perm: 'nocontact.edit' });

    // ── Staff watchlist (listed on the No-contact page; added with /case watch add) ──

    const watchlistEnd = guardedPost(async (req, res) => {
        const id = text(req.body, 'id', 12);
        if (!/^\d{1,12}$/.test(id)) throw new InputError(textOf(req).t('moderation.watchlist.notEntry'));
        const moderator = await freshModerator(req);
        const row = await e.endWatch(client, { guildId, id: Number(id), endedBy: { id: moderator.id, username: moderator.user?.username || req.dashboard.session.username } });
        if (!row) throw new InputError(textOf(req).t('moderation.watchlist.noEntry', { id }));
        await audit(req, 'watchlist', [{ key: `watch:${id}`, old: 'active', new: 'ended' }]);
        await flash(req, textOf(req).t('moderation.watchlist.ended', { id }));
        return res.redirect(303, path('/nocontact'));
    }, { rerender: rerenderNoContact, perm: 'watchlist.edit' });

    // ── Staff ────────────────────────────────────────────────────────────

    /** A read for the staff page; a failure is logged and shown as "could not be loaded" (null). */
    const loadOrNull = (label, run) => Promise.resolve().then(run).catch((error) => {
        logger.warn(`Dashboard ${label} failed: ${error.message}`);
        return null;
    });

    /**
     * Extra sections of the staff page: the coverage heatmap, weekly staff activity
     * (/staff activity, ?week=this|last), staff discipline for OWNER_IDS (/staff warn,
     * warnings ?warnings=<id>, restore) and the mass-action blocks.
     */
    async function staffSections(req, statsPeriod) {
        const requested = queryText(req.query, 'coverage', 5);
        const period = Object.hasOwn(COVERAGE_PERIODS, requested) ? requested : '7d';
        const week = queryText(req.query, 'week', 5) === 'last' ? 'last' : 'this';
        const weekDate = new Date();
        if (week === 'last') weekDate.setUTCDate(weekDate.getUTCDate() - 7);
        const start = weekStart(weekDate);
        const owner = isOwner(req);
        const lookupId = owner ? parseUserRef(queryText(req.query, 'warnings', 40)) || '' : '';
        const guild = guildOf();
        const [config, counts, blocks, activity, removed, warnings] = await Promise.all([
            e.getGuildConfig(client, guildId).catch(() => null),
            loadOrNull('coverage', () => e.loadCoverageCounts(guildId, client.user?.id || '0', COVERAGE_PERIODS[period])),
            Promise.resolve().then(() => e.listMassActionBlocks(guildId)).catch(() => []),
            // /staff activity is owner-only, so the weekly list is too.
            owner && guild ? loadOrNull('staff activity', async () => {
                await completeMemberCache(guild);
                return e.staffActivityForWeek(guild, start);
            }) : null,
            owner ? loadOrNull('removed staff roles', () => e.listRemovedStaffRoles(guildId)) : [],
            isSnowflake(lookupId) ? loadOrNull('staff warnings', () => e.listStaffWarnings(guildId, lookupId)) : undefined,
        ]);
        const userName = (id) => guild?.members?.cache?.get?.(id)?.user?.username || client.users.cache?.get?.(id)?.username || null;
        const names = new Map(blocks.map((b) => [b.moderatorId, userName(b.moderatorId)]));
        const removedNames = new Map((removed || []).map((r) => [r.userId, userName(r.userId)]));
        const roleNames = new Map((removed || []).flatMap((r) => r.roleIds).map((id) => [id, guild?.roles?.cache?.get?.(id)?.name || null]).filter(([, n]) => n));
        const keep = { period: statsPeriod, coverage: period === '7d' ? undefined : period };
        const tr = textOf(req);
        return [
            counts ? coverageSection({ report: buildCoverageReport(counts, config?.birthdayTimezone || 'UTC'), period, periods: COVERAGE_PERIODS, statsPeriod })
                : html`<h2>${tr.t('moderation.staff.coverage')}</h2><p class="muted">${tr.t('moderation.staff.coverageFailed')}</p>`,
            owner ? activitySection({ rows: activity, week, start, keep, warningsLink: owner })
                : html`<h2>${tr.t('moderation.staff.activity')}</h2><p class="muted">${tr.t('moderation.staff.activityOwners')}</p>`,
            disciplineSection({
                isOwner: owner, csrf: req.dashboard.session.csrf, editEnabled: settings.editEnabled,
                staff: (activity || []).map((r) => ({ userId: r.userId, username: r.username })),
                lookup: warnings === undefined ? null : { userId: lookupId, name: userName(lookupId), rows: warnings },
                removed, roleNames, names: removedNames, warnLimit: automodConfig.staffWarnLimit, keep: { ...keep, week: week === 'last' ? 'last' : undefined },
                guild, picked: { warn: parseUserRef(queryText(req.query, 'warn_user', 25)) || '', restore: parseUserRef(queryText(req.query, 'restore_user', 25)) || '' },
            }),
            blocksSection({ blocks, names, canLift: owner, csrf: req.dashboard.session.csrf, editEnabled: settings.editEnabled }),
        ];
    }

    const rerenderStaff = (req, res, status, message) => core.renderStaff(req, res, status, { error: message });

    const blockLift = guardedPost(async (req, res) => {
        const moderatorId = text(req.body, 'moderator', 25);
        if (!isSnowflake(moderatorId)) throw new InputError(textOf(req).t('moderation.members.notUserId'));
        const block = await e.getMassActionBlock(guildId, moderatorId);
        if (!block) throw new InputError(textOf(req).t('moderation.staff.notBlocked'));
        await e.clearMassActionBlock(guildId, moderatorId);
        await audit(req, 'massguard', [{ key: `block:${moderatorId}`, old: block.until, new: null }], { modLog: true, label: 'Safety limit (bans/kicks)' });
        await flash(req, textOf(req).t('moderation.staff.blockLifted', { name: client.users.cache?.get?.(moderatorId)?.username || moderatorId }));
        return res.redirect(303, path('/staff'));
    }, { rerender: rerenderStaff, need: 'owner', perm: 'staff.manage' });

    /** The logged-in owner as the giver / restorer the staff services record. */
    const ownerActor = (req) => ({ id: req.dashboard.session.userId, username: req.dashboard.session.username || req.dashboard.session.userId });

    // /staff warn: OWNER_IDS only, like the command. The service DMs the member, posts the
    // mod-log line and removes the staff roles at the limit; here only the audit row.
    const staffWarn = guardedPost(async (req, res) => {
        const userId = parseUserRef(text(req.body, 'user', 40)) || '';
        if (!isSnowflake(userId)) throw new InputError(textOf(req).t('moderation.staff.pickStaff'));
        const reason = text(req.body, 'reason', 500);
        if (!reason) throw new InputError(textOf(req).t('moderation.staff.reasonRule'));
        const guild = guildOf();
        if (userId === guild.ownerId) throw new InputError(textOf(req).t('moderation.staff.cannotWarn'));
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) throw new InputError(textOf(req).t('moderation.staff.notInServer'));
        if (member.user?.bot) throw new InputError(textOf(req).t('moderation.staff.cannotWarn'));
        const { active, demoted } = await e.giveStaffWarning(guild, member, ownerActor(req), reason);
        await audit(req, 'staff', [{ key: `warning:${userId}`, old: null, new: { reason, active, demoted: Boolean(demoted) } }]);
        await flash(req, [
            textOf(req).t('moderation.staff.warned', { name: member.user?.username || userId, active, limit: automodConfig.staffWarnLimit }),
            demoted ? textOf(req).t('moderation.staff.demoted') : null,
        ].filter(Boolean).join(' '));
        return res.redirect(303, path(`/staff${queryString({ warnings: userId })}`));
    }, { rerender: rerenderStaff, need: 'owner', perm: 'staff.manage' });

    // /staff restore (the roles part; a mass-action block is lifted with blockLift). OWNER_IDS only.
    const staffRestore = guardedPost(async (req, res) => {
        const userId = parseUserRef(text(req.body, 'user', 40)) || '';
        if (!isSnowflake(userId)) throw new InputError(textOf(req).t('moderation.staff.pickStaff'));
        const roles = await e.restoreStaffRoles(guildOf(), userId, ownerActor(req));
        if (!roles) throw new InputError(textOf(req).t('moderation.staff.noSavedRoles'));
        await audit(req, 'staff', [{ key: `roles:${userId}`, old: 'removed', new: roles.map((role) => role.name) }]);
        const name = guildOf()?.members?.cache?.get?.(userId)?.user?.username || userId;
        await flash(req, roles.length
            ? textOf(req).t('moderation.staff.rolesBack', { name, roles: roles.map((role) => role.name).join(', ') })
            : textOf(req).t('moderation.staff.noneBack', { name }));
        return res.redirect(303, path('/staff'));
    }, { rerender: rerenderStaff, need: 'owner', perm: 'staff.manage' });

    return {
        users, bans, userPage: userPageHandler, actionPreview, actionExecute, roleAdd, roleRemove, nickname, timeout, unverify, bulkPreview, bulkExecute, bulkJob, noteAdd, noteRemove,
        caseEdit, caseVoid, caseBulk, caseBulkVoid, evidenceAdd, evidenceUpload, evidenceRemove, caseNote, caseTags, caseActionForms: (args) => caseActionForms(args),
        appealDetail, appealPreview, appealDecide,
        noContact, noContactAdd, noContactEnd, watchlistEnd,
        staffSections, blockLift, staffWarn, staffRestore, canWrite,
        // Shared with the Inbox (inboxRoutes.js): the same POST checks, fresh Administrator, audit rows, flash.
        guardedPost, freshModerator, audit, flash,
        // For the other Members pages (memberToolsRoutes.js): the same POST guard and helpers.
        helpers: { guardedPost, freshModerator, flash, audit, completeMemberCache, guildOf, isOwner, canWrite },
    };
}
