// commands.js — Commands: turn commands, subcommands and whole categories off and on
// in the main server (commandAccessService, the functions /commands uses). Who may use
// a command (EVERYONE / support server lists) is code, shown read-only.
// Also: "Bot settings" (prefix and moderator role, as /configwizard: ConfigService) and
// "Utilities" (Shorten a link, as /shorten: services/urlShortener.js).

import { SUPPORT_SERVER_COMMANDS } from '../../../config/commands/commandAccess.js';
import { adminCommandsRetired, commandEntries } from '../../../config/commands/retirement.js';
import { normalizeCategoryKey } from '../../../config/commands/commandCategories.js';
import { getCommandPrefix } from '../../../config/bot.js';
import { html, path } from '../html.js';
import { InputError, boolField, buttonForm, moduleSwitch, postForm, rolePicker, roleField, text, textInput } from '../forms.js';
import { section, table } from './common.js';
import { currentText, textFor } from '../language.js';

// Words: src/content/dashboard/<lang>/commands.json (command names and descriptions come from the
// commands themselves and stay as they are).

export const PREFIX_MAX = 10;

/** The /configwizard prefix rule: 1–10 characters, no spaces. */
export function prefixField(form, name = 'prefix') {
    const value = typeof form?.[name] === 'string' ? form[name].trim() : '';
    if (!value || value.length > PREFIX_MAX || /\s/.test(value)) throw new InputError(currentText().t('commands.bot.prefixRule'), 400, name);
    return value;
}

/** The stored modRole (an id, or { id } from older configs) as an id. */
function roleIdOf(value) {
    if (!value) return null;
    return typeof value === 'string' ? value : value.id || null;
}

/**
 * Roles the bot hands out on its own (auto role, verification, level rewards, reaction
 * roles): Map roleId → where. Such a role must never be the moderator role, or anyone
 * who joins, verifies, levels up or clicks would get moderator access.
 */
async function autoAssignedRoles(ctx) {
    const out = new Map();
    const add = (id, where) => { if (id && !out.has(id)) out.set(id, where); };
    const [welcome, verification, leveling, panels] = await Promise.all([
        ctx.services.getWelcomeSettings(ctx.client, ctx.guildId),
        ctx.services.getVerificationSettings(ctx.client, ctx.guildId),
        ctx.services.getLevelingConfig(ctx.client, ctx.guildId),
        ctx.services.getAllReactionRoleMessages(ctx.client, ctx.guildId),
    ]);
    const where = (key) => textFor(ctx).t(`commands.bot.where.${key}`);
    for (const id of welcome?.roleIds || []) add(id, where('autoRole'));
    add(verification?.roleId, where('verification'));
    add(verification?.autoVerify?.roleId, where('autoVerify'));
    for (const id of Object.values(leveling?.roleRewards || {})) add(id, where('levelReward'));
    for (const panel of Array.isArray(panels) ? panels : []) for (const id of panel.roles || []) add(typeof id === 'string' ? id : id?.id, where('reactionRole'));
    return out;
}

/**
 * The slash commands (and context menus) that belong to each settings module, shown
 * as a "Commands" section on that module's page. Names not loaded in the bot are skipped.
 */
export const MODULE_COMMANDS = {
    enforcement: ['enforcements', 'case', 'appeals', 'setappeal', 'background', 'staff', 'Moderate', 'Warn for this message', 'Report message'],
    automod: ['automod'],
    logging: ['logging'],
    welcome: ['welcome', 'greet', 'goodbye', 'autorole'],
    tickets: ['ticket', 'modmail', 'canned', 'claim', 'close', 'priority'],
    leveling: ['level', 'rank', 'leaderboard'],
    verification: ['verification', 'verify'],
    'reaction-roles': ['reactroles'],
    giveaways: ['giveaway'],
    messages: ['embedbuilder', 'poll', 'countdown'],
    birthdays: ['birthday'],
    counters: ['serverstats', 'count'],
    'join-to-create': ['jointocreate'],
    applications: ['apply', 'app-admin'],
    community: ['community', 'suggest', 'tag'],
    channels: ['purge', 'lock', 'unlock'],
    rules: ['rules'],
};

/**
 * The "Commands" section of a module page: each of the module's commands with its
 * on/off switch (the same commands/command action as the Commands page, returning to
 * this module page). Protected commands and commands in a disabled category show why
 * they cannot be switched here. Empty when the module has no commands or none are loaded.
 */
