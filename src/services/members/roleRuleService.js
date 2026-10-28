// roleRuleService.js — role rules (dashboard Members → Role rules): roles the bot gives by
// itself when a member meets a condition, and optionally takes back when they no longer do.
//
// Triggers: days in the server ≥ N, leveling level ≥ N (user_levels), has role X. The role
// given must pass the same check as every role the bot hands out on its own
// (utils/roleSafety.js getRoleAssignmentProblem: not @everyone, not managed, below the bot, no
// staff permissions); a rule whose role fails it changes nothing and shows why on the page.
//
// Evaluation is pure (planRules): the dashboard's dry run and the runner use the same code.
// The runner (cron every 10 minutes, runRoleRules) applies at most RUN_CHANGE_LIMIT changes per
// server per run, one Discord call at a time with a pause between calls; the rest follows on
// the next run. Events apply the cheap cases at once (applyRoleRulesToMember): level-up for
// level rules, role changes for has-role rules, joins for every rule.
//
// "Remove when no longer true" takes the role from every member who has it but no longer
// matches — unless another enabled rule for the same role still matches them.

import { query, T } from '../enforcement/db.js';
import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../../utils/logger.js';
import { getRoleAssignmentProblem } from '../../utils/roleSafety.js';

export const RULE_TRIGGERS = {
    days_in_server: 'Days in the server',
    level_reached: 'Leveling level',
    has_role: 'Has a role',
};
export const MAX_RULES = 25;
export const MAX_DAYS = 3650;
export const MAX_LEVEL = 1000;
export const NAME_MAX = 80;
/** Role changes per server per run; the rest is done on the next run (10 minutes later). */
export const RUN_CHANGE_LIMIT = 120;
/** Pause between two Discord calls of a run (Discord allows a few role changes per second). */
export const CALL_DELAY_MS = 1000;
const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 60_000;

// ── Pure evaluation ──────────────────────────────────────────────────────

/** "Members who joined 30+ days ago get @Regular (taken back when …)". */
export function describeRule(rule, roleName = (id) => id) {
    const role = `@${roleName(rule.roleId)}`;
    const when = rule.trigger === 'days_in_server'
        ? (rule.threshold === 0 ? 'Every member, on joining,' : `Members in the server for ${rule.threshold}+ day${rule.threshold === 1 ? '' : 's'}`)
        : rule.trigger === 'level_reached' ? `Members at leveling level ${rule.threshold}+`
            : `Members with @${roleName(rule.triggerRoleId)}`;
    return `${when} get ${role}${rule.removeWhenFalse ? ', taken away again when that is no longer true' : ''}.`;
}

/**
 * Why this rule cannot run, or null. Checks the given role with getRoleAssignmentProblem (the
 * bot's own role-handout rule) and the trigger role of a has-role rule.
 */
export function ruleProblem(rule, guild, botMember) {
    if (!Object.hasOwn(RULE_TRIGGERS, rule.trigger)) return 'Unknown trigger.';
    if (rule.trigger === 'has_role') {
        if (!rule.triggerRoleId || rule.triggerRoleId === guild?.id) return 'Choose the role that triggers the rule (not @everyone; use "days in the server: 0" for everyone).';
        if (!guild?.roles?.cache?.get(rule.triggerRoleId)) return 'The trigger role no longer exists.';
        if (rule.triggerRoleId === rule.roleId) return 'The trigger role and the role given must differ.';
    } else {
        const max = rule.trigger === 'level_reached' ? MAX_LEVEL : MAX_DAYS;
        const min = rule.trigger === 'level_reached' ? 1 : 0;
        if (!Number.isInteger(rule.threshold) || rule.threshold < min || rule.threshold > max) {
            return rule.trigger === 'level_reached' ? `Level must be a whole number from 1 to ${MAX_LEVEL}.` : `Days must be a whole number from 0 to ${MAX_DAYS}.`;
        }
    }
    return getRoleAssignmentProblem(guild?.roles?.cache?.get(rule.roleId) || null, botMember);
}

/** Whether the member meets the rule's condition now. levels: Map userId → level. */
export function ruleMatches(rule, member, { now = Date.now(), levels = new Map() } = {}) {
    if (rule.trigger === 'days_in_server') {
        const joined = member.joinedTimestamp ?? (member.joinedAt ? new Date(member.joinedAt).getTime() : null);
        return Number.isFinite(joined) && now - joined >= rule.threshold * DAY_MS;
    }
    if (rule.trigger === 'level_reached') return (levels.get(member.id) ?? 0) >= rule.threshold;
    if (rule.trigger === 'has_role') return Boolean(member.roles?.cache?.has?.(rule.triggerRoleId));
    return false;
}

