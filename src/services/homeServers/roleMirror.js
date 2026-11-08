// roleMirror.js — a member's roles in Mewvo's MAIN server decide some of their roles in the
// support and database servers (rules: config/homeServers.js, docs/home-servers.md).
//
// Only roles a rule names as its target are ever touched ("managed" roles): the target role is
// given while the member has any of its source roles in main, and taken away when they have
// none (or left main). Every other role (Banned role, supporter role, warn roles, level roles…)
// is left alone; each change is a single-role add/remove (PUT/DELETE of that one role), never a
// full role-list PATCH, so it cannot overwrite a role another sync changed at the same moment.
//
// Triggers: guildMemberUpdate in MAIN only (a change in support/database never comes back here,
// so the mirror cannot loop), guildMemberAdd in support/database, guildMemberRemove from main,
// and an hourly paced reconcile through the member fetch gate. If main is not reachable, or the
// member's main state is unknown (fetch failed, partial member list), nothing is removed.
//
// Before a change the target role is checked: it exists, is not managed by an integration, the
// bot has Manage Roles and its highest role is above it. Otherwise one warning per role per hour
// and that role is skipped. Audit-log reason: "Mewvo role mirror". The staff guard ignores the
// bot's own audit-log entries (staffGuardService.handleAuditLogEntry) and the mass-action guard
// only counts bans/kicks/mutes, so these changes trip neither.

import { PermissionFlagsBits } from 'discord.js';
import { homeServers } from '../../config/homeServers.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { fetchAllMembers } from '../../utils/memberFetchGate.js';

export const MIRROR_REASON = 'Mewvo role mirror';
export const WARN_EVERY_MS = 60 * 60_000;
export const RECONCILE_PAUSE_MS = 250;
export const TARGET_GUILDS = Object.freeze(['support', 'database']);
const UNKNOWN_MEMBER = 10007;

const warnedAt = new BoundedMap(500); // `${guildId}:${roleId}` → last warning time
const userQueues = new BoundedMap(2000); // userId → the user's running sync (serialized per user)
let unsetLogged = false;

/** The rules that can run (target set). */
export const activeRules = (rules) => rules.filter((rule) => rule.target);

/** Every source role id of the rules. */
export function sourceRoleIds(rules) {
    return new Set(activeRules(rules).flatMap((rule) => rule.sources));
}

/** The target roles the mirror manages in one server ('support' | 'database'). */
export function managedRoles(rules, guildKey) {
    return new Set(activeRules(rules).filter((rule) => rule.guild === guildKey).map((rule) => rule.target));
}

/**
 * The target roles one member should have in one server, from their main role ids
 * (null = not in main: none).
 */
export function wantedRoles(rules, guildKey, mainRoleIds) {
    const wanted = new Set();
    if (!mainRoleIds) return wanted;
    for (const rule of activeRules(rules)) {
        if (rule.guild === guildKey && rule.sources.some((id) => mainRoleIds.has(id))) wanted.add(rule.target);
    }
    return wanted;
}

const roleIdsOf = (member) => new Set(member?.roles?.cache?.keys?.() ?? []);

function warnOnce(guild, roleId, problem, { log = logger, now = Date.now } = {}) {
    const key = `${guild.id}:${roleId}`;
    const last = warnedAt.get(key) || 0;
    if (now() - last < WARN_EVERY_MS) return;
    warnedAt.set(key, now());
    log.warn(`Role mirror: skipping role ${roleId} in ${guild.name || guild.id}: ${problem}`);
}

