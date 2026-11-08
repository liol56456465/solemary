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