/**
 * What each rule would change now: [{ rule, problem, add: [memberId], remove: [memberId] }],
 * in the order of `rules`. Bots are never touched. A member is added once per role even when
 * several rules give it; a removal is skipped while any other runnable rule for the same role
 * still matches the member. Rules with a problem change nothing.
 */
export function planRules(rules, members, { guild, botMember, now = Date.now(), levels = new Map() } = {}) {
    const humans = [...members].filter((m) => m && !m.user?.bot);
    const plans = rules.map((rule) => ({ rule, problem: ruleProblem(rule, guild, botMember), add: [], remove: [] }));
    const runnable = plans.filter((p) => !p.problem);
    // Per member: does it match each runnable rule (computed once).
    const matches = new Map(runnable.map((p) => [p, new Set(humans.filter((m) => ruleMatches(p.rule, m, { now, levels })).map((m) => m.id))]));
    const wanted = new Map();
    for (const p of runnable) {
        const set = wanted.get(p.rule.roleId) || new Set();
        for (const id of matches.get(p)) set.add(id);
        wanted.set(p.rule.roleId, set);
    }
    const claimed = new Set();
    for (const p of runnable) {
        const roleId = p.rule.roleId;
        for (const member of humans) {
            const has = Boolean(member.roles?.cache?.has?.(roleId));
            const key = `${member.id}:${roleId}`;
            if (claimed.has(key)) continue;
            if (matches.get(p).has(member.id)) {
                if (!has) { p.add.push(member.id); claimed.add(key); }
            } else if (has && p.rule.removeWhenFalse && !wanted.get(roleId).has(member.id)) {
                p.remove.push(member.id);
                claimed.add(key);
            }
        }
    }
    return plans;
}

/**
 * The dry run of one rule (new, or an edit of `rule.id`), with the other enabled rules of the
 * server taken into account the same way the runner does.
 */
export function dryRunRule(rule, otherRules, members, ctx) {
    const others = otherRules.filter((r) => r.enabled && String(r.id) !== String(rule.id ?? ''));
    return planRules([...others, rule], members, ctx).at(-1);
}

// ── Storage (member_role_rules) ──────────────────────────────────────────

function fromRow(row) {
    return {
        id: Number(row.id), guildId: row.guild_id, name: row.name, trigger: row.trigger_kind,
        threshold: row.threshold === null ? null : Number(row.threshold), triggerRoleId: row.trigger_role_id || null,
        roleId: row.role_id, removeWhenFalse: Boolean(row.remove_when_false), enabled: Boolean(row.enabled),
        createdBy: row.created_by, createdByUsername: row.created_by_username, createdAt: row.created_at, updatedAt: row.updated_at,
        lastRunAt: row.last_run_at || null, lastAdded: Number(row.last_added) || 0, lastRemoved: Number(row.last_removed) || 0,
        lastFailed: Number(row.last_failed) || 0, lastProblem: row.last_problem || null,
    };
}

const ruleCache = new Map();
export function forgetRuleCache(guildId = null) {
    if (guildId) ruleCache.delete(guildId); else ruleCache.clear();
}

/** Every rule of the server, oldest first. A database error throws. */
export async function listRoleRules(guildId) {
    const { rows } = await query(`SELECT * FROM ${T.roleRules} WHERE guild_id = $1 ORDER BY id`, [guildId]);
    return rows.map(fromRow);
}

export async function getRoleRule(guildId, id) {
    const { rows } = await query(`SELECT * FROM ${T.roleRules} WHERE guild_id = $1 AND id = $2`, [guildId, id]);
    return rows[0] ? fromRow(rows[0]) : null;
}

/** Enabled rules, cached for a minute (events call this on every role change). */
async function enabledRulesCached(guildId, now = Date.now()) {
    const hit = ruleCache.get(guildId);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.rules;
    const { rows } = await query(`SELECT * FROM ${T.roleRules} WHERE guild_id = $1 AND enabled ORDER BY id`, [guildId]);
    const rules = rows.map(fromRow);
    ruleCache.set(guildId, { at: now, rules });
    return rules;
}

/**
 * Creates (no id) or replaces (id) a rule. Returns { before, after } ({ full: true } when the
 * server already has MAX_RULES). The cap is a sanity limit, checked in the INSERT itself; two
 * saves at the very same moment could still end at 26, which is harmless.
 */
