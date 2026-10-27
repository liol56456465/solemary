// cannedService.js — saved answers staff can post with one command (/canned send).
// A few built-in answers are always there; admins add their own per server.

import { db } from '../utils/database/wrapper.js';

export const CANNED_NAME = /^[a-z0-9-]{1,32}$/;
export const CANNED_MAX_LENGTH = 1800;

const BUILT_IN = {
    'appeal-received': 'Thanks for your appeal. The administrators will review it and you will get the decision by DM. Please don\'t open another appeal for the same case in the meantime.',
    'need-proof': 'Could you send screenshots or other proof? Please post them here.',
    'closing-soon': 'If there\'s nothing else, this conversation will be closed soon. You can always start a new one.',
};

const key = (guildId) => `guild:${guildId}:canned`;

/** All answers for a guild: built-in ones, overridden by the guild's own. */
export async function listCanned(guildId) {
    const own = await db.get(key(guildId), {});
    return { ...BUILT_IN, ...(own && typeof own === 'object' ? own : {}) };
}

export async function getCanned(guildId, name) {
    return (await listCanned(guildId))[name] ?? null;
}

export function isBuiltInCanned(name) {
    return Object.hasOwn(BUILT_IN, name);
}

export async function saveCanned(guildId, name, text) {
    await db.update(key(guildId), (own) => ({ ...(own ?? {}), [name]: text }), {});
}

/** Removes a guild's own answer; returns false when there was none (built-ins can't be removed). */
export async function removeCanned(guildId, name) {
    let removed = false;
    await db.update(key(guildId), (own) => {
        const next = { ...(own ?? {}) };
        removed = Object.hasOwn(next, name);
        delete next[name];
        return next;
    }, {});
    return removed;
}
