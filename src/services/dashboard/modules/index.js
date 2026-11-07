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
import channels from './channels.js';
import rules from './rules.js';
import appearance from './appearance.js';

export const MODULES = [
    enforcement, automod, logging, welcome, tickets, leveling, verification, reactionRoles, messages, giveaways, birthdays,
    counters, joinToCreate, applications, community, commands, support, channels, rules, appearance,
];

const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function getModule(key) {
    return BY_KEY.get(key) || null;
}

/** { run, admin, upload, confirm } for an action of a module, or null. Plain functions are open to every editor. */
export function getAction(module, name) {
    if (!module?.actions || !Object.hasOwn(module.actions, name)) return null;
    const action = module.actions[name];
    if (typeof action === 'function') return { run: action, admin: false, upload: false, confirm: null };
    // upload: the form sends one image as multipart/form-data (routes.js moduleUploadBody).
    // confirm(ctx, form): checks the form and describes what will happen ({ heading, rows, submit });
    // the first POST then shows a confirm page and only its one-time token runs the action (routes.js).
    if (action && typeof action.run === 'function') {
        return { run: action.run, admin: Boolean(action.admin), upload: Boolean(action.upload), confirm: typeof action.confirm === 'function' ? action.confirm : null };
    }
    return null;
}
