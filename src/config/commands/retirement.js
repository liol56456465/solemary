/**
 * Retiring admin commands (owner decision, 2026-10-28): with RETIRE_ADMIN_COMMANDS=true the bot
 * registers only what everyone may use (EVERYONE_COMMANDS) plus a small owner-only emergency
 * kit, for when the dashboard is unreachable. Everything else is done on the dashboard.
 *
 * - Registration (commandLoader): admin subcommands are stripped from mixed commands, admin-only
 *   commands and context menus are not registered at all.
 * - Access (commandGate): a retired key answers with the dashboard page that replaces it (prefix
 *   commands and stale clients still reach the gate); the emergency kit works for OWNER_IDS only.
 * Off (default), nothing changes. Flip back by unsetting the variable and restarting.
 */

import { EVERYONE_COMMANDS } from './commandAccess.js';

/** Owner-only emergency kit: moderation and recovery that must work when the website is down. */
export const OWNER_KIT = new Set([
    'enforcements', 'automod panic', 'automod lockdown-end', 'staff restore',
    'backup status', 'backup restore', 'backup snapshot', 'backup snapshots', 'backup diff', 'backup revert', 'backup rebuild',
]);

/** Where each retired command lives on the dashboard (by command name; a few subcommands differ). */
const DASHBOARD_PAGE = {
    automod: 'automod', appeals: 'appeals', background: 'users', case: 'cases', enforcements: 'users', Moderate: 'users',
    'Warn for this message': 'users', setappeal: 'enforcement', staff: 'staff', test: 'enforcement',
    'app-admin': 'applications', community: 'community', suggest: 'community', tag: 'community', commands: 'commands',
    configwizard: 'commands', birthday: 'birthdays', count: 'counters', serverstats: 'counters', giveaway: 'giveaways',
    jointocreate: 'join-to-create', level: 'leveling', logging: 'logging', report: 'logging', lock: 'channels', unlock: 'channels',
    purge: 'channels', backup: 'overview', reactroles: 'reaction-roles', ticket: 'tickets', canned: 'tickets', modmail: 'tickets',
    tools: 'giveaways', shorten: 'commands', countdown: 'messages', poll: 'messages', embedbuilder: 'messages',
    verification: 'verification', welcome: 'welcome', goodbye: 'welcome', greet: 'welcome', autorole: 'welcome',
    wipedata: 'overview',
};

export function adminCommandsRetired(env = process.env) {
    return /^(1|true|yes|on)$/i.test(String(env.RETIRE_ADMIN_COMMANDS || '').trim());
}

export function isOwnerKit(accessKey) {
    return Boolean(accessKey) && OWNER_KIT.has(accessKey);
}

/** The dashboard page that replaces this access key ("automod mode" → /dashboard/automod). */
export function dashboardPageFor(accessKey) {
    const name = String(accessKey || '').split(' ')[0];
    return DASHBOARD_PAGE[accessKey] || DASHBOARD_PAGE[name] || 'overview';
}

/** What a retired command answers: where it moved. */
export function retiredMessage(accessKey, publicUrl = process.env.PUBLIC_URL || '') {
    const base = String(publicUrl).trim().replace(/\/+$/, '');
    const page = dashboardPageFor(accessKey);
    return base
        ? `This command moved to the dashboard: ${base}/dashboard/${page}`
        : `This command moved to the dashboard (${page} page).`;
}

/** True when this key stays registered while retired: everyone-commands and the owner kit. */
function keepKey(key) {
    return EVERYONE_COMMANDS.has(key) || OWNER_KIT.has(key);
}

/**
 * The command JSON to register while retired, or null to leave it out: admin subcommands (and
 * empty groups) are removed; a command without subcommands stays only when its key is kept.
 */
export function retireCommandJson(json) {
    const options = Array.isArray(json.options) ? json.options : [];
    const subs = options.filter((o) => o.type === 1 || o.type === 2);
    if (!subs.length) return keepKey(json.name) ? json : null;
    const kept = [];
    for (const option of options) {
        if (option.type === 1) {
            if (keepKey(`${json.name} ${option.name}`)) kept.push(option);
        } else if (option.type === 2) {
            const inner = (option.options || []).filter((sub) => keepKey(`${json.name} ${option.name} ${sub.name}`));
            if (inner.length) kept.push({ ...option, options: inner });
        } else {
            kept.push(option);
        }
    }
    return kept.some((o) => o.type === 1 || o.type === 2) ? { ...json, options: kept } : null;
}

/**
 * Every access key the loaded commands have (commands without subcommands, each subcommand,
 * each grouped subcommand, context menus), once each, sorted: { key, description, access, page }.
 * access: 'everyone' | 'owner kit' | 'admin'; page: the dashboard page for admin ones.
 */
export function commandEntries(commands) {
    const byKey = new Map();
    const add = (key, description) => {
        if (byKey.has(key)) return;
        const access = EVERYONE_COMMANDS.has(key) ? 'everyone' : OWNER_KIT.has(key) ? 'owner kit' : 'admin';
        byKey.set(key, { key, description: description || '', access, page: access === 'everyone' ? null : dashboardPageFor(key) });
    };
    for (const command of commands?.values?.() || []) {
        const json = typeof command?.data?.toJSON === 'function' ? command.data.toJSON() : null;
        if (!json?.name) continue;
        const menu = json.type === 2 || json.type === 3;
        const subs = (json.options || []).filter((o) => o.type === 1 || o.type === 2);
        if (menu || !subs.length) {
            add(json.name, json.description || (menu ? 'Right-click menu' : ''));
            continue;
        }
        for (const option of subs) {
            if (option.type === 1) add(`${json.name} ${option.name}`, option.description);
            else for (const sub of option.options || []) add(`${json.name} ${option.name} ${sub.name}`, sub.description);
        }
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}
