// panelAccess.js — who may use the enforcement panel in Discord (/enforcements, the "Moderate"
// and "Warn for this message" menus, and every panel button, select and form).
//
// Owner decision D1 (2026-11-09):
//   - Administrator (or the server owner): every action, everywhere (unchanged).
//   - Mewvo's own servers (main + support, utils/ownerPower.js isMewvoServer): Administrator only,
//     exactly as before. The Moderator role gives nothing there in Discord.
//   - Any other server: a member holding the configured Moderator role (guild config `modRole`,
//     dashboard Commands page; the same role the dashboard's Moderator level uses) may open the
//     panel and run ONLY Warn, Mute, Kick, Unmute and Remove warn. Ban, Unban, case edits,
//     settings, automod and the safety tools stay Administrator.
// Re-checked on every interaction (the clicked component carries a fresh member). A config read
// that fails or is slow refuses (fail closed), with its own message. The mass-action guard
// applies to moderators like to everyone else (enforcementService.executeAction).

import { getGuildConfig } from '../config/guildConfig.js';
import { memberHasConfiguredModeratorRole } from '../../utils/permissionGuard.js';
import { isMewvoServer } from '../../utils/ownerPower.js';
import { isAdministrator } from './enforcementService.js';

/** What the Moderator role may run in the Discord panel (other servers only). */
export const MODERATOR_PANEL_ACTIONS = Object.freeze(['warn', 'mute', 'kick', 'unmute', 'removewarn']);
export const ALL_PANEL_ACTIONS = Object.freeze(['ban', 'kick', 'mute', 'warn', 'unban', 'unmute', 'removewarn']);

/**
 * The guild-config read may not eat the 3-second answer window: Unmute/Unban open a form after
 * this read plus a user fetch of up to 1200 ms (enforcementPanel.js), under the 2600 ms fallback.
 */
export const MODERATOR_ROLE_READ_BUDGET_MS = 1000;

const NONE = Object.freeze({ level: null, reason: 'none', roleId: null, actions: Object.freeze([]) });

function withinBudget(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`moderator role read took longer than ${ms} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The panel access of `member` in `guildId`:
 *   { level: 'admin', actions: every action }
 *   { level: 'moderator', roleId, actions: MODERATOR_PANEL_ACTIONS }   (other servers only)
 *   { level: null, reason: 'none' | 'unavailable' }                     (refused)
 * `loadConfig`, `isHome`, `budgetMs` are injectable for tests.
 */
export async function panelAccessFor(member, guildId, {
    client = null, loadConfig = getGuildConfig, isHome = isMewvoServer, budgetMs = MODERATOR_ROLE_READ_BUDGET_MS,
} = {}) {
    if (!member || !guildId) return NONE;
    if (isAdministrator(member)) return { level: 'admin', reason: null, roleId: null, actions: ALL_PANEL_ACTIONS };
    // Mewvo's own servers: Administrator only, as before (no config read at all).
    if (isHome(String(guildId))) return NONE;
    let config;
    try {
        config = await withinBudget(Promise.resolve().then(() => loadConfig(client, guildId)), budgetMs);
    } catch {
        return { ...NONE, reason: 'unavailable' };
    }
    if (!memberHasConfiguredModeratorRole(member, config)) return NONE;
    const role = config.modRole;
    return { level: 'moderator', reason: null, roleId: typeof role === 'string' ? role : role?.id || null, actions: MODERATOR_PANEL_ACTIONS };
}

/** True when this access may run `action` (null = only opening/cancelling the panel). */
export function panelActionAllowed(access, action = null) {
    if (!access?.level) return false;
    if (!action) return true;
    return access.actions.includes(action);
}

/** What executeAction needs for a moderator (it re-checks the role and the action type itself). */
export function staffRoleFor(access) {
    return access?.level === 'moderator' && access.roleId ? { roleId: access.roleId, actions: [...MODERATOR_PANEL_ACTIONS] } : null;
}

/**
 * The refusal text key for a refused access. `forWarn`: the "Warn for this message" wording.
 * `closed`: a panel component (the panel was already open).
 */
export function refusalKey(access, guildId, { isHome = isMewvoServer, forWarn = false, closed = false } = {}) {
    if (access?.reason === 'unavailable') return 'staff.enforcements.accessUnavailable';
    const home = isHome(String(guildId || ''));
    if (closed) return home ? 'errors.panel.noAdmin' : 'errors.panel.noAccess';
    if (forWarn) return home ? 'staff.warnmessage.noAdmin' : 'staff.warnmessage.noAdminOrMod';
    return home ? 'staff.enforcements.noAdmin' : 'staff.enforcements.noAdminOrMod';
}
