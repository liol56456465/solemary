// botPermissions.js — the "Mewvo's permissions" card (Overview, first setup step): the
// server-level permissions Mewvo needs for the features that are on, each one ✓ or missing,
// and the roles Mewvo must sit above (it cannot give or take a role at or above its own).
//
// memberReach(): how many members sit at or above Mewvo's role (it cannot moderate them), from
// the member cache only.
//
// Read-only: it looks at guild.members.me and changes nothing. Channel overwrites are not
// checked here (the channel pickers warn about those per channel).

import { PermissionFlagsBits } from 'discord.js';

/**
 * Which feature needs which permission. `when`: the feature only counts while its module is
 * on (moduleStates key); without `when` it always counts. Order = the order on the card.
 */
export const FEATURE_PERMISSIONS = Object.freeze([
    { key: 'core', perms: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory'] },
    // Bans, kicks, the managed Muted role (role + channel overwrites), invites back after a kick,
    // voice disconnect on mute, timeouts from the member page.
    { key: 'enforcement', perms: ['BanMembers', 'KickMembers', 'ManageRoles', 'ManageChannels', 'CreateInstantInvite', 'MoveMembers', 'ModerateMembers'] },
    // Removing messages, timeouts, raid lockdown (server verification level), staff guard (audit log).
    { key: 'automod', when: 'automod', defaultOn: true, perms: ['ManageMessages', 'ModerateMembers', 'ManageGuild', 'ViewAuditLog'] },
    { key: 'logging', when: 'logging', perms: ['ViewAuditLog'] },
    { key: 'tickets', when: 'tickets', perms: ['ManageChannels', 'ManageRoles'] },
    { key: 'verification', when: 'verification', perms: ['ManageRoles'] },
    { key: 'leveling', when: 'leveling', perms: ['ManageRoles'] },
    { key: 'joinToCreate', when: 'joinToCreate', perms: ['ManageChannels', 'MoveMembers'] },
]);

export const PERMISSION_NAMES = Object.freeze([...new Set(FEATURE_PERMISSIONS.flatMap((f) => f.perms))]);

function featureOn(feature, moduleStates = {}) {
    if (!feature.when) return true;
    if (Object.hasOwn(moduleStates, feature.when)) return Boolean(moduleStates[feature.when]);
    return Boolean(feature.defaultOn);
}

/**
 * The report for a guild, or null when Mewvo's member is not known (cannot be checked).
 *   permissions  [{ name, ok, features: [featureKey] }]  in card order, only the ones needed
 *   roles        [{ id, name, purpose }]  roles at or above Mewvo's highest role (Muted, warning roles)
 *   botRole      the name of Mewvo's highest role (for "Server Settings → Roles → …"), or null
 *   ok           nothing missing, no role too high
 * `roles`: [{ role, purpose }] to check the position of (missing roles are skipped).
 */
export function botPermissionReport(guild, { moduleStates = {}, roles = [] } = {}) {
    const me = guild?.members?.me;
    if (!me?.permissions?.has) return null;
    const needed = new Map(); // name → feature keys
    for (const feature of FEATURE_PERMISSIONS) {
        if (!featureOn(feature, moduleStates)) continue;
        for (const name of feature.perms) {
            if (!needed.has(name)) needed.set(name, []);
            needed.get(name).push(feature.key);
        }
    }
    const has = (name) => {
        try {
            return Boolean(me.permissions.has(PermissionFlagsBits[name]));
        } catch {
            return false;
        }
    };
    const permissions = [...needed.entries()].map(([name, features]) => ({ name, ok: has(name), features }));
    const top = me.roles?.highest?.position;
    const seen = new Set();
    const tooHigh = [];
    for (const { role, purpose } of roles) {
        if (!role?.id || seen.has(role.id)) continue;
        seen.add(role.id);
        if (!Number.isFinite(top) || role.position >= top) tooHigh.push({ id: role.id, name: role.name, purpose });
    }
    const botRole = me.roles?.highest && me.roles.highest.id !== guild.id ? me.roles.highest.name || null : null;
    return {
        permissions,
        roles: tooHigh,
        botRole,
        missing: permissions.filter((p) => !p.ok).map((p) => p.name),
        ok: permissions.every((p) => p.ok) && !tooHigh.length,
    };
}

const ROLES_SHOWN = 3;

/** True when `role` sits at or above `top` in the role list (Discord's order: position, then id). */
function atOrAbove(role, top) {
    if (!role || !top) return false;
    if (role.id === top.id) return true;
    if (typeof role.comparePositionTo === 'function') {
        try {
            return role.comparePositionTo(top) >= 0;
        } catch {
            // fall through to the plain position
        }
    }
    return Number(role.position) >= Number(top.position);
}

/** Administrators are staff: their roles may stay above Mewvo's (they are not who Mewvo moderates). */
function isAdmin(member) {
    try {
        return Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator));
    } catch {
        return false;
    }
}

