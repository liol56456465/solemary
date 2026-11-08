// cannedService.js — saved answers staff can post with one command (/canned send).
// A few built-in answers are always there; admins add their own per server.

import { db } from '../utils/database/wrapper.js';
import { botText } from '../utils/botText.js';

export const CANNED_NAME = /^[a-z0-9-]{1,32}$/;
export const CANNED_MAX_LENGTH = 1800;

// Built-in answers: the bot's own text, so in the language asked for (catalog
// src/content/bot/<lang>/ticket.json). A server's own answers stay as written.
const BUILT_IN_KEYS = {
    'appeal-received': 'ticket.canned.builtInAppealReceived',
    'need-proof': 'ticket.canned.builtInNeedProof',
    'closing-soon': 'ticket.canned.builtInClosingSoon',
};

function builtIn(lang) {
    const tr = botText(lang);
    return Object.fromEntries(Object.entries(BUILT_IN_KEYS).map(([name, textKey]) => [name, tr.t(textKey)]));
}

const key = (guildId) => `guild:${guildId}:canned`;

/** All answers for a guild: built-in ones (in `lang`, default English), overridden by the guild's own. */
export async function listCanned(guildId, { lang = 'en' } = {}) {
    const own = await db.get(key(guildId), {});
    return { ...builtIn(lang), ...(own && typeof own === 'object' ? own : {}) };
}

export async function getCanned(guildId, name, { lang = 'en' } = {}) {
    return (await listCanned(guildId, { lang }))[name] ?? null;
}

export function isBuiltInCanned(name) {
    return Object.hasOwn(BUILT_IN_KEYS, name);
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