export async function saveRoleRule(guildId, rule, by) {
    const values = [rule.name, rule.trigger, rule.trigger === 'has_role' ? null : rule.threshold,
        rule.trigger === 'has_role' ? rule.triggerRoleId : null, rule.roleId, Boolean(rule.removeWhenFalse), Boolean(rule.enabled)];
    forgetRuleCache(guildId);
    if (rule.id) {
        const before = await getRoleRule(guildId, rule.id);
        if (!before) return { before: null, after: null };
        const { rows } = await query(
            `UPDATE ${T.roleRules} SET name = $3, trigger_kind = $4, threshold = $5, trigger_role_id = $6, role_id = $7,
               remove_when_false = $8, enabled = $9, updated_at = NOW(), last_problem = NULL
             WHERE guild_id = $1 AND id = $2 RETURNING *`, [guildId, rule.id, ...values]);
        return { before, after: rows[0] ? fromRow(rows[0]) : null };
    }
    const { rows } = await query(
        `INSERT INTO ${T.roleRules} (guild_id, name, trigger_kind, threshold, trigger_role_id, role_id, remove_when_false, enabled, created_by, created_by_username)
         SELECT $1::varchar, $2::varchar, $3::varchar, $4::int, $5::varchar, $6::varchar, $7::boolean, $8::boolean, $9::varchar, $10::varchar
         WHERE (SELECT COUNT(*) FROM ${T.roleRules} WHERE guild_id = $1::varchar) < ${MAX_RULES}
         RETURNING *`, [guildId, ...values, by.id, by.username]);
    if (!rows[0]) return { before: null, after: null, full: true };
    return { before: null, after: fromRow(rows[0]) };
}

/** Turns a rule off (roles already given stay). Returns the rule before, or null. */
export async function disableRoleRule(guildId, id) {
    forgetRuleCache(guildId);
    const before = await getRoleRule(guildId, id);
    if (!before) return null;
    await query(`UPDATE ${T.roleRules} SET enabled = FALSE, updated_at = NOW() WHERE guild_id = $1 AND id = $2`, [guildId, id]);
    return before;
}

/** Deletes a rule (roles already given stay). Returns the deleted rule, or null. */
export async function deleteRoleRule(guildId, id) {
    forgetRuleCache(guildId);
    const { rows } = await query(`DELETE FROM ${T.roleRules} WHERE guild_id = $1 AND id = $2 RETURNING *`, [guildId, id]);
    return rows[0] ? fromRow(rows[0]) : null;
}

async function recordRun(rule, { at, added, removed, failed, problem }) {
    await query(
        `UPDATE ${T.roleRules} SET last_run_at = $2, last_added = $3, last_removed = $4, last_failed = $5, last_problem = $6 WHERE id = $1`,
        [rule.id, at, added, removed, failed, problem || null]);
}

async function guildsWithEnabledRules() {
    const { rows } = await query(`SELECT DISTINCT guild_id FROM ${T.roleRules} WHERE enabled`);
    return rows.map((r) => r.guild_id);
}

/** Leveling levels of a server (or of one member): Map userId → level (level > 0 only). */
export async function loadLevels(guildId, userId = null) {
    const { rows } = await query(
        `SELECT user_id, level FROM ${pgConfig.tables.user_levels} WHERE guild_id = $1 AND level > 0${userId ? ' AND user_id = $2' : ''}`,
        userId ? [guildId, userId] : [guildId]);
    return new Map(rows.map((r) => [r.user_id, Number(r.level) || 0]));
}

// ── Applying ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The member cache can be incomplete after a restart: fetch everyone at most once an hour. */
const lastFetch = new Map();
async function completeMemberCache(guild, now = Date.now()) {
    if (!guild?.memberCount || guild.members.cache.size >= guild.memberCount * 0.9) return;
    if (now - (lastFetch.get(guild.id) || 0) < 3_600_000) return;
    lastFetch.set(guild.id, now);
    await Promise.race([guild.members.fetch().catch(() => null), sleep(15_000)]);
}

const defaultDeps = {
    guildIds: guildsWithEnabledRules,
    listRules: async (guildId) => (await listRoleRules(guildId)).filter((r) => r.enabled),
    loadLevels,
    recordRun,
    completeMemberCache,
    sleep,
    delayMs: CALL_DELAY_MS,
    limit: RUN_CHANGE_LIMIT,
};

