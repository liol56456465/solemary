// setupGuide.js — what /setup shows: this server's setup checklist, the dashboard link and the
// command list by category (multi-server B2). Read-only: nothing here changes a setting.
//
// The checklist reads the multi-server-safe settings (settingsFor / resolvedSource: a server
// other than Mewvo's own only sees what it stored itself) and the module states the dashboard
// sidebar uses (moduleStatesFrom). A database error throws; the caller gives the normal error
// reply (CLAUDE.md "Data layer rules": never show defaults after a failed read).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { getWelcomeConfig } from '../../utils/database.js';
import { getAutomodSettings } from '../automod/automodSettings.js';
import { isHomeGuild, resolvedSource, settingsFor } from '../settings/guildSettings.js';
import { moduleStatesFrom } from '../dashboard/overview.js';
import { dashboardUrlFor } from '../site/shell.js';
import { LANGUAGES } from '../site/i18n.js';
import { hasEveryoneAccess, isManageServerCommand } from '../../config/commands/commandAccess.js';
import { isCommandAvailableInGuild } from '../../utils/commandGate.js';
import { categoryLabel } from '../../config/commands/commandCategories.js';
import { DISCORD_LOCALES } from '../../utils/commandLocalizations.js';
import { detectedServerLanguage } from '../../utils/botText.js';
import { memberReach, reachOk } from '../dashboard/botPermissions.js';

export const SETUP_SELECT_ID = 'setup-cat';
const SET = '✅';
const NOT_SET = '➖';
const DESCRIPTION_LIMIT = 4096;
const LINE_LIMIT = 200;

export const defaultSetupData = {
    settingsFor: (guildId) => settingsFor(guildId),
    languageSource: (guildId) => resolvedSource(guildId, 'botLanguage'),
    // Whether "where members appeal" was chosen on purpose (saved), like the dashboard checklist.
    appealsSource: (guildId) => resolvedSource(guildId, 'appealsHome'),
    isHomeGuild: (guildId) => isHomeGuild(guildId),
    // The server's Discord language, for a server that never chose a bot language (botText.js).
    detectedLanguage: (guildId, guild) => detectedServerLanguage(guildId, { locale: guild?.preferredLocale ?? null }),
    // Members whose top role is at or above Mewvo's (member cache only, no fetch).
    memberReach: (guild) => memberReach(guild),
    getGuildConfig: (client, guildId) => getGuildConfig(client, guildId),
    getWelcomeConfig: (client, guildId) => getWelcomeConfig(client, guildId),
    getAutomodSettings: (guildId) => getAutomodSettings(guildId),
};

/**
 * Everything the checklist needs for one server. Throws when a source cannot be read.
 * `config`: the guild config the dispatcher already read (saves a read); `data` for tests.
 */
export async function collectSetupState({ client, guildId, config = null, data = defaultSetupData }) {
    const settings = data.settingsFor(guildId);
    const languageSource = data.languageSource(guildId);
    const appealsSaved = data.appealsSource ? data.appealsSource(guildId) === 'database' : true;
    const [guildConfig, welcome, automod] = await Promise.all([
        config ? Promise.resolve(config) : data.getGuildConfig(client, guildId),
        data.getWelcomeConfig(client, guildId),
        data.getAutomodSettings(guildId),
    ]);
    const home = Boolean(data.isHomeGuild(guildId));
    const guild = client?.guilds?.cache?.get?.(guildId) || null;
    let reach = null;
    try {
        reach = guild && data.memberReach ? data.memberReach(guild) : null;
    } catch {
        reach = null; // cannot be checked: no row
    }
    return {
        settings,
        appealsSaved,
        languageSource,
        detectedLanguage: home || languageSource !== 'default' ? null : data.detectedLanguage?.(guildId, guild) ?? null,
        reach,
        home,
        modules: moduleStatesFrom(guildConfig, welcome, { automod }),
    };
}

