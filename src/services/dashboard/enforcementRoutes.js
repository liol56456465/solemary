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
//   GET  /dashboard/nocontact, POST /dashboard/nocontact/add|end
//   POST /dashboard/staff/blocks/lift            OWNER_IDS only (like /staff restore)
//   POST /dashboard/staff/warn|restore           OWNER_IDS only (/staff warn, /staff restore's roles)
//
// Every POST: 30/min per session, same origin + CSRF, edit switch (DASHBOARD_EDIT_ENABLED),
// then Administrator in the main server (canAct; OWNER_IDS without it get 403, owner
// decision 4) — except lifting a mass-action block, warning staff and restoring staff
// roles, which are for OWNER_IDS (like /staff). Actions run
// with the logged-in user's GuildMember fetched fresh, through the SAME services as the
// Discord commands (DMs, ladder, hierarchy, bot permissions, mass-action guard, logs).

import { PermissionFlagsBits } from 'discord.js';
import { CUSTOM_REASON_KEY, enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { recordOwnerOverride } from '../ownerOverride.js';
import { isAdministrator } from '../enforcement/enforcementService.js';
import { normalizeCaseCode } from '../enforcement/format.js';
import { parseEditDuration } from '../enforcement/caseEditService.js';
import { parseEvidenceUrls } from '../enforcement/evidenceService.js';
import { appealAnswers } from '../enforcement/appealService.js';
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
import { TEMP_ROLE_LENGTHS } from '../members/tempRoleService.js';
import { html, path, queryString } from './html.js';
import { isSnowflake } from './security.js';
import { caseActions as caseActionForms } from './enforcementPages.js';
import { evidenceFileName, sniffImage } from './multipart.js';
import {
    actionConfirmPage, activitySection, appealConfirmPage, appealDetailPage, blocksSection, disciplineSection, bulkJobPage, bulkPreviewPage, membersPage, coverageSection, noContactPage, userPage,
} from './enforcementPages.js';

const SEARCH_LIMIT = 25;
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
    if (!isKnownReasonKey(reasonKey)) throw new InputError('Choose a reason.');
    Object.assign(flow, reasonPatch(flow, reasonKey));
    const choice = text(form, 'unappealable', 10) || 'default';
    if (!['default', 'yes', 'no'].includes(choice)) throw new InputError('Appealable: unknown choice.');
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
    const parts = [`${ACTION_LABELS[flow.type]} done for ${flow.targetUsername}.`];
    if (result.record) parts.push(`Case ${result.record.case_code} (${result.record.name}).`);
    if (result.dmDelivered === false) parts.push('The DM could not be delivered (DMs closed or no shared server); the action still ran.');
    else if (result.dmDelivered === true) parts.push('DM delivered.');
    parts.push(...(result.notes || []));
    return parts.map((p) => plainText(p).replace(/⚠️\s*/g, 'Warning: ')).join(' ');
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

    /** The logged-in user's member in the main server, fetched fresh; must still be Administrator. */
    async function freshModerator(req) {
        const guild = guildOf();
        const member = await guild?.members?.fetch?.({ user: req.dashboard.session.userId, force: true }).catch(() => null);
        if (!member || !isAdministrator(member)) {
            throw new InputError('You need the Administrator permission in the main server to do this.', 403);
        }
        return member;
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
    function guardedPost(run, { rerender, need = 'act' }) {
        return async (req, res) => {
            const session = req.dashboard.session;
            if (!postLimiter.allow(session.idHash)) {
                res.set('Retry-After', '60');
                return fail(res, 429, 'Slow down', 'Too many changes in the last minute. Wait a moment and try again.', req);
            }
            if (!checkPost(req)) return fail(res, 403, 'Not allowed', 'This form did not come from this dashboard (security token or origin mismatch). Reload the page and try again.', req);
            if (!settings.editEnabled) return fail(res, 403, 'Editing is off', 'Editing from the dashboard is turned off (DASHBOARD_EDIT_ENABLED). Nothing was changed.', req);
            const allowed = need === 'owner' ? isOwner(req) : req.dashboard.access.canAct;
            if (!allowed) {
                return fail(res, 403, 'Not allowed', need === 'owner'
                    ? 'Only the bot owners can do this (like /staff restore).'
                    : 'Enforcement actions need Administrator in the main server (bot owners without it can view only).', req);
            }
            if (!guildOf()) return fail(res, 503, 'Server unavailable', 'The bot cannot see the main server right now. Try again in a moment.', req);
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
            return render(404, { roles, error: `No Discord user with ID ${filters.q} exists.` });
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
                ? e.precedentHint(guildId, precedentReason, precedentReason).catch(() => null) : null,
        ]);
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
        if (!view) return fail(res, 404, 'Not found', 'There is no Discord user with that ID.', req);
        return sendHtml(res, status, userPage({
            ...shellOf(req), view, canAct: req.dashboard.access.canAct, editEnabled: settings.editEnabled,
            flash: status === 200 ? req.dashboard.flash : null, error, values,
        }));
    }

    const userPageHandler = (req, res) => renderUser(req, res);
    const rerenderUser = (req, res, status, message) => renderUser(req, res, status, { error: message, values: { ...(req.body || {}), csrf: undefined } });

    const actionPreview = guardedPost(async (req, res) => {
        const userId = userIdParam(req);
        if (!userId) throw new InputError('Not a user ID.');
        const type = text(req.body, 'type', 20);
        if (!ACTION_TYPES.includes(type)) throw new InputError('Unknown action.');
        const guild = guildOf();
        const targetUser = await client.users.fetch(userId).catch(() => null);
        if (!targetUser) throw new InputError('There is no Discord user with that ID.');
        const state = await e.getTargetState(guild, userId);
        if (!availableActions(state).includes(type)) {
            throw new InputError(`${ACTION_LABELS[type]} is not available for ${targetUser.username} right now (reload the page).`);
        }
        const moderator = await freshModerator(req);
        const moderatorId = req.dashboard.session.userId;
        let flow;
        if (RECORD_ACTIONS.has(type)) {
            flow = await buildRecordFlow({ guild, moderator, moderatorId, targetUser, type, form: req.body || {}, completeFlowDetails: e.completeFlowDetails });
        } else {
            flow = startFlow({ type, moderatorId, targetUser });
            if (type === 'removewarn') {
                const warnCode = normalizeCaseCode(text(req.body, 'warn', 10));
                const counted = await e.getCountedWarns(guildId, userId, state.ladder.level);
                if (!warnCode || !counted.some((w) => w.case_code === warnCode)) throw new InputError('Choose one of the member\'s counted warnings.');
                flow.warnCode = warnCode;
            }
            Object.assign(flow, liftReasonPatch(flow, text(req.body, 'reason', 500), 'the dashboard'));
        }
        const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: `user:${userId}`, payload: flow });
        const block = await e.getMassActionBlock(guildId, moderatorId).catch(() => null);
        return sendHtml(res, 200, actionConfirmPage({ ...shellOf(req), userId, type, summary: flowSummary(flow), token, hash, block }));
    }, { rerender: rerenderUser });

    const actionExecute = guardedPost(async (req, res) => {
        const userId = userIdParam(req);
        if (!userId) throw new InputError('Not a user ID.');
        const flow = confirms.consume(text(req.body, 'token', 100), {
            session: req.dashboard.session.idHash, subject: `user:${userId}`, hash: text(req.body, 'fh', 100),
        });
        if (!flow) throw new InputError('This confirmation expired or was already used. Nothing was done; preview the action again.');
        const moderator = await freshModerator(req);
        const targetUser = await client.users.fetch(userId).catch(() => null);
        if (!targetUser) throw new InputError('There is no Discord user with that ID.');
        let result;
        try {
            result = await e.executeAction({ guild: guildOf(), moderator, targetUser, flow });
        } catch (error) {
            if (isExpectedError(error)) throw error;
            logger.error('Dashboard enforcement action failed', { action: flow.type, targetId: flow.targetId, error });
            throw new InputError('Something went wrong; nothing may have changed. Check the member\'s cases before retrying.', 500);
        }
        result.notes = [...(result.notes || []), ...await e.attachFlowEvidence(flow, result.record, moderator.user || { id: moderator.id, username: req.dashboard.session.username })];
        await audit(req, 'actions', [{ key: flow.type, old: null, new: auditFlow(flow, result) }]);
        logger.info(`Dashboard ${flow.type} by ${req.dashboard.session.userId} on ${userId}${result.record ? ` (${result.record.case_code})` : ''}`);
        await flash(req, resultMessage(flow, result));
        return res.redirect(303, path(`/users/${userId}`));
    }, { rerender: rerenderUser });

    // ── Member changes: roles, nickname, timeout (same hierarchy rule as enforcement) ──

    /** The member of the URL, the moderator as a member, and whether they may change them. */
    async function memberContext(req) {
        const userId = userIdParam(req);
        if (!userId) throw new InputError('Not a user ID.');
        const guild = guildOf();
        // The moderator is fetched fresh and must still be an Administrator (the access check on
        // the request can be up to a minute old).
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
        if (mode === 'add' && has && !text(req.body, 'for', 4)) throw new InputError(`${ctx.target.user.username} already has @${role.name}.`);
        if (mode === 'remove' && !has) throw new InputError(`${ctx.target.user.username} does not have @${role.name}.`);
        const typed = text(req.body, 'reason', REASON_MAX);
        const reason = auditReason(req.dashboard.session.username, typed);
        const forKey = mode === 'add' ? text(req.body, 'for', 4) : '';
        if (forKey && !Object.hasOwn(TEMP_ROLE_LENGTHS, forKey)) throw new InputError('Choose how long.', 400, 'for');
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
        await flash(req, mode === 'add' ? `Gave ${label} to ${ctx.target.user.username}.` : `Took @${role.name} from ${ctx.target.user.username}.`);
        return res.redirect(303, path(`/users/${ctx.userId}`));
    }, { rerender: rerenderUser });
    const roleAdd = roleChange('add');
    const roleRemove = roleChange('remove');

    const nickname = guardedPost(async (req, res) => {
        const ctx = await memberContext(req);
        const nick = text(req.body, 'nickname', NICKNAME_MAX);
        const before = ctx.target.nickname || null;
        if ((nick || null) === before) throw new InputError('That is already their nickname.');
        await ctx.target.setNickname(nick || null, auditReason(req.dashboard.session.username, text(req.body, 'reason', REASON_MAX)));
        await audit(req, 'members', [{ key: `nickname:${ctx.userId}`, old: before, new: nick || null }], { modLog: true, label: 'Members' });
        await flash(req, nick ? `Nickname set to "${nick}".` : 'Nickname removed.');
        return res.redirect(303, path(`/users/${ctx.userId}`));
    }, { rerender: rerenderUser });

    const timeout = guardedPost(async (req, res) => {
        const ctx = await memberContext(req);
        const choice = text(req.body, 'duration', 5);
        const lift = choice === 'off';
        if (!lift && !Object.hasOwn(TIMEOUTS, choice)) throw new InputError('Choose a timeout length.', 400, 'duration');
        if (!lift && ctx.target.permissions?.has?.(PermissionFlagsBits.Administrator)) {
            throw new InputError('Discord does not allow timing out a member with Administrator.');
        }
        const until = ctx.target.communicationDisabledUntilTimestamp;
        if (lift && !(until > Date.now())) throw new InputError(`${ctx.target.user.username} is not timed out.`);
        const reason = auditReason(req.dashboard.session.username, text(req.body, 'reason', REASON_MAX));
        await ctx.target.timeout(lift ? null : TIMEOUTS[choice].ms, reason);
        await audit(req, 'members', [{ key: `timeout:${ctx.userId}`, old: until > Date.now() ? new Date(until).toISOString() : null, new: lift ? null : TIMEOUTS[choice].label }],
            { modLog: true, label: 'Members' });
        await flash(req, lift ? `Timeout of ${ctx.target.user.username} removed.` : `${ctx.target.user.username} is timed out for ${TIMEOUTS[choice].label}.`);
        return res.redirect(303, path(`/users/${ctx.userId}`));
    }, { rerender: rerenderUser });

    // Same service as /verification remove: takes the verified role, logs it to the verification log.
    const unverify = guardedPost(async (req, res) => {
        const ctx = await memberContext(req);
        const typed = text(req.body, 'reason', REASON_MAX);
        const result = await e.removeVerification(client, guildId, ctx.userId, { moderatorId: req.dashboard.session.userId, reason: typed || 'admin_removal' });
        if (result?.status === 'not_verified') throw new InputError(`${ctx.target.user.username} does not have the verified role.`);
        await audit(req, 'members', [{ key: `verification:${ctx.userId}`, old: 'verified', new: typed ? { verified: false, reason: typed } : null }],
            { modLog: true, label: 'Members' });
        await flash(req, `Verification removed from ${ctx.target.user.username}.`);
        return res.redirect(303, path(`/users/${ctx.userId}`));
    }, { rerender: rerenderUser });

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
    const bulkBack = (req, res, status, message) => fail(res, status, 'Not done', message, req);

    /** The members the form points at: ticked ones, or everyone matching the list filters (max BULK_LIMIT). */
    async function bulkTargets(req, guild) {
        if (text(req.body, 'scope', 10) === 'filter') {
            const filters = listFilters(req.body);
            const standings = await e.memberStandings(guildId);
            const all = listMembers(guild, standings, { ...filters, page: 0, pageSize: BULK_LIMIT + 1 });
            if (all.total > BULK_LIMIT) throw new InputError(`${all.total} members match these filters; one bulk action can change at most ${BULK_LIMIT}. Narrow the filters.`);
            return all.rows.map((row) => guild.members.cache.get(row.id)).filter(Boolean);
        }
        const raw = req.body?.ids;
        const ids = [...new Set((Array.isArray(raw) ? raw : raw ? [raw] : []).filter((id) => isSnowflake(String(id))))];
        if (!ids.length) throw new InputError('Tick at least one member, or choose "everyone matching these filters".');
        if (ids.length > BULK_LIMIT) throw new InputError(`One bulk action can change at most ${BULK_LIMIT} members.`);
        const members = await Promise.all(ids.map((id) => guild.members.fetch({ user: id }).catch(() => null)));
        return members.filter(Boolean);
    }

    const bulkPreview = guardedPost(async (req, res) => {
        const guild = guildOf();
        const action = text(req.body, 'action', 12);
        if (!Object.hasOwn(BULK_ACTIONS, action)) throw new InputError('Choose what to do.');
        const moderator = await freshModerator(req);
        const roleId = text(req.body, 'roleId', 20);
        const role = action.startsWith('role-') ? (isSnowflake(roleId) ? guild.roles.cache.get(roleId) : null) : null;
        if (action.startsWith('role-') && !role) throw new InputError('Choose a role.');
        const timeoutKey = text(req.body, 'timeout', 5);
        if (action === 'timeout' && !Object.hasOwn(TIMEOUTS, timeoutKey)) throw new InputError('Choose a timeout length.');
        const members = await bulkTargets(req, guild);
        const owner = e.isBotOwner(req.dashboard.session.userId);
        let guardLeft = Infinity;
        if ((action === 'kick' || action === 'ban') && !owner) {
            if (await e.getMassActionBlock(guildId, req.dashboard.session.userId)) throw new InputError('You are blocked by the mass-action guard; nothing was done.');
            guardLeft = Math.max(0, enforcementConfig.massActionLimit - await e.recentBanKickCount(guildId, req.dashboard.session.userId));
        }
        const plan = planBulk({ guild, members, action, role, timeoutKey, actorId: req.dashboard.session.userId, actorMember: moderator, actorIsOwner: isOwner(req), botMember: guild.members.me, guardLeft });
        // Kick / ban: the enforcement form is checked now (same flow builder as one member), so the run cannot fail on it.
        const recordForm = { reason: text(req.body, 'reasonKey', 50), custom_reason: text(req.body, 'custom_reason', 500), duration: text(req.body, 'duration', 20), unappealable: text(req.body, 'unappealable', 10) || 'default' };
        if ((action === 'kick' || action === 'ban') && plan.run.length) {
            const first = guild.members.cache.get(plan.run[0].id)?.user || await client.users.fetch(plan.run[0].id);
            await buildRecordFlow({ guild, moderator, moderatorId: moderator.id, targetUser: first, type: action, form: recordForm, completeFlowDetails: e.completeFlowDetails });
        }
        const forKey = action === 'role-add' ? text(req.body, 'for', 4) : '';
        if (forKey && !Object.hasOwn(TEMP_ROLE_LENGTHS, forKey)) throw new InputError('Choose how long.');
        const payload = { action, roleId: role?.id || null, timeoutKey, forKey, reason: text(req.body, 'reason', REASON_MAX), recordForm, run: plan.run };
        const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: 'bulk', payload });
        return sendHtml(res, 200, bulkPreviewPage({ ...shellOf(req), action, label: BULK_ACTIONS[action], role, timeout: TIMEOUTS[timeoutKey] || TEMP_ROLE_LENGTHS[forKey] || null, plan, token, hash, guardLeft }));
    }, { rerender: bulkBack });

    const bulkExecute = guardedPost(async (req, res) => {
        const payload = confirms.consume(text(req.body, 'token', 100), { session: req.dashboard.session.idHash, subject: 'bulk', hash: text(req.body, 'fh', 100) });
        if (!payload) throw new InputError('This confirmation expired or was already used. Nothing was done; preview the bulk action again.');
        const guild = guildOf();
        const moderator = await freshModerator(req);
        const session = req.dashboard.session;
        const role = payload.roleId ? guild.roles.cache.get(payload.roleId) : null;
        const reason = auditReason(session.username, payload.reason);
        const label = `${BULK_ACTIONS[payload.action]}${role ? ` @${role.name}` : ''}${payload.forKey ? ` for ${TEMP_ROLE_LENGTHS[payload.forKey].label}` : ''}${payload.action === 'timeout' ? ` (${TIMEOUTS[payload.timeoutKey].label})` : ''}`;
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
            session: session.idHash, label, items: payload.run, work,
            onDone: async (finished) => {
                await audit(req, 'members', [{ key: `bulk:${payload.action}`, old: null, new: `${label}: ${finished.done.length} done, ${finished.failed.length} failed` }],
                    { modLog: true, label: 'Members (bulk)' });
            },
        });
        logger.info(`Dashboard bulk ${payload.action} by ${session.userId}: ${payload.run.length} members (job ${job.id})`);
        return res.redirect(303, path(`/users/bulk/${job.id}`));
    }, { rerender: bulkBack });

    /** GET /dashboard/users/bulk/:job: progress (refreshes itself while running), then the result. */
    async function bulkJob(req, res) {
        const id = typeof req.params?.job === 'string' ? req.params.job.slice(0, 40) : '';
        const job = jobs.get(id, req.dashboard.session.idHash);
        if (!job) return fail(res, 404, 'Not found', 'This bulk action is not known (it may be over an hour old, or the bot restarted).', req);
        return sendHtml(res, 200, bulkJobPage({ ...shellOf(req), job }));
    }

    const noteAdd = guardedPost(async (req, res) => {
        const userId = userIdParam(req);
        if (!userId) throw new InputError('Not a user ID.');
        const content = multiline(req.body, 'note', 1000);
        if (!content) throw new InputError('The note is empty.');
        const note = await e.addNote(guildId, userId, content, { id: req.dashboard.session.userId, tag: req.dashboard.session.username });
        await audit(req, 'notes', [{ key: `note:${userId}`, old: null, new: note?.content ?? content }], { modLog: true, label: 'Staff notes' });
        await flash(req, 'Note added.');
        return res.redirect(303, path(`/users/${userId}`));
    }, { rerender: rerenderUser });

    const noteRemove = guardedPost(async (req, res) => {
        const userId = userIdParam(req);
        if (!userId) throw new InputError('Not a user ID.');
        const noteId = text(req.body, 'note', 20);
        if (!/^\d{1,16}$/.test(noteId)) throw new InputError('Not a note.');
        const removed = await e.removeNote(guildId, userId, { id: noteId });
        if (!removed) throw new InputError('That note no longer exists.');
        await audit(req, 'notes', [{ key: `note:${userId}`, old: removed.content, new: null }], { modLog: true, label: 'Staff notes' });
        await flash(req, 'Note removed.');
        return res.redirect(303, path(`/users/${userId}`));
    }, { rerender: rerenderUser });

    // ── Cases ────────────────────────────────────────────────────────────

    /** Loads the case of the URL in the main server, or throws a 404-ish InputError. */
    async function caseOf(req) {
        const code = caseCodeParam(req);
        const record = code ? await e.getCaseByCode(code) : null;
        if (!record || record.guild_id !== guildId) throw new InputError('There is no case with that code.', 404);
        return record;
    }

    const rerenderCase = (req, res, status, message) => core.renderCase(req, res, status, { error: message });

    const caseEdit = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        const reasonRaw = text(req.body, 'reason', 500);
        const reason = reasonRaw && reasonRaw !== record.reason ? reasonRaw : undefined;
        const durationMs = parseEditDuration(text(req.body, 'duration', 20));
        if (reason === undefined && durationMs === undefined) throw new InputError('Give a new reason or a new duration.');
        const moderator = await freshModerator(req);
        const { after, changes } = await e.editCase(client, {
            guildId, caseCode: record.case_code, editor: { id: moderator.id, username: moderator.user?.username || req.dashboard.session.username }, reason, durationMs,
        });
        await audit(req, 'cases', changes.map((c) => ({ key: `${record.case_code}.${c.field}`, old: c.oldValue, new: c.newValue })));
        const ended = changes.some((c) => c.field === 'duration') && after.expires_at && new Date(after.expires_at) <= new Date();
        await flash(req, `Case ${record.case_code} edited: ${changes.map((c) => c.field).join(' and ')}.${ended ? ' The new end is already past: it will be lifted within a minute.' : ''}`);
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase });

    const caseVoid = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        const reason = text(req.body, 'reason', 500);
        if (!reason) throw new InputError('The reason cannot be empty.');
        if (!text(req.body, 'confirm', 5)) throw new InputError('Tick the box to confirm voiding this case.');
        const moderator = await freshModerator(req);
        const admin = { id: moderator.id, username: moderator.user?.username || req.dashboard.session.username };
        const { record: voided, notes, dmDelivered } = await e.voidCase(client, { guildId, caseCode: record.case_code, admin, reason });
        await audit(req, 'cases', [{ key: `${record.case_code}.void`, old: null, new: reason }]);
        await flash(req, [`Case ${voided.case_code} voided.`, ...notes, `DM to the member: ${dmDelivered ? 'delivered' : 'not delivered'}.`].join(' '));
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase });

    const evidenceAdd = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        const entries = parseEvidenceUrls(text(req.body, 'link', 500));
        if (entries.length !== 1) throw new InputError('Give one http(s) link, e.g. a Discord message link.');
        const note = text(req.body, 'note', 300) || null;
        const [entry] = await e.captureLinks(guildOf(), entries);
        const row = await e.addEvidence(record.case_code, {
            kind: 'link', url: entry.url, sourceMessageUrl: entry.sourceMessageUrl, excerpt: entry.excerpt, note,
            addedBy: { id: req.dashboard.session.userId, username: req.dashboard.session.username },
        });
        await audit(req, 'cases', [{ key: `${record.case_code}.evidence`, old: null, new: entry.url }], { modLog: true, label: `Case ${record.case_code} evidence` });
        await flash(req, `Evidence #${row.id} added.${entry.sourceMessageUrl && !entry.excerpt ? ' The message could not be read (other server, no access or deleted), so only the link is saved.' : ''}`);
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase });

    // An evidence image from the web: the multipart body was size-capped (express.raw)
    // and parsed by multipart.js before this runs (req.upload); only PNG / JPEG / GIF /
    // WebP recognised by their first bytes are accepted, then re-hosted in the evidence
    // channel by addImageEvidence (the same function /case evidence add uses).
    const evidenceUpload = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        const file = req.upload?.file || null;
        if (!file) throw new InputError('Choose an image to upload.');
        const image = sniffImage(file.data);
        if (!image) throw new InputError('That file is not a PNG, JPEG, GIF or WebP image.');
        const note = text(req.body, 'note', 300) || null;
        const row = await e.addImageEvidence(client, record.case_code, {
            data: file.data, name: evidenceFileName(record.case_code, image.ext), contentType: image.type,
        }, { note, addedBy: { id: req.dashboard.session.userId, username: req.dashboard.session.username } });
        await audit(req, 'cases', [{ key: `${record.case_code}.evidence`, old: null, new: `image #${row.id} (${image.type}, ${file.data.length} bytes)` }], { modLog: true, label: `Case ${record.case_code} evidence` });
        await flash(req, `Image evidence #${row.id} added (re-hosted in the evidence channel).`);
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase });

    const evidenceRemove = guardedPost(async (req, res) => {
        const record = await caseOf(req);
        const id = text(req.body, 'id', 12);
        if (!/^\d{1,12}$/.test(id)) throw new InputError('Not an evidence number.');
        const removed = await e.removeEvidence(record.case_code, Number(id));
        if (!removed) throw new InputError(`Case ${record.case_code} has no evidence #${id}.`);
        await audit(req, 'cases', [{ key: `${record.case_code}.evidence`, old: removed.url || `image #${id}`, new: null }], { modLog: true, label: `Case ${record.case_code} evidence` });
        await flash(req, `Evidence #${id} removed.${removed.kind === 'image' ? ' Its copy in the evidence channel is kept.' : ''}`);
        return res.redirect(303, path(`/cases/${record.case_code}`));
    }, { rerender: rerenderCase });

    // ── Appeals ──────────────────────────────────────────────────────────

    async function renderAppeal(req, res, status = 200, { error = null } = {}) {
        const code = caseCodeParam(req);
        const record = code ? await e.getCaseByCode(code) : null;
        if (!record || record.guild_id !== guildId) return fail(res, 404, 'Not found', 'There is no case with that code.', req);
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
            answers = [{ label: 'Answers', value: '(could not be read)' }];
        }
        const data = {
            record, appeal, answers,
            history: appeals.filter((a) => a !== appeal),
            others: otherRows.filter((c) => c.case_code !== code).slice(0, 15),
            othersTotal: Math.max(0, total - 1),
            ladder,
            evidence: evidenceRows.map((row) => ({ row, freshUrl: fresh.get(String(row.id)) || null })),
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
        if (!record || record.guild_id !== guildId) throw new InputError('There is no case with that code.', 404);
        const decision = text(req.body, 'decision', 10);
        if (decision !== 'accept' && decision !== 'deny') throw new InputError('Choose Accept or Deny.');
        const appeals = await e.getAppealHistory(code);
        if (!appeals.some((a) => a.status === 'pending')) throw new InputError(`There is no pending appeal for ${code}.`);
        await freshModerator(req);
        const note = multiline(req.body, 'note', 500);
        const payload = { caseCode: code, decision, note };
        const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: `appeal:${code}`, payload });
        return sendHtml(res, 200, appealConfirmPage({ ...shellOf(req), record, decision, note, token, hash }));
    }, { rerender: rerenderAppeal });

    const appealDecide = guardedPost(async (req, res) => {
        const code = caseCodeParam(req);
        if (!code) throw new InputError('There is no case with that code.', 404);
        const payload = confirms.consume(text(req.body, 'token', 100), {
            session: req.dashboard.session.idHash, subject: `appeal:${code}`, hash: text(req.body, 'fh', 100),
        });
        if (!payload) throw new InputError('This confirmation expired or was already used. Nothing was done; decide again.');
        const moderator = await freshModerator(req);
        const admin = moderator.user || { id: moderator.id, username: req.dashboard.session.username };
        const result = await e.decideAppeal({ client, admin, caseCode: code, decision: payload.decision, note: payload.note || null });
        await audit(req, 'appeal-decisions', [{ key: code, old: 'pending', new: { decision: result.label, note: payload.note || null, dmDelivered: result.dmDelivered } }]);
        await flash(req, [`Appeal on ${code} ${result.label}.`, `DM to the member: ${result.dmDelivered ? 'delivered' : 'not delivered'}.`, ...(result.notes || [])].join(' '));
        return res.redirect(303, path('/appeals'));
    }, { rerender: rerenderAppeal });

    // ── No-contact orders ────────────────────────────────────────────────

    async function renderNoContact(req, res, status = 200, { error = null, values = {} } = {}) {
        const rows = await e.listActiveNoContactOrders(guildId, 100);
        const ids = new Set(rows.flatMap((o) => [o.user_a, o.user_b, o.created_by]));
        const names = new Map([...ids].map((id) => [id, client.users.cache?.get?.(id)?.username || null]));
        return sendHtml(res, status, noContactPage({
            ...shellOf(req), rows, names, canWrite: canWrite(req), editEnabled: settings.editEnabled, canAct: req.dashboard.access.canAct,
            flash: status === 200 ? req.dashboard.flash : null, error, values,
        }));
    }

    const noContact = (req, res) => renderNoContact(req, res);
    const rerenderNoContact = (req, res, status, message) => renderNoContact(req, res, status, { error: message, values: { ...(req.body || {}), csrf: undefined } });

    const noContactAdd = guardedPost(async (req, res) => {
        const userA = text(req.body, 'user_a', 25);
        const userB = text(req.body, 'user_b', 25);
        if (!isSnowflake(userA) || !isSnowflake(userB)) throw new InputError('Both members must be Discord user IDs (17–20 digits).');
        const days = Number(text(req.body, 'days', 4));
        if (!Number.isInteger(days) || days < 1 || days > NO_CONTACT_MAX_DAYS) throw new InputError(`Days must be between 1 and ${NO_CONTACT_MAX_DAYS}.`);
        const reason = text(req.body, 'reason', 500);
        if (!reason) throw new InputError('A reason is required.');
        const [a, b] = await Promise.all([client.users.fetch(userA).catch(() => null), client.users.fetch(userB).catch(() => null)]);
        if (!a || !b) throw new InputError('One of those IDs is not a Discord user.');
        if (a.bot || b.bot) throw new InputError('No-contact orders are between members, not bots.');
        const moderator = await freshModerator(req);
        const { order, delivered } = await e.addNoContactOrder(client, {
            guildId, userA, userB, days, reason, createdBy: { id: moderator.id, username: moderator.user?.username || req.dashboard.session.username },
        });
        await audit(req, 'nocontact', [{ key: `order:${order.id}`, old: null, new: { userA, userB, days, reason } }]);
        await flash(req, `No-contact order #${order.id} started between ${a.username} and ${b.username}. ${delivered.every(Boolean) ? 'Both members were DMed.' : 'A DM could not be delivered to one of them.'}`);
        return res.redirect(303, path('/nocontact'));
    }, { rerender: rerenderNoContact });

    const noContactEnd = guardedPost(async (req, res) => {
        const id = text(req.body, 'id', 12);
        if (!/^\d{1,12}$/.test(id)) throw new InputError('Not an order number.');
        const moderator = await freshModerator(req);
        const result = await e.endNoContactOrder(client, { guildId, id: Number(id), endedBy: { id: moderator.id, username: moderator.user?.username || req.dashboard.session.username } });
        if (!result) throw new InputError(`There is no active no-contact order #${id}.`);
        await audit(req, 'nocontact', [{ key: `order:${id}`, old: 'active', new: 'ended' }]);
        await flash(req, `No-contact order #${id} ended. ${result.delivered.every(Boolean) ? 'Both members were DMed.' : 'A DM could not be delivered to one of them.'}`);
        return res.redirect(303, path('/nocontact'));
    }, { rerender: rerenderNoContact });

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
        const lookupId = owner ? queryText(req.query, 'warnings', 25) : '';
        const guild = guildOf();
        const [config, counts, blocks, activity, removed, warnings] = await Promise.all([
            e.getGuildConfig(client, guildId).catch(() => null),
            loadOrNull('coverage', () => e.loadCoverageCounts(guildId, client.user?.id || '0', COVERAGE_PERIODS[period])),
            Promise.resolve().then(() => e.listMassActionBlocks(guildId)).catch(() => []),
            guild ? loadOrNull('staff activity', async () => {
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
        return [
            counts ? coverageSection({ report: buildCoverageReport(counts, config?.birthdayTimezone || 'UTC'), period, periods: COVERAGE_PERIODS, statsPeriod })
                : html`<h2>Coverage</h2><p class="muted">Coverage could not be loaded (database unavailable).</p>`,
            activitySection({ rows: activity, week, start, keep, warningsLink: owner }),
            disciplineSection({
                isOwner: owner, csrf: req.dashboard.session.csrf, editEnabled: settings.editEnabled,
                staff: (activity || []).map((r) => ({ userId: r.userId, username: r.username })),
                lookup: warnings === undefined ? null : { userId: lookupId, name: userName(lookupId), rows: warnings },
                removed, roleNames, names: removedNames, warnLimit: automodConfig.staffWarnLimit, keep: { ...keep, week: week === 'last' ? 'last' : undefined },
            }),
            blocksSection({ blocks, names, canLift: owner, csrf: req.dashboard.session.csrf, editEnabled: settings.editEnabled }),
        ];
    }

    const rerenderStaff = (req, res, status, message) => core.renderStaff(req, res, status, { error: message });

    const blockLift = guardedPost(async (req, res) => {
        const moderatorId = text(req.body, 'moderator', 25);
        if (!isSnowflake(moderatorId)) throw new InputError('Not a user ID.');
        const block = await e.getMassActionBlock(guildId, moderatorId);
        if (!block) throw new InputError('That moderator is not blocked.');
        await e.clearMassActionBlock(guildId, moderatorId);
        await audit(req, 'massguard', [{ key: `block:${moderatorId}`, old: block.until, new: null }], { modLog: true, label: 'Mass-action guard' });
        await flash(req, `Mass-action block lifted for ${client.users.cache?.get?.(moderatorId)?.username || moderatorId}.`);
        return res.redirect(303, path('/staff'));
    }, { rerender: rerenderStaff, need: 'owner' });

    /** The logged-in owner as the giver / restorer the staff services record. */
    const ownerActor = (req) => ({ id: req.dashboard.session.userId, username: req.dashboard.session.username || req.dashboard.session.userId });

    // /staff warn: OWNER_IDS only, like the command. The service DMs the member, posts the
    // mod-log line and removes the staff roles at the limit; here only the audit row.
    const staffWarn = guardedPost(async (req, res) => {
        const userId = text(req.body, 'user', 25);
        if (!isSnowflake(userId)) throw new InputError('Staff member must be a Discord user ID (17–20 digits).');
        const reason = text(req.body, 'reason', 500);
        if (!reason) throw new InputError('A reason is required (which admin rule they broke).');
        const guild = guildOf();
        if (userId === guild.ownerId) throw new InputError('You cannot warn the owner or a bot.');
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) throw new InputError('That user is not in the server.');
        if (member.user?.bot) throw new InputError('You cannot warn the owner or a bot.');
        const { active, demoted } = await e.giveStaffWarning(guild, member, ownerActor(req), reason);
        await audit(req, 'staff', [{ key: `warning:${userId}`, old: null, new: { reason, active, demoted: Boolean(demoted) } }]);
        await flash(req, [
            `Staff warning given to ${member.user?.username || userId}: ${active} of ${automodConfig.staffWarnLimit} active.`,
            demoted ? 'That reached the limit: their staff roles were removed (restore them under Removed staff roles).' : null,
        ].filter(Boolean).join(' '));
        return res.redirect(303, path(`/staff${queryString({ warnings: userId })}`));
    }, { rerender: rerenderStaff, need: 'owner' });

    // /staff restore (the roles part; a mass-action block is lifted with blockLift). OWNER_IDS only.
    const staffRestore = guardedPost(async (req, res) => {
        const userId = text(req.body, 'user', 25);
        if (!isSnowflake(userId)) throw new InputError('Staff member must be a Discord user ID (17–20 digits).');
        const roles = await e.restoreStaffRoles(guildOf(), userId, ownerActor(req));
        if (!roles) throw new InputError('No removed staff roles are saved for that user (or they are not in the server).');
        await audit(req, 'staff', [{ key: `roles:${userId}`, old: 'removed', new: roles.map((role) => role.name) }]);
        const name = guildOf()?.members?.cache?.get?.(userId)?.user?.username || userId;
        await flash(req, roles.length
            ? `Staff roles given back to ${name}: ${roles.map((role) => role.name).join(', ')}.`
            : `None of the saved roles could be given back to ${name} (deleted or above my role).`);
        return res.redirect(303, path('/staff'));
    }, { rerender: rerenderStaff, need: 'owner' });

    return {
        users, userPage: userPageHandler, actionPreview, actionExecute, roleAdd, roleRemove, nickname, timeout, unverify, bulkPreview, bulkExecute, bulkJob, noteAdd, noteRemove,
        caseEdit, caseVoid, evidenceAdd, evidenceUpload, evidenceRemove, caseActionForms: (args) => caseActionForms(args),
        appealDetail, appealPreview, appealDecide,
        noContact, noContactAdd, noContactEnd,
        staffSections, blockLift, staffWarn, staffRestore, canWrite,
    };
}
