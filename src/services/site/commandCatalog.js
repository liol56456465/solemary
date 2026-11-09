// commandCatalog.js — the data of the website's command explorer (/commands, pages/commands.js),
// built from the loaded commands so it never goes stale: every access key commandEntries() lists
// (owner tools such as /database are already left out there), with its own Discord description in
// the page's language (the command files' description_localizations, commandLocalizations.js),
// its options, who may run it and the dashboard page that replaces it.
//
// Only data is cached here (per language). Page text (labels, placeholders, hand-written examples)
// comes from the site catalog at render time, so the owner's Website edits show at once.
// The commands load after the web server starts (site.js), so the first build happens on the first
// request that finds client.commands filled; it is rebuilt when the command map or its size changes
// and when invalidateCommandCatalog() is called (commandLoader.js reloadCommand).
//
// Never holds ids: no OWNER_IDS, server or channel ids are read here, only command JSON.

import { EVERYONE_COMMANDS, MANAGE_SERVER_COMMANDS } from '../../config/commands/commandAccess.js';
import { KEPT_ADMIN_COMMANDS, OWNER_KIT, commandEntries, dashboardPageFor } from '../../config/commands/retirement.js';
import { DISCORD_LOCALES } from '../../utils/commandLocalizations.js';

/** Access tiers, most open first (the ?who= values). */
export const ACCESS_TIERS = Object.freeze(['everyone', 'manage', 'admin', 'ownerkit']);

// Command folders in page order (everyone-heavy first); right-click menus get their own group.
// Owner → "Recovery" (owner decision O5): /backup lives there (/database is never listed).
const CATEGORY_ORDER = [
    'Core', 'Community', 'Leveling', 'Fun', 'Birthday', 'Utility', 'Tools', 'Search', 'Verification', 'Ticket',
    'Enforcement', 'Moderation', 'Logging', 'Welcome', 'Giveaway', 'Reaction_roles', 'ServerStats', 'JoinToCreate', 'Menus', 'Owner',
];
/**
 * The group key of a command folder ("Reaction_roles" → "reaction-roles", "Owner" → "recovery").
 * Case-insensitive: a module's own `category: 'moderation'` lands in the Moderation group too.
 */
export function groupKey(category) {
    const name = String(category || 'Other').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
    return name === 'owner' ? 'recovery' : name;
}
const GROUP_ORDER = CATEGORY_ORDER.map(groupKey);
/** Group keys with a catalog label (pages.commands.groups.<key>); any other folder shows its own name. */
export const LABELLED_GROUPS = Object.freeze([...CATEGORY_ORDER.map(groupKey), 'other']);

// Everyone-commands that narrow access inside the command (commandAccess.js header comment): the note's catalog key.
export const NARROWED = Object.freeze({
    claim: 'ticketStaff', priority: 'ticketStaff', 'modmail close': 'ticketStaff',
    'canned send': 'ticketStaff', 'canned list': 'ticketStaff', close: 'ticketStaffOrOpener',
});