/**
 * Members Mewvo cannot moderate because their highest role is at or above Mewvo's own highest
 * role (Discord: a bot can only ban, kick, mute or give roles to members below it). From the
 * member cache only: never a member fetch (memberFetchGate.js is the only place that may run a
 * full one, and this is a page view). The server owner, Administrators and bots are not counted
 * (nobody can moderate the owner; admins are staff and may sit above Mewvo; bots are not who
 * staff moderate).
 *   { count, partial, roles: [{ id, name, members }] (at most 3, most members first), botRole }
 *   partial: the cache holds fewer than 90% of the members, so `count` is "at least".
 *   rolesAbove: [{ id, name }] roles at or above Mewvo's that ordinary members can hold (from the
 *            complete role list), so a mostly empty cache cannot pass as "all fine".
 * reachOk(reach): nobody blocked, and either the cache is complete or no such role exists.
 * null when it cannot be checked (Mewvo's member or the role list unknown).
 */
export function memberReach(guild) {
    const me = guild?.members?.me;
    const top = me?.roles?.highest;
    const members = guild?.members?.cache;
    if (!top || !members || typeof members.values !== 'function') return null;
    const byRole = new Map(); // role id → { id, name, members }
    let count = 0;
    for (const member of members.values()) {
        if (!member || member.id === me.id || member.user?.bot || member.id === guild.ownerId || isAdmin(member)) continue;
        const highest = member.roles?.highest;
        if (!highest || highest.id === guild.id || !atOrAbove(highest, top)) continue;
        count += 1;
        const entry = byRole.get(highest.id) || { id: highest.id, name: highest.name || highest.id, members: 0 };
        entry.members += 1;
        byRole.set(highest.id, entry);
    }
    const total = Number(guild.memberCount) || 0;
    // The role list is always complete (unlike the member cache): roles at or above Mewvo's that
    // can hold ordinary members (not @everyone, not a bot's managed role, not an Administrator role).
    const rolesAbove = [...(guild.roles?.cache?.values?.() || [])]
        .filter((r) => r && r.id !== guild.id && r.id !== top.id && !r.managed && atOrAbove(r, top)
            && !(() => { try { return r.permissions?.has?.(PermissionFlagsBits.Administrator); } catch { return false; } })())
        .sort((a, b) => Number(b.position) - Number(a.position))
        .slice(0, ROLES_SHOWN)
        .map((r) => ({ id: r.id, name: r.name || r.id }));
    return {
        count,
        rolesAbove,
        partial: !(total > 0 && members.size >= total * 0.9),
        roles: [...byRole.values()].sort((a, b) => b.members - a.members || String(a.name).localeCompare(String(b.name))).slice(0, ROLES_SHOWN),
        botRole: top.id !== guild.id ? top.name || null : null,
    };
}

/** True when the role position is verified fine (see memberReach). */
export function reachOk(reach) {
    if (!reach) return false;
    return reach.count === 0 && (!reach.partial || !(reach.rolesAbove || []).length);
}

/** The roles whose position matters: the Muted role (configured or found) and the warning roles. */
export function rolesToCheck(guild, { mutedRoleId = null, mutedRole = null, warnRoleIds = [] } = {}) {
    const cache = guild?.roles?.cache;
    const out = [];
    const muted = (mutedRoleId && cache?.get?.(mutedRoleId)) || mutedRole || null;
    if (muted) out.push({ role: muted, purpose: 'muted' });
    for (const id of Array.isArray(warnRoleIds) ? warnRoleIds : []) {
        const role = cache?.get?.(id);
        if (role) out.push({ role, purpose: 'warn' });
    }
    return out;
}