const channel = (id) => `<#${id}>`;
const languageName = (code) => LANGUAGES.find((l) => l.code === code)?.name || 'English';

/** The checklist rows: [{ key, done, text }], text in `tr`'s language. */
export function checklistRows(state, tr) {
    const { settings, modules, home, languageSource, detectedLanguage = null, reach = null, appealsSaved = true } = state;
    const t = (key, params) => tr.t(`setup.item.${key}`, params);
    const onOff = (key, on) => ({ key, done: Boolean(on), text: on ? tr.t('setup.on') : `${tr.t('setup.off')}. ${t(`${key}.next`)}` });

    const rows = [];
    // First: Mewvo can only moderate members below its own role.
    if (reach) {
        const count = reach.partial ? t('rolePosition.atLeast', { count: reach.count }) : String(reach.count);
        const names = (list) => (list || []).map((r) => `@${r.name}`).join(', ');
        if (reachOk(reach)) rows.push({ key: 'rolePosition', done: true, text: t('rolePosition.ok') });
        // Nobody counted, but the member cache is incomplete: name the roles above Mewvo instead of "fine".
        else if (reach.count === 0) rows.push({ key: 'rolePosition', done: false, text: t('rolePosition.rolesAbove', { roles: names(reach.rolesAbove) }) });
        else rows.push({ key: 'rolePosition', done: false, text: t('rolePosition.blocked', { count, roles: names(reach.roles) }) });
    }
    rows.push(settings.modLogChannelId
        ? { key: 'modLog', done: true, text: channel(settings.modLogChannelId) }
        : { key: 'modLog', done: false, text: t('modLog.next') });
    rows.push(settings.reviewChannelId
        ? { key: 'staff', done: true, text: channel(settings.reviewChannelId) }
        : { key: 'staff', done: false, text: settings.modLogChannelId ? t('staff.fallback') : t('staff.next') });
    // Mewvo's own servers always use the Mewvo support server; other servers choose (appealsHome).
    if (home) rows.push({ key: 'appeals', done: true, text: t('appeals.mewvo') });
    else if (!appealsSaved) rows.push({ key: 'appeals', done: false, text: t('appeals.notChosen') });
    else if (settings.appealsHome === 'own') {
        rows.push(settings.appealsInvite
            ? { key: 'appeals', done: true, text: t('appeals.own', { invite: settings.appealsInvite }) }
            : { key: 'appeals', done: false, text: t('appeals.ownMissing') });
    } else rows.push({ key: 'appeals', done: true, text: t('appeals.mewvoChoice') });
    rows.push(onOff('automod', modules.automod));
    rows.push(onOff('verification', modules.verification));
    rows.push(onOff('welcome', modules.welcome));
    rows.push(onOff('tickets', modules.tickets));
    rows.push(onOff('leveling', modules.leveling));
    if (languageSource !== 'default') rows.push({ key: 'language', done: true, text: languageName(settings.botLanguage) });
    else if (detectedLanguage && detectedLanguage !== 'en') rows.push({ key: 'language', done: false, text: t('language.detected', { language: languageName(detectedLanguage) }) });
    else rows.push({ key: 'language', done: false, text: t('language.default') });
    return rows;
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One checklist line per row: "✅ **Label**: text". */
export function checklistText(rows, tr) {
    return rows.map((row) => `${row.done ? SET : NOT_SET} **${tr.t(`setup.item.${row.key}.label`)}**: ${row.text}`).join('\n');
}

/**
 * The commands of this server by category folder (src/commands/<Category>), sorted:
 * [{ category, label, commands: [{ name, description, locked, menu }] }]. Owner tools only where
 * they run (the owner-tools server). locked = Administrator only (no part for everyone, not /setup).
 * `tr`: label and description in that language (core.categories.*, the command's own
 * description_localizations), else English.
 */
export function commandCategories(client, guildId, tr = null) {
    const locale = tr?.lang ? DISCORD_LOCALES[tr.lang]?.[0] : null;
    const byCategory = new Map();
    for (const command of client?.commands?.values?.() || []) {
        const json = command?.data?.toJSON?.();
        if (!json?.name || !command.category) continue;
        if (!isCommandAvailableInGuild(command, guildId)) continue;
        if (!byCategory.has(command.category)) byCategory.set(command.category, []);
        byCategory.get(command.category).push({
            name: json.name,
            description: (locale && json.description_localizations?.[locale]) || json.description || '',
            menu: json.type === 2 || json.type === 3,
            locked: !hasEveryoneAccess(json.name) && !isManageServerCommand(json.name),
        });
    }
    return [...byCategory.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, commands]) => ({
            category, label: categoryLabel(category, tr),
            commands: commands.sort((a, b) => a.name.localeCompare(b.name)),
        }));
}

