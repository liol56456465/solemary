// memberToolsRoutes.js — the Members area's Role rules and Insights pages.
//
//   GET  /dashboard/users/rules[?edit=id]       rules, their state and the new / edit form
//   POST /dashboard/users/rules/preview         dry run of the form (not saved) → confirm page
//   POST /dashboard/users/rules/save            one-time token from the dry run → save + audit
//   POST /dashboard/users/rules/:rid/disable    turn off (roles already given stay) + audit
//   POST /dashboard/users/rules/:rid/delete     delete (roles already given stay) + audit
//   GET  /dashboard/users/insights              joins/leaves chart, no roles after 24 h,
//                                               repeat offenders, inactive members
//
// Every POST goes through the Members guard (enforcementRoutes.js guardedPost): rate limit, same
// origin + CSRF, DASHBOARD_EDIT_ENABLED, Administrator in the main server (OWNER_IDS without it
// can view only). The moderator is fetched fresh; the role a rule gives must pass both the bot's
// own handout check (ruleProblem → getRoleAssignmentProblem) and the dashboard's role-change
// check for this moderator (memberActions.roleProblem: below their top role).

import { logger } from '../../utils/logger.js';
import { InputError, plainText, queryText, text } from './forms.js';
import { isSnowflake } from './security.js';
import { path } from './html.js';
import { roleProblem } from './memberActions.js';
import { insightsPage, roleRulePreviewPage, roleRulesPage } from './memberToolsPages.js';
import {
    MAX_RULES, NAME_MAX, RULE_TRIGGERS, describeRule, dryRunRule, ruleProblem,
    deleteRoleRule, disableRoleRule, listRoleRules, loadLevels, saveRoleRule,
} from '../members/roleRuleService.js';
import {
    inactiveMembers, joinsLeavesPerDay, loadLastActivity, membersWithoutRoles, repeatOffenders,
} from '../members/memberInsightsService.js';
import { getLevelingConfig } from '../leveling/leveling.js';

/** Everything these pages read or write, in one object so tests can replace any of it. */
export const defaultMemberTools = {
    listRoleRules, saveRoleRule, disableRoleRule, deleteRoleRule, loadLevels,
    joinsLeavesPerDay, repeatOffenders, loadLastActivity,
    levelingEnabled: async (client, guildId) => Boolean((await getLevelingConfig(client, guildId))?.enabled),
};

/**
 * The rule in a form (name, trigger, threshold, triggerRoleId, roleId, removeWhenFalse,
 * enabled, id). Throws an InputError naming the field; does not check roles (ruleProblem does).
 */
export function parseRuleForm(form) {
    const name = text(form, 'name', NAME_MAX);
    if (!name) throw new InputError('Give the rule a name.', 400, 'name');
    const trigger = text(form, 'trigger', 20);
    if (!Object.hasOwn(RULE_TRIGGERS, trigger)) throw new InputError('Choose when the rule applies.', 400, 'trigger');
    const roleId = text(form, 'roleId', 20);
    if (!isSnowflake(roleId)) throw new InputError('Choose the role to give.', 400, 'roleId');
    const rule = { name, trigger, roleId, removeWhenFalse: text(form, 'removeWhenFalse', 1) === '1', enabled: text(form, 'enabled', 1) === '1', threshold: null, triggerRoleId: null };
    if (trigger === 'has_role') {
        const triggerRoleId = text(form, 'triggerRoleId', 20);
        if (!isSnowflake(triggerRoleId)) throw new InputError('Choose the trigger role.', 400, 'triggerRoleId');
        rule.triggerRoleId = triggerRoleId;
    } else {
        const raw = text(form, 'threshold', 6);
        if (!/^\d{1,5}$/.test(raw)) throw new InputError(trigger === 'level_reached' ? 'Give the level (a whole number).' : 'Give the number of days (a whole number).', 400, 'threshold');
        rule.threshold = Number(raw);
    }
    const id = text(form, 'id', 12);
    if (id) {
        if (!/^\d{1,12}$/.test(id)) throw new InputError('Not a rule.');
        rule.id = Number(id);
    }
    return rule;
}

const memberName = (m) => m?.nickname || m?.user?.globalName || m?.user?.username || m?.id;

