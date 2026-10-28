// permissions.js — the dashboard's staff access levels: ONE table for every page and action.
//
// Levels (access.js decides which one a user has, re-checked on every request):
//   admin      Administrator in the main server: everything (unchanged).
//   owner      OWNER_IDS without Administrator: view + settings (unchanged; enforcement
//              actions still refused by canAct downstream). The table does not restrict them.
//   moderator  a member with the configured moderator role (the Commands page "Moderator
//              role", guild config `modRole`): only the entries marked MODERATOR below.
//
// Every route (routes.js registerDashboard) maps to a key with ROUTES; requireUser refuses a
// moderator with 403 when the key is not MODERATOR. Unknown keys, unknown paths and new pages
// default to Administrator-only. The sidebar (html.js navGroups) filters with the same table.
// The Owner area (/owner/…) is not in the table: ownerRoutes.js requireOwner keeps it
// OWNER_IDS only (404 for everyone else).

export const ADMIN = 'admin';
export const MODERATOR = 'moderator';
/** Route key for the Owner area: skipped here, checked by requireOwner. */
export const OWNER_AREA = 'owner-area';

/** Who may use what. Value = the lowest level allowed. Not listed → ADMIN. */
export const PERMISSIONS = Object.freeze({
    // ── Pages (GET; every sidebar entry has one) ──
    'page:overview': MODERATOR,
    'page:users': MODERATOR, // Members list and member pages
    'page:bans': MODERATOR,
    'page:cases': MODERATOR, // list and case pages (view only)
    'page:appeals': MODERATOR, // list and dossiers (view only)
    'page:nocontact': MODERATOR, // view only
    'page:staff': ADMIN,
    'page:channels': ADMIN,
    'page:tickets': ADMIN,
    'page:welcome': ADMIN,
    'page:leveling': ADMIN,
    'page:reaction-roles': ADMIN,
    'page:messages': ADMIN,
    'page:giveaways': ADMIN,
    'page:birthdays': ADMIN,
    'page:applications': ADMIN,
    'page:community': ADMIN,
    'page:join-to-create': ADMIN,
    'page:automod': ADMIN,
    'page:enforcement': ADMIN,
    'page:logging': ADMIN,
    'page:verification': ADMIN,
    'page:counters': ADMIN,
    'page:support': ADMIN,
    'page:modules': ADMIN,
    'page:commands': ADMIN,
    'page:audit': ADMIN,
    // ── Enforcement actions on one member (the type of /users/:id/action/*) ──
    'action:warn': MODERATOR,
    'action:mute': MODERATOR,
    'action:unmute': MODERATOR,
    'action:kick': MODERATOR,
    'action:ban': ADMIN,
    'action:unban': ADMIN,
    'action:removewarn': ADMIN,
    // ── Other member changes ──
    'member.action': MODERATOR, // the preview/execute routes; the type is checked with action:<type>
    'member.timeout': MODERATOR,
    'member.roles': ADMIN,
    'member.nickname': ADMIN,
    'member.unverify': ADMIN,
    'member.notes': ADMIN,
    'member.bulk': ADMIN,
    // ── Records ──
    'case.edit': ADMIN, // edit / void
    'case.evidence': ADMIN,
    'appeal.decide': ADMIN,
    'nocontact.edit': ADMIN,
    'staff.manage': ADMIN, // mass-action blocks, staff warnings, restore (OWNER_IDS checked on top)
    'settings.edit': ADMIN, // every module settings form
    // ── Session ──
    'session.logout': MODERATOR,
});

/**
 * Every dashboard route behind requireUser → its key. [method, pattern, key]; first match
 * wins (order matters like Express), `:x` is one path segment, `*` the rest. A pattern with a
 * function key computes it from the params (the settings catch-alls).
 */