/** Why the bot cannot hand out this role in its server, or null when it can. */
export function roleProblem(role, me) {
    if (!role) return 'the role does not exist in that server';
    if (role.managed) return 'the role is managed by an integration';
    if (!me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return 'the bot lacks Manage Roles there';
    const highest = me.roles?.highest;
    if (!highest || role.position >= highest.position) {
        return `the bot's highest role (${highest?.name ?? '?'}) must be above "${role.name}"`;
    }
    return null;
}

/** The managed roles of a server the bot can change now (others warned once per hour). */
export async function usableRoles(guild, roleIds, options = {}) {
    const me = guild.members?.me || await guild.members?.fetchMe?.().catch(() => null);
    const usable = new Set();
    for (const roleId of roleIds) {
        const role = guild.roles?.cache?.get(roleId) || await guild.roles?.fetch?.(roleId).catch(() => null);
        const problem = roleProblem(role, me);
        if (problem) warnOnce(guild, roleId, problem, options);
        else usable.add(roleId);
    }
    return usable;
}

/**
 * Brings one member in line: for each usable managed role, add when wanted and missing,
 * remove when held and not wanted. Returns { added, removed, errors }.
 */
export async function applyToMember(member, wanted, usable, { log = logger } = {}) {
    const out = { added: 0, removed: 0, errors: 0 };
    for (const roleId of usable) {
        const has = member.roles.cache.has(roleId);
        const want = wanted.has(roleId);
        if (has === want) continue;
        try {
            if (want) {
                await member.roles.add(roleId, MIRROR_REASON);
                out.added += 1;
            } else {
                await member.roles.remove(roleId, MIRROR_REASON);
                out.removed += 1;
            }
        } catch (error) {
            out.errors += 1;
            log.warn(`Role mirror: could not ${want ? 'add' : 'remove'} role ${roleId} for ${member.id} in ${member.guild?.id}: ${error.message}`);
        }
    }
    return out;
}

/** The member in a server: cache, else fetch. null = not a member; undefined = unknown (error). */
async function findMember(guild, userId) {
    const cached = guild.members.cache.get(userId);
    if (cached) return cached;
    try {
        return await guild.members.fetch(userId);
    } catch (error) {
        return error?.code === UNKNOWN_MEMBER ? null : undefined;
    }
}

async function syncNow(client, userId, { mainMember, env, log, only }) {
    const { guilds, mirrorRules } = homeServers(env);
    const rules = activeRules(mirrorRules);
    if (!rules.length || !guilds.main) return { skipped: 'no rules' };
    if (mainMember === undefined) {
        const main = client.guilds.cache.get(guilds.main);
        if (!main) return { skipped: 'main server not available' };
        mainMember = await findMember(main, userId);
        if (mainMember === undefined) return { skipped: 'main member unknown' };
    }
    const mainRoles = mainMember ? roleIdsOf(mainMember) : null;
    const total = { added: 0, removed: 0, errors: 0 };
    for (const key of only ? [only] : TARGET_GUILDS) {
        const managed = managedRoles(rules, key);
        const guild = guilds[key] ? client.guilds.cache.get(guilds[key]) : null;
        if (!managed.size || !guild) continue;
        const member = await findMember(guild, userId);
        if (!member || member.user?.bot) continue;
        const usable = await usableRoles(guild, managed, { log });
        const result = await applyToMember(member, wantedRoles(rules, key, mainRoles), usable, { log });
        total.added += result.added;
        total.removed += result.removed;
        total.errors += result.errors;
    }
    return total;
}

/**
 * Syncs one user's mirrored roles in support and database (or `only` one of them).
 * mainMember: their main GuildMember, null when they are not in main, undefined = look it up.
 * Serialized per user; never throws (errors are logged).
 */
export function syncMirrorForUser(client, userId, { mainMember, env = process.env, log = logger, only = null } = {}) {
    const previous = userQueues.get(userId) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => syncNow(client, userId, { mainMember, env, log, only }))
        .catch((error) => {
            log.warn(`Role mirror: sync failed for ${userId}: ${error.message}`);
            return { errors: 1 };
        });
    userQueues.set(userId, run);
    run.finally(() => { if (userQueues.get(userId) === run) userQueues.delete(userId); });
    return run;
}

/** guildMemberUpdate: only in main, only when a source role changed (or the old roles are unknown). */
export function handleMemberUpdate(oldMember, newMember, { env = process.env, log = logger } = {}) {
    const { guilds, mirrorRules } = homeServers(env);
    if (!guilds.main || newMember?.guild?.id !== guilds.main || newMember.user?.bot) return null;
    const sources = sourceRoleIds(mirrorRules);
    if (!sources.size) return null;
    if (!oldMember?.partial) {
        const before = roleIdsOf(oldMember);
        const after = roleIdsOf(newMember);
        if (![...sources].some((id) => before.has(id) !== after.has(id))) return null;
    }
    return syncMirrorForUser(newMember.client, newMember.id, { mainMember: newMember, env, log });
}