/** The category select (at most 25 options, Discord's limit). customId: setup-cat:<userId>. */
export function categorySelect(categories, userId, tr, selected = null) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`${SETUP_SELECT_ID}:${userId}`)
        .setPlaceholder(tr.t('setup.selectPlaceholder'))
        .addOptions(categories.slice(0, 25).map((c) => ({
            label: cut(c.label, 100), value: cut(c.category, 100), default: c.category === selected,
        })));
    return new ActionRowBuilder().addComponents(menu);
}

function dashboardRow(guildId, tr) {
    const url = dashboardUrlFor(guildId);
    if (!url) return null;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(tr.t('setup.dashboardButton')).setURL(url));
}

/** The /setup reply: checklist embed, dashboard button, category select. */
export function setupReply({ client, guild, userId, state, tr }) {
    const rows = checklistRows(state, tr);
    const dashboard = dashboardRow(guild.id, tr);
    const description = [
        tr.t('setup.intro'),
        ...(dashboard ? [] : [`-# ${tr.t('setup.noDashboard')}`]),
        '',
        `**${tr.t('setup.checklistTitle')}**`,
        checklistText(rows, tr),
        '',
        `**${tr.t('setup.commandsTitle')}**`,
        tr.t('setup.commandsHint'),
    ].join('\n');
    const embed = createEmbed({
        title: cut(tr.t('setup.title', { server: guild.name || guild.id }), 256),
        description: cut(description, DESCRIPTION_LIMIT),
        color: 'primary',
    });
    const categories = commandCategories(client, guild.id, tr);
    const components = [...(dashboard ? [dashboard] : []), ...(categories.length ? [categorySelect(categories, userId, tr)] : [])];
    return { embeds: [embed], components, rows };
}

/** One category's list: one line per command, cut to the embed description limit. */
export function categoryReply({ client, guildId, userId, category, tr }) {
    const categories = commandCategories(client, guildId, tr);
    const found = categories.find((c) => c.category === category);
    const lines = (found?.commands || []).map((c) => cut(`${c.locked ? '🔒 ' : ''}**${c.menu ? c.name : `/${c.name}`}** ${c.description}`.trim(), LINE_LIMIT));
    let text = '';
    let shown = 0;
    for (const line of lines) {
        const more = tr.tp('setup.more', lines.length - shown - 1);
        if (text.length + line.length + 1 + more.length + 1 > DESCRIPTION_LIMIT) break;
        text += `${text ? '\n' : ''}${line}`;
        shown += 1;
    }
    if (shown < lines.length) text += `\n${tr.tp('setup.more', lines.length - shown)}`;
    const embed = createEmbed({
        title: cut(tr.t('setup.categoryTitle', { category: found?.label || categoryLabel(String(category || ''), tr) }), 256),
        description: text || tr.t('setup.categoryEmpty'),
        color: 'primary',
    });
    const dashboard = dashboardRow(guildId, tr);
    const components = [...(dashboard ? [dashboard] : []), ...(categories.length ? [categorySelect(categories, userId, tr, category)] : [])];
    return { embeds: [embed], components };
}