export const ROUTES = [
    ['POST', '/logout', 'session.logout'],
    ['POST', '/users/bulk/preview', 'member.bulk'],
    ['POST', '/users/bulk/execute', 'member.bulk'],
    ['POST', '/users/:id/action/preview', 'member.action'],
    ['POST', '/users/:id/action/execute', 'member.action'],
    ['POST', '/users/:id/roles/add', 'member.roles'],
    ['POST', '/users/:id/roles/remove', 'member.roles'],
    ['POST', '/users/:id/nickname', 'member.nickname'],
    ['POST', '/users/:id/timeout', 'member.timeout'],
    ['POST', '/users/:id/unverify', 'member.unverify'],
    ['POST', '/users/:id/notes/add', 'member.notes'],
    ['POST', '/users/:id/notes/remove', 'member.notes'],
    ['POST', '/cases/:code/edit', 'case.edit'],
    ['POST', '/cases/:code/void', 'case.edit'],
    ['POST', '/cases/:code/evidence/add', 'case.evidence'],
    ['POST', '/cases/:code/evidence/upload', 'case.evidence'],
    ['POST', '/cases/:code/evidence/remove', 'case.evidence'],
    ['POST', '/appeals/:code/preview', 'appeal.decide'],
    ['POST', '/appeals/:code/decide', 'appeal.decide'],
    ['POST', '/nocontact/add', 'nocontact.edit'],
    ['POST', '/nocontact/end', 'nocontact.edit'],
    ['POST', '/staff/blocks/lift', 'staff.manage'],
    ['POST', '/staff/warn', 'staff.manage'],
    ['POST', '/staff/restore', 'staff.manage'],
    ['*', '/owner', OWNER_AREA],
    ['*', '/owner/*', OWNER_AREA],
    ['POST', '/:module/:action', 'settings.edit'],
    ['GET', '/overview', 'page:overview'],
    ['GET', '/modules', 'page:modules'],
    ['GET', '/cases', 'page:cases'],
    ['GET', '/cases/:code', 'page:cases'],
    ['GET', '/appeals', 'page:appeals'],
    ['GET', '/appeals/:code', 'page:appeals'],
    ['GET', '/users', 'page:users'],
    ['GET', '/bans', 'page:bans'],
    ['GET', '/users/bulk/:job', 'member.bulk'],
    ['GET', '/users/:id', 'page:users'],
    ['GET', '/nocontact', 'page:nocontact'],
    ['GET', '/staff', 'page:staff'],
    ['GET', '/audit', 'page:audit'],
    ['GET', '/:module', (params) => `page:${params.module}`],
];

const compiled = ROUTES.map(([method, pattern, key]) => {
    const names = [];
    const source = pattern.split('/').map((part) => {
        if (part === '*') return '.*';
        if (part.startsWith(':')) {
            names.push(part.slice(1));
            return '([^/]+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return { method, pattern, key, names, regex: new RegExp(`^${source}/?$`) };
});

/** The key of a request (method + path below /dashboard), or null for an unknown path (→ ADMIN). */
export function routeKey(method, path) {
    const m = String(method || 'GET').toUpperCase() === 'HEAD' ? 'GET' : String(method || 'GET').toUpperCase();
    const p = typeof path === 'string' && path ? path : '/';
    for (const route of compiled) {
        if (route.method !== '*' && route.method !== m) continue;
        const match = route.regex.exec(p);
        if (!match) continue;
        if (typeof route.key !== 'function') return route.key;
        const params = Object.fromEntries(route.names.map((name, i) => [name, match[i + 1]]));
        return route.key(params);
    }
    return null;
}

/** The lowest level for a key; anything unknown is Administrator-only. */
export function requiredLevel(key) {
    return typeof key === 'string' && Object.hasOwn(PERMISSIONS, key) ? PERMISSIONS[key] : ADMIN;
}

/**
 * May this access decision (access.js) use `key`? Administrators and bot owners are not
 * restricted by the table (their existing checks apply as before); moderators only where the
 * table says MODERATOR; anyone else never.
 */
export function allows(decision, key) {
    if (!decision?.allowed) return false;
    if (decision.role === 'admin' || decision.role === 'owner') return true;
    if (decision.role === MODERATOR) return requiredLevel(key) === MODERATOR;
    return false;
}

/** May this decision RUN `key` (a POST)? Admins yes; moderators per the table; owners no (canAct). */
export function mayRun(decision, key) {
    if (decision?.canAct) return true;
    return decision?.role === MODERATOR && requiredLevel(key) === MODERATOR;
}

/** The enforcement flow types a moderator may run (for the service's own check). */
export function moderatorActionTypes() {
    return Object.keys(PERMISSIONS).filter((key) => key.startsWith('action:') && PERMISSIONS[key] === MODERATOR).map((key) => key.slice(7));
}

/** The level shown in the account menu. */
export function levelLabel(decision) {
    if (decision?.role === MODERATOR) return 'Moderator';
    if (decision && !decision.canAct) return 'View and settings (bot owner)';
    return 'Administrator';
}