/** guildMemberAdd: joining support/database gets the roles their main roles give. */
export function handleMemberAdd(member, { env = process.env, log = logger } = {}) {
    const { guilds } = homeServers(env);
    const key = TARGET_GUILDS.find((k) => guilds[k] && guilds[k] === member?.guild?.id);
    if (!key || member.user?.bot) return null;
    return syncMirrorForUser(member.client, member.id, { env, log, only: key });
}

/** guildMemberRemove: leaving main takes the mirrored roles away in the other two. */
export function handleMemberRemove(member, { env = process.env, log = logger } = {}) {
    const { guilds } = homeServers(env);
    if (!guilds.main || member?.guild?.id !== guilds.main || member.user?.bot) return null;
    return syncMirrorForUser(member.client, member.id ?? member.user?.id, { mainMember: null, env, log });
}

const defaultSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/**
 * Hourly: every member of support and database is brought in line with main. Full member lists
 * through the fetch gate; members missing from a partial main list are left alone. Paced
 * (a pause after each member that needed a change). One summary log line.
 */
export async function reconcileRoleMirror(client, {
    env = process.env, log = logger, fetchAll = fetchAllMembers, pauseMs = RECONCILE_PAUSE_MS, sleep = defaultSleep,
} = {}) {
    const { guilds, mirrorRules } = homeServers(env);
    const rules = activeRules(mirrorRules);
    if (!rules.length) return { skipped: 'no rules' };
    const main = guilds.main ? client.guilds.cache.get(guilds.main) : null;
    if (!main) {
        log.warn('Role mirror reconcile skipped: the main server is not available');
        return { skipped: 'main server not available' };
    }
    const fetchOptions = { maxAgeMs: 60 * 60_000, timeoutMs: 30_000 };
    const mainList = await fetchAll(main, fetchOptions);
    const summary = { scanned: 0, added: 0, removed: 0, errors: 0, unknown: 0, partial: Boolean(mainList.partial), servers: [] };
    for (const key of TARGET_GUILDS) {
        const managed = managedRoles(rules, key);
        const guild = guilds[key] ? client.guilds.cache.get(guilds[key]) : null;
        if (!managed.size) continue;
        if (!guild) {
            summary.servers.push(`${key}: not available`);
            continue;
        }
        const usable = await usableRoles(guild, managed, { log });
        const list = await fetchAll(guild, fetchOptions);
        if (list.partial) summary.partial = true;
        summary.servers.push(`${key}: ${usable.size}/${managed.size} roles`);
        if (!usable.size) continue;
        for (const member of list.members.values()) {
            if (member.user?.bot) continue;
            summary.scanned += 1;
            const mainMember = mainList.members.get(member.id);
            if (!mainMember && mainList.partial) {
                summary.unknown += 1; // not in a partial main list: their main roles are unknown
                continue;
            }
            const result = await applyToMember(member, wantedRoles(rules, key, mainMember ? roleIdsOf(mainMember) : null), usable, { log });
            summary.added += result.added;
            summary.removed += result.removed;
            summary.errors += result.errors;
            if (result.added || result.removed || result.errors) await sleep(pauseMs);
        }
    }
    log.info(`Role mirror reconcile: scanned ${summary.scanned}, added ${summary.added}, removed ${summary.removed}, errors ${summary.errors}`
        + `${summary.unknown ? `, ${summary.unknown} left alone (not in the cached main list)` : ''}`
        + `${summary.partial ? ' (cached members only)' : ''} [${summary.servers.join('; ')}]`);
    return summary;
}

/** Startup: one line per UNSET rule (once per process). */
export function logUnsetRulesOnce({ env = process.env, log = logger } = {}) {
    if (unsetLogged) return 0;
    unsetLogged = true;
    const unset = homeServers(env).mirrorRules.filter((rule) => !rule.target);
    for (const rule of unset) {
        log.warn(`Role mirror: the ${rule.guild} role for main roles ${rule.sources.join(', ')} is not set`
            + `${rule.given ? ` (given as "${rule.given}", not a valid role id)` : ''}; that rule is skipped until it is corrected in config/homeServers.js`);
    }
    return unset.length;
}

/** Tests only. */
export function resetRoleMirrorState() {
    warnedAt.clear();
    userQueues.clear();
    unsetLogged = false;
}
