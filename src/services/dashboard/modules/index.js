// index.js — the dashboard's module (settings) pages, in sidebar order.

import enforcement from './enforcement.js';
import automod from './automod.js';
import logging from './logging.js';
import welcome from './welcome.js';
import tickets from './tickets.js';
import leveling from './leveling.js';
import verification from './verification.js';
import reactionRoles from './reactionRoles.js';
import giveaways from './giveaways.js';
import messages from './messages.js';
import birthdays from './birthdays.js';
import counters from './counters.js';
import joinToCreate from './joinToCreate.js';
import applications from './applications.js';
import community from './community.js';
import commands from './commands.js';
import support from './support.js';

export const MODULES = [
    enforcement, automod, logging, welcome, tickets, leveling, verification, reactionRoles, messages, giveaways, birthdays,
    counters, joinToCreate, applications, community, commands, support,
];

const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function getModule(key) {
    return BY_KEY.get(key) || null;
}

/** { run, admin } for an action of a module, or null. Plain functions are open to every editor. */
export function getAction(module, name) {
    if (!module?.actions || !Object.hasOwn(module.actions, name)) return null;
    const action = module.actions[name];
    if (typeof action === 'function') return { run: action, admin: false };
    if (action && typeof action.run === 'function') return { run: action.run, admin: Boolean(action.admin) };
    return null;
}