export function createMemberToolsHandlers(core) {
    const { client, guildId, settings, sendHtml, fail, shellOf, confirms, helpers, memberTools: m = defaultMemberTools } = core;
    const { guardedPost, freshModerator, flash, audit, completeMemberCache, guildOf, isOwner, canWrite } = helpers;

    const roleNameOf = (guild) => (id) => guild?.roles?.cache?.get(id)?.name || `deleted role ${id}`;
    const allRoles = (guild) => [...(guild?.roles?.cache?.values?.() || [])].filter((r) => r.id !== guild.id)
        .sort((a, b) => (b.position ?? 0) - (a.position ?? 0)).map((r) => ({ id: r.id, name: r.name }));

    /** Roles a rule may give for this viewer: the bot's handout check and the moderator check. */
    async function givableRoles(req, guild) {
        const actorMember = await guild.members.fetch({ user: req.dashboard.session.userId }).catch(() => null);
        const owner = isOwner(req);
        return [...guild.roles.cache.values()]
            .filter((role) => !ruleProblem({ trigger: 'days_in_server', threshold: 0, roleId: role.id }, guild, guild.members.me)
                && !roleProblem({ guild, role, actorMember, actorIsOwner: owner, botMember: guild.members.me }))
            .sort((a, b) => (b.position ?? 0) - (a.position ?? 0)).map((r) => ({ id: r.id, name: r.name }));
    }

    async function renderRules(req, res, status = 200, { error = null, values = null } = {}) {
        const guild = guildOf();
        if (!guild) return fail(res, 503, 'Server unavailable', 'The bot cannot see the main server right now. Try again in a moment.', req);
        let rules = [];
        let loadError = null;
        try {
            rules = await m.listRoleRules(guildId);
        } catch (err) {
            logger.warn(`Dashboard role rules not loaded: ${err.message}`);
            loadError = 'The role rules could not be loaded (database not responding). Nothing was changed; reload to try again.';
        }
        const problems = new Map(rules.map((r) => [r.id, ruleProblem(r, guild, guild.members.me)]).filter(([, p]) => p).map(([id, p]) => [id, plainText(p)]));
        const editId = Number.parseInt(queryText(req.query, 'edit', 12), 10);
        const editing = Number.isInteger(editId) ? rules.find((r) => r.id === editId) || null : null;
        const levelingOn = await m.levelingEnabled(client, guildId).catch(() => true);
        const writable = canWrite(req);
        return sendHtml(res, status, roleRulesPage({
            ...shellOf(req), rules, problems, roleName: roleNameOf(guild), roles: allRoles(guild),
            givable: writable ? await givableRoles(req, guild) : [],
            canWrite: writable, editEnabled: settings.editEnabled, canAct: req.dashboard.access.canAct,
            flash: status === 200 ? req.dashboard.flash : null, error, editing, values, levelingOn, loadError,
        }));
    }

    const rules = (req, res) => renderRules(req, res);
    const rerenderRules = (req, res, status, message) => {
        const body = req.body || {};
        const values = Object.fromEntries(['id', 'name', 'trigger', 'threshold', 'triggerRoleId', 'roleId', 'removeWhenFalse', 'enabled']
            .map((k) => [k, typeof body[k] === 'string' ? body[k].slice(0, 100) : '']));
        return renderRules(req, res, status, { error: message, values: body.name !== undefined ? values : null });
    };

    /** The rule from the form, checked against the server's roles and this moderator. */
    async function checkedRule(req) {
        const guild = guildOf();
        const rule = parseRuleForm(req.body || {});
        const problem = ruleProblem(rule, guild, guild.members.me);
        if (problem) throw new InputError(plainText(problem), 400, 'roleId');
        const moderator = await freshModerator(req);
        const modProblem = roleProblem({ guild, role: guild.roles.cache.get(rule.roleId), actorMember: moderator, actorIsOwner: isOwner(req), botMember: guild.members.me });
        if (modProblem) throw new InputError(modProblem, 400, 'roleId');
        return { guild, rule };
    }

    const preview = guardedPost(async (req, res) => {
        const { guild, rule } = await checkedRule(req);
        const existing = await m.listRoleRules(guildId);
        if (rule.id && !existing.some((r) => r.id === rule.id)) throw new InputError('That rule no longer exists.', 404);
        if (!rule.id && existing.length >= MAX_RULES) throw new InputError(`This server already has ${MAX_RULES} rules, the most allowed.`);
        await completeMemberCache(guild);
        const levels = [...existing, rule].some((r) => r.trigger === 'level_reached') ? await m.loadLevels(guildId) : new Map();
        const plan = dryRunRule({ ...rule, enabled: true }, existing, guild.members.cache.values(), { guild, botMember: guild.members.me, levels });
        const named = (ids) => ids.map((id) => ({ id, name: memberName(guild.members.cache.get(id)) }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
        const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: 'role-rule', payload: rule });
        return sendHtml(res, 200, roleRulePreviewPage({
            ...shellOf(req), rule, description: describeRule(rule, roleNameOf(guild)), add: named(plan.add), remove: named(plan.remove),
            token, hash, cached: guild.members.cache.size, memberCount: guild.memberCount || null,
        }));
    }, { rerender: rerenderRules });

    const save = guardedPost(async (req, res) => {
        const rule = confirms.consume(text(req.body, 'token', 100), { session: req.dashboard.session.idHash, subject: 'role-rule', hash: text(req.body, 'fh', 100) });
        if (!rule) throw new InputError('This dry run expired or was already used. Nothing was saved; run the dry run again.');
        // Checked again: roles and positions may have changed since the dry run.
        const guild = guildOf();
        const problem = ruleProblem(rule, guild, guild.members.me);
        if (problem) throw new InputError(plainText(problem));
        const moderator = await freshModerator(req);
        const modProblem = roleProblem({ guild, role: guild.roles.cache.get(rule.roleId), actorMember: moderator, actorIsOwner: isOwner(req), botMember: guild.members.me });
        if (modProblem) throw new InputError(modProblem);
        const by = { id: req.dashboard.session.userId, username: req.dashboard.session.username || req.dashboard.session.userId };
        const { before, after, full } = await m.saveRoleRule(guildId, rule, by);
        if (full) throw new InputError(`This server already has ${MAX_RULES} rules, the most allowed.`);
        if (!after) throw new InputError('That rule no longer exists; nothing was saved.', 404);
        const snapshot = (r) => (r ? { name: r.name, rule: describeRule(r, roleNameOf(guild)), enabled: r.enabled } : null);
        await audit(req, 'rolerules', [{ key: `rule:${after.id}`, old: snapshot(before), new: snapshot(after) }], { modLog: true, label: 'Role rules' });
        logger.info(`Dashboard role rule ${after.id} ${before ? 'updated' : 'created'} by ${by.id} (enabled: ${after.enabled})`);
        await flash(req, `Rule "${after.name}" ${before ? 'saved' : 'created'}${after.enabled ? '; the next run (within 10 minutes) applies it.' : ', switched off.'}`);
        return res.redirect(303, path('/users/rules'));
    }, { rerender: rerenderRules });

    const ruleIdParam = (req) => {
        const raw = typeof req.params?.rid === 'string' ? req.params.rid : '';
        if (!/^\d{1,12}$/.test(raw)) throw new InputError('Not a rule.', 404);
        return Number(raw);
    };

    const disable = guardedPost(async (req, res) => {
        const id = ruleIdParam(req);
        await freshModerator(req);
        const before = await m.disableRoleRule(guildId, id);
        if (!before) throw new InputError('That rule no longer exists.', 404);
        if (before.enabled) {
            await audit(req, 'rolerules', [{ key: `rule:${id}.enabled`, old: true, new: false }], { modLog: true, label: 'Role rules' });
        }
        await flash(req, `Rule "${before.name}" turned off. Roles it already gave stay.`);
        return res.redirect(303, path('/users/rules'));
    }, { rerender: rerenderRules });

    const remove = guardedPost(async (req, res) => {
        const id = ruleIdParam(req);
        await freshModerator(req);
        const removed = await m.deleteRoleRule(guildId, id);
        if (!removed) throw new InputError('That rule no longer exists.', 404);
        await audit(req, 'rolerules', [{ key: `rule:${id}`, old: { name: removed.name, rule: describeRule(removed, roleNameOf(guildOf())), enabled: removed.enabled }, new: null }],
            { modLog: true, label: 'Role rules' });
        await flash(req, `Rule "${removed.name}" deleted. Roles it already gave stay.`);
        return res.redirect(303, path('/users/rules'));
    }, { rerender: rerenderRules });

    /** GET /dashboard/users/insights. Each part loads on its own; a failing query shows its error. */
    async function insights(req, res) {
        const guild = guildOf();
        const part = async (label, fn) => {
            try {
                return { value: await fn(), error: null };
            } catch (err) {
                logger.warn(`Dashboard insights (${label}) failed: ${err.message}`);
                return { value: null, error: `Could not be loaded (database not responding). Reload to try again.` };
            }
        };
        if (guild) await completeMemberCache(guild);
        const levelingOn = await m.levelingEnabled(client, guildId).catch(() => false);
        const [joins, offenders, activity] = await Promise.all([
            part('joins', () => m.joinsLeavesPerDay(guildId)),
            part('offenders', () => m.repeatOffenders(guildId)),
            levelingOn && guild ? part('activity', () => m.loadLastActivity(guildId)) : { value: null, error: null },
        ]);
        return sendHtml(res, 200, insightsPage({
            ...shellOf(req),
            joins: joins.value, joinsError: joins.error,
            noRoles: guild ? membersWithoutRoles(guild) : null,
            offenders: offenders.value, offendersError: offenders.error,
            inactive: activity.value && guild ? inactiveMembers(guild, activity.value) : null, inactiveError: activity.error,
            levelingOn, cached: guild?.members?.cache?.size ?? null, memberCount: guild?.memberCount || null,
        }));
    }

    return { rules, preview, save, disable, remove, insights };
}