export function moduleCommandsSection(ctx, moduleKey, snapshot) {
    const names = MODULE_COMMANDS[moduleKey];
    if (!names || !snapshot) return '';
    const tr = textFor(ctx);
    const found = new Map();
    for (const cat of snapshot.categories) {
        const disabled = new Set(cat.disabledCommandNames);
        for (const cmd of cat.commands) {
            if (names.includes(cmd.name)) found.set(cmd.name, { cmd, cat, on: !disabled.has(cmd.name) });
        }
    }
    const rows = names.filter((name) => found.has(name)).map((name) => {
        const { cmd, cat, on } = found.get(name);
        const control = cmd.protected ? html`<span class="muted">${tr.t('commands.list.protected')}</span>`
            : cat.categoryDisabled ? html`<span class="muted">${tr.t('commands.list.categoryIsOff', { name: cat.displayName })}</span>`
                : moduleSwitch({ csrf: ctx.csrf, canEdit: ctx.canEdit, module: 'commands', action: 'command', enabled: on, label: `/${cmd.name}`, back: moduleKey, hidden: { name: cmd.name }, lang: tr.lang });
        return [html`<code>${/\s/.test(cmd.name) ? cmd.name : `/${cmd.name}`}</code>`, cmd.description || '', control];
    });
    if (!rows.length) return '';
    return section(tr.t('commands.list.moduleTitle', { count: tr.fmtNumber(rows.length) }), table([tr.t('commands.list.command'), tr.t('commands.list.description'), tr.t('commands.list.on')], rows),
        tr.t('commands.list.moduleHelp'), { key: 'commands', size: 'full' });
}