/** Adds / removes the planned roles one call at a time; returns per-rule counts. */
async function applyPlans(guild, plans, { limit, sleep: wait, delayMs, memberOf = (id) => guild.members.cache.get(id) }) {
    const results = new Map(plans.map((p) => [p, { added: 0, removed: 0, failed: 0 }]));
    let calls = 0;
    outer: for (const plan of plans) {
        for (const [mode, ids] of [['add', plan.add], ['remove', plan.remove]]) {
            for (const id of ids) {
                if (calls >= limit) break outer;
                const member = memberOf(id);
                if (!member) continue;
                if (calls > 0 && delayMs) await wait(delayMs);
                calls += 1;
                const result = results.get(plan);
                try {
                    await member.roles[mode](plan.rule.roleId, `Role rule: ${plan.rule.name}`);
                    if (mode === 'add') result.added += 1; else result.removed += 1;
                } catch (error) {
                    result.failed += 1;
                    logger.warn(`Role rule ${plan.rule.id} could not ${mode} role ${plan.rule.roleId} for ${id}: ${error.message}`);
                }
            }
        }
    }
    return { results, calls, capped: calls >= limit };
}

/**
 * The cron job: every server with enabled rules, every cached member. Returns
 * [{ guildId, added, removed, failed, capped }]. Safe to run while another instance is idle
 * (the caller's exclusive() guard prevents overlap in one process).
 */
export async function runRoleRules(client, { now = new Date(), deps: overrides = {} } = {}) {
    const deps = { ...defaultDeps, ...overrides };
    const summary = [];
    for (const guildId of await deps.guildIds()) {
        const guild = client.guilds?.cache?.get(guildId);
        if (!guild) continue;
        const rules = await deps.listRules(guildId);
        if (!rules.length) continue;
        await deps.completeMemberCache(guild);
        const levels = rules.some((r) => r.trigger === 'level_reached') ? await deps.loadLevels(guildId) : new Map();
        const plans = planRules(rules, guild.members.cache.values(), { guild, botMember: guild.members.me, now: now.getTime(), levels });
        const { results, capped } = await applyPlans(guild, plans, deps);
        const total = { guildId, added: 0, removed: 0, failed: 0, capped };
        for (const plan of plans) {
            const r = results.get(plan);
            total.added += r.added; total.removed += r.removed; total.failed += r.failed;
            if (plan.problem) logger.warn(`Role rule ${plan.rule.id} (${guildId}) skipped: ${plan.problem.replace(/\*\*/g, '')}`);
            else if (r.added || r.removed || r.failed) logger.info(`Role rule ${plan.rule.id} "${plan.rule.name}" (${guildId}): +${r.added} −${r.removed}${r.failed ? `, ${r.failed} failed` : ''}`);
            await deps.recordRun(plan.rule, { at: now, ...r, problem: plan.problem ? plan.problem.replace(/\*\*/g, '') : null })
                .catch((error) => logger.warn(`Role rule ${plan.rule.id}: run not recorded: ${error.message}`));
        }
        if (capped) logger.info(`Role rules (${guildId}): change limit of ${deps.limit} reached; the rest follows on the next run`);
        summary.push(total);
    }
    return summary;
}

/**
 * One member, right away (join, level-up, role change). `triggers` limits which rules may
 * change something (e.g. only level rules on a level-up); all enabled rules still count for
 * "another rule still gives this role". `level` saves the lookup on a level-up.
 */
export async function applyRoleRulesToMember(member, { triggers = null, level = null, now = Date.now(), deps: overrides = {} } = {}) {
    if (!member?.guild || member.user?.bot) return { added: 0, removed: 0 };
    const deps = { listEnabled: enabledRulesCached, loadLevels, ...overrides };
    const rules = await deps.listEnabled(member.guild.id, now);
    if (!rules.length || (triggers && !rules.some((r) => triggers.includes(r.trigger)))) return { added: 0, removed: 0 };
    let levels = new Map();
    if (rules.some((r) => r.trigger === 'level_reached')) {
        levels = level !== null ? new Map([[member.id, level]]) : await deps.loadLevels(member.guild.id, member.id);
    }
    const plans = planRules(rules, [member], { guild: member.guild, botMember: member.guild.members.me, now, levels })
        .filter((p) => !triggers || triggers.includes(p.rule.trigger));
    const { results } = await applyPlans(member.guild, plans, { limit: 10, sleep, delayMs: 0, memberOf: (id) => (id === member.id ? member : null) });
    let added = 0;
    let removed = 0;
    for (const r of results.values()) { added += r.added; removed += r.removed; }
    if (added || removed) logger.info(`Role rules for ${member.id} (${member.guild.id}): +${added} −${removed}`);
    return { added, removed };
}
