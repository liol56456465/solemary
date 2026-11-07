// botPermissions.js — the "Mewvo's permissions" card (Overview, first setup step): the
// server-level permissions Mewvo needs for the features that are on, each one ✓ or missing,
// and the roles Mewvo must sit above (it cannot give or take a role at or above its own).
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