export default {
    key: 'commands',
    label: 'Commands',
    help: 'Turn single commands, or whole groups of commands, on or off for this server. A command that is off only answers with a short notice. /commands and /configwizard always stay on, so you cannot lock yourself out.',

    async load(ctx) {
        const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
        return { config, snapshot: ctx.client?.commands ? ctx.services.getCommandAccessSnapshot(ctx.client, config) : null };
    },

    render(ctx, { config, snapshot }) {
        const tr = textFor(ctx);
        const t = (key, params) => tr.t(`commands.${key}`, params);
        const can = ctx.canEdit && ctx.canAct;
        const botSettings = section(t('bot.title'), postForm(ctx, 'commands', 'bot-settings', html`<div class="grid">
${textInput('prefix', config?.prefix || getCommandPrefix(), { label: t('bot.prefix'), max: PREFIX_MAX, help: t('bot.prefixHelp') })}
${rolePicker(ctx.guild, 'modRole', roleIdOf(config?.modRole), { label: t('bot.modRole'), assign: false, help: t('bot.modRoleHelp') })}</div>`, { canEdit: can }),
        t('bot.help'));
        const utilities = section(t('utilities.title'), postForm(ctx, 'commands', 'shorten', html`<div class="grid">
${textInput('url', '', { label: t('utilities.url'), max: 2000, type: 'url', placeholder: 'https://example.com/a/long/link', help: t('utilities.urlHelp') })}
${textInput('custom', '', { label: t('utilities.custom'), max: 30, help: t('utilities.customHelp') })}</div>`, { submit: t('utilities.submit'), canEdit: can }),
        t('utilities.help'), { open: false });
        const settingsPart = html`${ctx.canAct ? '' : html`<p class="muted">${t('bot.needsAdmin')}</p>`}${botSettings}${utilities}`;
        if (!snapshot) return html`${settingsPart}${section(t('list.title'), html`<p class="muted">${t('list.notLoaded')}</p>`)}`;
        const categories = snapshot.categories.map((cat) => {
            const disabled = new Set(cat.disabledCommandNames);
            const rows = cat.commands.map((cmd) => {
                const on = !disabled.has(cmd.name);
                return [html`<code>/${cmd.name}</code>`, cmd.description,
                    html`<span class="state ${on ? 'state-on' : 'state-off'}">${tr.t(on ? 'forms.pillOn' : 'forms.pillOff')}</span>`,
                    cmd.protected || cat.categoryDisabled ? html`<span class="muted">${cmd.protected ? t('list.protected') : t('list.categoryOff')}</span>`
                        : buttonForm(ctx, 'commands', 'command', tr.t(on ? 'forms.turnOff' : 'forms.turnOn'), { name: cmd.name, enabled: on ? 'false' : 'true' }, { danger: on })];
            });
            const header = html`<p>${t('list.count', { on: tr.fmtNumber(cat.enabledCount), total: tr.fmtNumber(cat.totalCount) })} ${buttonForm(ctx, 'commands', 'category', cat.categoryDisabled ? t('list.turnCategoryOn') : t('list.turnCategoryOff'), { key: cat.key, enabled: cat.categoryDisabled ? 'true' : 'false' }, { danger: !cat.categoryDisabled })}</p>`;
            return section(cat.categoryDisabled ? t('list.offSuffix', { name: cat.displayName }) : cat.displayName, html`${header}${table([t('list.command'), t('list.description'), t('list.state'), ''], rows)}`);
        });
        // Every command and subcommand: who may use it, where its job is on the dashboard, and
        // what happens to it when admin commands are retired (RETIRE_ADMIN_COMMANDS).
        const entries = commandEntries(ctx.client.commands);
        const retired = adminCommandsRetired();
        const WHO = { everyone: t('every.whoEveryone'), 'owner kit': t('every.whoOwnerKit'), admin: t('every.whoAdmin') };
        const AFTER = { everyone: t('every.afterEveryone'), 'owner kit': t('every.afterOwnerKit'), admin: t('every.afterAdmin') };
        const test = html`<code>/test</code>`;
        const every = html`<p>${retired
            ? html`<span class="state state-on">${t('every.retired')}</span> ${tr.tx('commands.every.retiredText', { test })}`
            : html`<span class="state state-off">${t('every.notRetired')}</span> ${tr.tx('commands.every.notRetiredText', { test })}`}</p>
${table([t('list.command'), t('every.whatItDoes'), t('every.who'), t('every.onDashboard'), t('every.ifRetired')], entries.map((e) => [
            html`<code>/${e.key}</code>`, e.description, WHO[e.access],
            e.page ? html`<a href="${path(`/${e.page}`)}">${e.page}</a>` : html`<span class="muted">-</span>`,
            e.access === 'admin' && !e.page ? t('every.afterEveryone') : AFTER[e.access]]))}
<p class="muted">${tr.tx('commands.every.support', { list: html`${[...SUPPORT_SERVER_COMMANDS].sort().map((c, i) => html`${i ? ', ' : ''}<code>${c}</code>`)}` })}</p>`;
        return html`${settingsPart}${section(t('every.title', { count: tr.fmtNumber(entries.length) }), every)}${categories}`;
    },

    actions: {
        'bot-settings': {
            admin: true,
            async run(ctx, form) {
                const prefix = prefixField(form);
                const tr = textFor(ctx);
                const modRole = roleField(ctx.guild, form, 'modRole', { label: tr.t('commands.bot.modRole') });
                if (modRole) {
                    const where = (await autoAssignedRoles(ctx)).get(modRole);
                    if (where) throw new InputError(tr.t('commands.bot.modRoleAuto', { role: ctx.guild.roles.cache.get(modRole)?.name || modRole, where }), 400, 'modRole');
                }
                const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
                const current = { prefix: config.prefix || getCommandPrefix(), modRole: roleIdOf(config.modRole) };
                const changes = [];
                for (const [key, value] of Object.entries({ prefix, modRole })) {
                    if ((current[key] ?? null) === (value ?? null)) continue;
                    await ctx.services.updateConfigSetting(ctx.client, ctx.guildId, key, value, ctx.actor.userId);
                    changes.push({ key, old: current[key] ?? null, new: value ?? null });
                }
                return { changes, message: tr.t(changes.length ? 'commands.bot.saved' : 'commands.bot.nothing') };
            },
        },
        shorten: {
            admin: true,
            async run(ctx, form) {
                const url = text(form, 'url', 2000);
                const custom = text(form, 'custom', 30);
                let shortUrl;
                try {
                    shortUrl = await ctx.services.shortenUrl(url, custom);
                } catch (error) {
                    // Network and service errors are shown on the page too (nothing was changed).
                    if (error?.userMessage) throw new InputError(error.userMessage, 400, error.type === 'validation' ? 'url' : null);
                    throw error;
                }
                return {
                    changes: [{ key: 'shortLink', old: null, new: { url, shortUrl } }],
                    message: textFor(ctx).t('commands.utilities.result', { short: shortUrl, url }),
                };
            },
        },
        async command(ctx, form) {
            const tr = textFor(ctx);
            const name = text(form, 'name', 100).toLowerCase();
            const enabled = boolField(form, 'enabled', tr.t('commands.action.commandLabel'));
            const target = ctx.services.resolveCommandTarget(ctx.client, name);
            if (!target) throw new InputError(tr.t('commands.action.unknownCommand', { name }));
            if (!enabled && target.protected) throw new InputError(tr.t('commands.action.cannotDisable', { name }));
            const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
            const wasDisabled = Boolean(config.disabledCommands?.[name]);
            if (enabled) await ctx.services.enableCommand(ctx.client, ctx.guildId, name);
            else await ctx.services.disableCommand(ctx.client, ctx.guildId, name);
            const changes = wasDisabled === !enabled ? [] : [{ key: `disabledCommands.${name}`, old: wasDisabled, new: !enabled }];
            return { changes, message: tr.t(enabled ? 'commands.action.commandOn' : 'commands.action.commandOff', { name }) };
        },
        async category(ctx, form) {
            const tr = textFor(ctx);
            const key = normalizeCategoryKey(text(form, 'key', 60));
            const enabled = boolField(form, 'enabled', tr.t('commands.action.categoryLabel'));
            const category = ctx.services.getCategoryRegistry(ctx.client, key);
            if (!category) throw new InputError(tr.t('commands.action.unknownCategory'));
            const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
            const wasDisabled = Boolean(config.disabledCategories?.[key]);
            if (enabled) await ctx.services.enableCategory(ctx.client, ctx.guildId, key);
            else await ctx.services.disableCategory(ctx.client, ctx.guildId, key);
            const changes = wasDisabled === !enabled ? [] : [{ key: `disabledCategories.${key}`, old: wasDisabled, new: !enabled }];
            return { changes, message: tr.t(enabled ? 'commands.action.categoryOn' : 'commands.action.categoryOff', { name: category.displayName }) };
        },
    },
};