/** "todo share view" → "todo-share-view", "Report message" → "report-message". */
export function commandSlug(key) {
    return String(key).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The access tier of an access key: everyone, manage (Manage Server or Administrator), ownerkit, else admin. */
export function accessTier(key) {
    if (EVERYONE_COMMANDS.has(key)) return 'everyone';
    if (MANAGE_SERVER_COMMANDS.has(key)) return 'manage';
    if (OWNER_KIT.has(key)) return 'ownerkit';
    return 'admin';
}

/** The text for our language from a Discord JSON node: its localization, else the English text. */
function localizedText(text, localizations, lang) {
    if (lang === 'en' || !localizations) return text || '';
    const locale = (DISCORD_LOCALES[lang] || [])[0];
    return (locale && localizations[locale]) || text || '';
}

/** The subcommand node (or the command itself) of an access key in a command's JSON. */
function nodeFor(json, key) {
    const parts = key.split(' ').slice(1);
    let node = json;
    for (const part of parts) {
        node = (node?.options || []).find((o) => (o.type === 1 || o.type === 2) && o.name === part);
        if (!node) return null;
    }
    return node;
}

function optionsOf(node, lang) {
    return (node?.options || [])
        .filter((o) => o.type !== 1 && o.type !== 2)
        .map((o) => ({
            name: o.name,
            type: o.type,
            required: o.required === true,
            description: localizedText(o.description, o.description_localizations, lang),
            choices: (o.choices || []).map((c) => localizedText(c.name, c.name_localizations, lang)),
        }));
}

/**
 * The generated example's options: every required option, or the first option when none is required.
 * value: a choice name (data) or null (the page fills in a placeholder for the type).
 */
function exampleOptions(options) {
    const picked = options.some((o) => o.required) ? options.filter((o) => o.required) : options.slice(0, 1);
    return picked.map((o) => ({ name: o.name, type: o.type, value: o.choices.length ? o.choices[0] : null }));
}

/**
 * Pure: the explorer entries for one language, in page order (group, then key).
 * { slug, key, group, category, access, page, menu, note, description, options, example, search }
 * - page: the dashboard page for commands that have one (not the everyone-commands, /test, /setup)
 * - menu: 'message' | 'member' for right-click menus, else null
 * - search: lower-case text the filter matches (key, option names, descriptions in this language and English)
 */
export function buildCommandCatalog(commands, lang = 'en') {
    const out = [];
    const seen = new Set();
    for (const [, command] of commands?.entries?.() || []) {
        if (command?.scope === 'owner') continue;
        const json = typeof command?.data?.toJSON === 'function' ? command.data.toJSON() : null;
        if (!json?.name) continue;
        const menu = json.type === 3 ? 'message' : json.type === 2 ? 'member' : null;
        const category = menu ? 'Menus' : (command.category || 'Other');
        for (const entry of commandEntries(new Map([[json.name, command]]))) {
            if (seen.has(entry.key)) continue;
            seen.add(entry.key);
            const node = menu ? json : nodeFor(json, entry.key);
            const access = accessTier(entry.key);
            const options = menu ? [] : optionsOf(node, lang);
            const description = menu ? '' : localizedText(node?.description, node?.description_localizations, lang);
            const english = menu ? '' : (node?.description || '');
            const hasPage = access !== 'everyone' && access !== 'manage' && !KEPT_ADMIN_COMMANDS.has(entry.key);
            out.push({
                slug: commandSlug(entry.key),
                key: entry.key,
                group: groupKey(category),
                category,
                access,
                page: hasPage ? dashboardPageFor(entry.key) : null,
                menu,
                note: NARROWED[entry.key] || null,
                description,
                options,
                example: menu ? null : exampleOptions(options),
                search: [entry.key, ...options.map((o) => o.name), description, english].join(' ').toLowerCase(),
            });
        }
    }
    const rank = (g) => { const i = GROUP_ORDER.indexOf(g); return i === -1 ? GROUP_ORDER.length : i; };
    return out.sort((a, b) => rank(a.group) - rank(b.group) || a.group.localeCompare(b.group) || a.key.localeCompare(b.key));
}

// ── Cache ─────────────────────────────────────────────────────────────────

let cache = new Map();
let cachedFor = null;
let cachedSize = -1;

/** Drops the cached entries (a command was reloaded): the next request rebuilds them. */
export function invalidateCommandCatalog() {
    cache = new Map();
    cachedFor = null;
    cachedSize = -1;
}

/** The cached entries for `lang`; [] while the commands are not loaded yet (nothing is cached then). */
export function commandCatalog(commands, lang = 'en') {
    const size = commands?.size ?? 0;
    if (!size) return [];
    if (commands !== cachedFor || size !== cachedSize) {
        cache = new Map();
        cachedFor = commands;
        cachedSize = size;
    }
    if (!cache.has(lang)) cache.set(lang, Object.freeze(buildCommandCatalog(commands, lang)));
    return cache.get(lang);
}
