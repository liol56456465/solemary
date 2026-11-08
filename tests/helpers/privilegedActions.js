// privilegedActions.js — shared by tests/dashboardModulesB3.test.js (action code) and
// tests/dashboardModules.test.js (rendered role pickers): which dashboard module actions may
// save a role, permission, staff/mod list or safety setting without being admin: true.
//
// Every such action must be Administrator-only, so a Manage Server manager cannot raise their
// own access (multi-server B3, owner decision 1). A new action that matches PRIVILEGE_PATTERN
// needs admin: true, a field-level requireCanAct (FIELD_LEVEL) or an entry in NOT_PRIVILEGED
// with the reason it grants nothing.

export const PRIVILEGE_PATTERN = /roleField|autoRoleField|\broleIds?\b|modRole|staffRole|managerRole|bannedRole|mutedRole|warnRole|trusted|massAction|massMute|independentAppealReview|Permission|permissionOverwrites|lockChannel|unlockChannel|purge|setAutomodEnabled|setStaffGuard|staffGuard|updateIgnoreList/;

/** Admin only for one field of a mixed form (403 from modules/serverScope.js requireCanAct). */
export const FIELD_LEVEL = new Set(['automod/enabled', 'birthdays/settings', 'tickets/settings']);

/** Matches the pattern but grants nothing. */
export const NOT_PRIVILEGED = new Map([
    ['leveling/boost-add', 'XP multiplier for members with a role'],
    ['leveling/boost-remove', 'XP multiplier for members with a role'],
    ['leveling/ignore-add', 'no XP for members with a role'],
    ['leveling/ignore-remove', 'no XP for members with a role'],
    ['logging/ignore-remove', 'logs a channel, role or member again (only makes logging stricter)'],
]);

/**
 * The only module actions a viewer without Administrator (Manage Server manager, OWNER_IDS at
 * home without it) may run: `manager: true` (modules/serverScope.js managerActions). Every
 * other action is Administrator-only by default (routes.js moduleAction). Adding an action here
 * is a decision: it must be a plainly harmless community setting (no role, permission, staff
 * list, safety or logging setting, no channel the bot posts manager-written text into, no
 * command switch that could lock admins out).
 */
export const MANAGER_ACTIONS = new Set([
    'welcome/welcome-enabled', 'welcome/goodbye-enabled', 'welcome/welcome', 'welcome/goodbye',
    'tickets/canned-add', 'tickets/canned-remove',
    'leveling/enabled', 'leveling/settings', 'leveling/card',
    'birthdays/settings', 'birthdays/off', // the birthday role inside settings: requireCanAct (FIELD_LEVEL)
    'counters/counter-type', 'counters/counter-delete', 'counters/counting-setup', 'counters/counting-reset', 'counters/counting-off',
    'join-to-create/trigger', 'join-to-create/trigger-remove',
    'community/suggestions', 'community/starboard', 'community/starboard-off',
    'bot-language/language',
]);
