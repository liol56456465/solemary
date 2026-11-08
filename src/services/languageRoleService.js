// languageRoleService.js — language roles: a member picks a language through a role
// (setting languageRoles, Dashboard → Bot language), and resolveBotLanguage
// (utils/botText.js) uses it first for messages meant for that member.
//
// The switch (/language set, the panel buttons) gives the chosen role and removes the member's
// other language roles. Everything is checked before the first role change: the bot's Manage
// Roles, each role exists, is not managed, carries no staff permission (anyone can pick it) and
// is below the bot's highest role. Errors are LanguageRoleError with a `code` the callers turn
// into text (language.json `language.error.<code>`).
//
// Custom IDs: langrole:set:<code> (persistent panel button), langrole:pick:<userId> (the select
// of /language set, ephemeral).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, StringSelectMenuBuilder } from 'discord.js';
import { LANGUAGES, LANG_CODES } from './site/i18n.js';
import { resolveSetting } from './settings/guildSettings.js';
import { getDangerousPermissions } from '../utils/roleSafety.js';
import { LANGUAGE_ROLES_KEY } from '../utils/botText.js';

export const LANGUAGE_ROLE_PREFIX = 'langrole';
export const NO_MENTIONS = Object.freeze({ parse: [] });

/** The language's own name ("Deutsch", "Português (Brasil)"): flag-free labels. */
export function nativeLanguageName(code) {
    return LANGUAGES.find((l) => l.code === code)?.name || code;
}

export class LanguageRoleError extends Error {
    constructor(code, params = {}) {
        super(`language role: ${code}`);
        this.code = code;
        this.params = params;
    }
}

/**
 * The server's language roles { code: roleId } (only set ones). Throws LanguageRoleError
 * 'dbDown' when the settings cannot be read: a role change must not run on a guess.
 */
export function languageRolesFor(guildId, { resolve = resolveSetting } = {}) {
    let map;
    try {
        map = resolve(String(guildId), LANGUAGE_ROLES_KEY);
    } catch {
        throw new LanguageRoleError('dbDown');
    }
    const out = {};
    for (const code of LANG_CODES) {
        if (map && typeof map === 'object' && map[code]) out[code] = String(map[code]);
    }
    return out;
}

/** The languages that have a role, in the fixed order. */
export function offeredLanguages(map) {
    return LANG_CODES.filter((code) => Boolean(map?.[code]));
}

const hasRole = (member, roleId) => Boolean(member?.roles?.cache?.has?.(roleId));

/** Why the bot cannot give or remove this role ('add' also refuses staff permissions), or null. */
function roleProblem(role, me, { add }) {
    if (role.managed) return new LanguageRoleError('managed', { role: role.name });
    if (add && getDangerousPermissions(role).length) return new LanguageRoleError('dangerous', { role: role.name });
    const highest = me?.roles?.highest;
    if (!highest || role.position >= highest.position) return new LanguageRoleError('hierarchy', { role: role.name });
    return null;
}

/**
 * Gives `member` the role of `lang` and removes their other language roles.
 * Returns { lang, added: boolean, removed: string[] } ({ added: false, removed: [] } = already set).
 * Throws LanguageRoleError (nothing changed) for every problem found by the checks.
 */
export async function switchLanguageRole({ guild, member, lang, map, reason = 'Language picked by the member' }) {
    if (!LANG_CODES.includes(lang)) throw new LanguageRoleError('unknown');
    if (!map?.[lang]) throw new LanguageRoleError('notOffered', { language: nativeLanguageName(lang) });
    if (!member?.roles?.cache) throw new LanguageRoleError('memberMissing');
    const me = guild?.members?.me;
    if (!me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) throw new LanguageRoleError('noManageRoles');

    const chosen = guild.roles.cache.get(map[lang]);
    if (!chosen) throw new LanguageRoleError('roleMissing', { language: nativeLanguageName(lang) });
    const others = offeredLanguages(map)
        .filter((code) => code !== lang && map[code] !== map[lang] && hasRole(member, map[code]))
        .map((code) => guild.roles.cache.get(map[code]))
        .filter(Boolean);
    const add = !hasRole(member, chosen.id);
    if (!add && !others.length) return { lang, added: false, removed: [] };

    const problem = (add ? roleProblem(chosen, me, { add: true }) : null)
        || others.map((role) => roleProblem(role, me, { add: false })).find(Boolean);
    if (problem) throw problem;

    try {
        // Add first: if the removal then fails, the member keeps the new language
        // (resolveBotLanguage picks one by the fixed order) instead of having none.
        if (add) await member.roles.add(chosen.id, reason);
        if (others.length) await member.roles.remove(others.map((role) => role.id), reason);
    } catch (error) {
        throw Object.assign(new LanguageRoleError('failed'), { cause: error });
    }
    return { lang, added: add, removed: others.map((role) => role.id) };
}

/** The text of a LanguageRoleError (or the generic failure) in a translator. */
export function languageErrorText(tr, error) {
    const code = error instanceof LanguageRoleError ? error.code : 'failed';
    return tr.t(`language.error.${code}`, error?.params || {});
}

/** The select of /language set (only the languages with a role). */
export function languagePickerRow(tr, map, { userId, current = null }) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`${LANGUAGE_ROLE_PREFIX}:pick:${userId}`)
        .setPlaceholder(tr.t('language.pick.placeholder'))
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(offeredLanguages(map).map((code) => ({ label: nativeLanguageName(code), value: code, default: code === current })));
    return new ActionRowBuilder().addComponents(menu);
}

/** The persistent panel's buttons (native names, no flags), 4 per row. */
export function languagePanelRows(map) {
    const buttons = offeredLanguages(map).map((code) => new ButtonBuilder()
        .setCustomId(`${LANGUAGE_ROLE_PREFIX}:set:${code}`)
        .setLabel(nativeLanguageName(code))
        .setStyle(ButtonStyle.Secondary));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 4) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 4)));
    return rows;
}

/** The member's current language role (fixed order), or null. */
export function currentLanguageRole(member, map) {
    return offeredLanguages(map).find((code) => hasRole(member, map[code])) || null;
}
