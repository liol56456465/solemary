// homeOnly.js — dashboard pages that exist only in Mewvo's own (home) servers for now
// (multi-server B3, docs/multi-server-b3.md section 4). In any other server the sidebar hides
// them and the router answers 404, like any page that does not exist there.
//
//   support  the Support server module (banned role, ban-appeals category: Mewvo's own support server)
//   backup   the Settings backup page (settingsBackup.js backs up only the home rows)
//
// The Owner area (/dashboard/owner/*) is global (OWNER_IDS), never under a server. Single
// settings that are home-only (premium roles, transparency report, trust card, the support
// invite) are marked `homeOnly` in the settings registry (settingsRegistry.js), not here.

/** Sidebar keys / first path segments of the home-only pages. */
export const HOME_ONLY_PAGES = Object.freeze(['support', 'backup']);

/**
 * True for a home-only page: a sidebar key ('support'), a route key ('page:support') or a
 * path below the server ('/support', '/support/save', '/backup/download').
 */
export function isHomeOnlyPage(key) {
    const text = typeof key === 'string' ? key.trim() : '';
    if (!text) return false;
    const name = text.startsWith('page:') ? text.slice(5) : text.replace(/^\/+/, '').split(/[/?]/)[0];
    return HOME_ONLY_PAGES.includes(name.toLowerCase());
}
