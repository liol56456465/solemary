// serverScope.js — which server a module page is about, and the Administrator check for
// parts of a form (multi-server B3b).
//
// Module handlers get ctx.guildId (the server of the dashboard instance). A ctx without one
// (older tests, the single-server dashboard) means the main server, as before.

import { isMewvoServer } from '../../../utils/ownerPower.js';
import { isHomeGuild } from '../../settings/guildSettings.js';
import { InputError } from '../forms.js';

/** True when the page is about one of Mewvo's own servers (main/support), or no server is given. */
export function isHomeScope(ctx) {
    const guildId = ctx?.guildId ? String(ctx.guildId) : null;
    // ctx.env first (the dashboard's env, tests), then the process env / loaded config.
    return !guildId || (ctx.env ? isHomeGuild(guildId, ctx.env) : false) || isMewvoServer(guildId);
}

/**
 * For actions where only one field is Administrator-only (a role in a form that also has
 * channels): refuses with 403 unless the viewer may act (Administrator). Nothing is changed.
 */
export function requireCanAct(ctx, message, field = null) {
    if (!ctx?.canAct) throw new InputError(message, 403, field);
}

/**
 * Safety modules (automod, logging, enforcement): every action is Administrator-only, so a
 * Manage Server manager can't weaken moderation, hide the logs or move the mod log (owner
 * decision 1, B3). Wraps each action as { ...action, admin: true }; plain functions become { run }.
 */
export function adminOnlyActions(actions) {
    return Object.fromEntries(Object.entries(actions).map(([name, action]) => [
        name,
        typeof action === 'function' ? { admin: true, run: action } : { ...action, admin: true },
    ]));
}

/**
 * The few actions a viewer without Administrator (a Manage Server manager, an OWNER_IDS
 * account without it at home, a moderator with Manage Server) may run: plainly harmless
 * community settings. Every other action needs Administrator (routes.js moduleAction: the
 * default is closed, so a new action stays Administrator-only until someone marks it).
 * Wraps the named actions as { ...action, manager: true }; plain functions become { run }.
 * A name that is not an action throws (a typo must not silently leave a list stale).
 */
export function managerActions(names, actions) {
    const out = { ...actions };
    for (const name of names) {
        if (!Object.hasOwn(actions, name)) throw new Error(`managerActions: no action "${name}"`);
        const action = actions[name];
        out[name] = typeof action === 'function' ? { manager: true, run: action } : { ...action, manager: true };
    }
    return out;
}
