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

export const PREFIX_MAX = 10;

/** The /configwizard prefix rule: 1–10 characters, no spaces. */
export function prefixField(form, name = 'prefix') {
    const value = typeof form?.[name] === 'string' ? form[name].trim() : '';
    if (!value || value.length > PREFIX_MAX || /\s/.test(value)) throw new InputError('Prefix must be 1-10 characters with no spaces.', 400, name);
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
    for (const id of welcome?.roleIds || []) add(id, 'the auto role given on join');
    add(verification?.roleId, 'the verification role');
    add(verification?.autoVerify?.roleId, 'the auto-verify role');
    for (const id of Object.values(leveling?.roleRewards || {})) add(id, 'a level reward');
    for (const panel of Array.isArray(panels) ? panels : []) for (const id of panel.roles || []) add(typeof id === 'string' ? id : id?.id, 'a reaction role');
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
    const found = new Map();
    for (const cat of snapshot.categories) {
        const disabled = new Set(cat.disabledCommandNames);
        for (const cmd of cat.commands) {
            if (names.includes(cmd.name)) found.set(cmd.name, { cmd, cat, on: !disabled.has(cmd.name) });
        }
    }
    const rows = names.filter((name) => found.has(name)).map((name) => {
        const { cmd, cat, on } = found.get(name);
        const control = cmd.protected ? html`<span class="muted">protected</span>`
            : cat.categoryDisabled ? html`<span class="muted">category ${cat.displayName} is off</span>`
                : moduleSwitch({ csrf: ctx.csrf, canEdit: ctx.canEdit, module: 'commands', action: 'command', enabled: on, label: `/${cmd.name}`, back: moduleKey, hidden: { name: cmd.name } });
        return [html`<code>${/\s/.test(cmd.name) ? cmd.name : `/${cmd.name}`}</code>`, cmd.description || '', control];
    });
    if (!rows.length) return '';
    return section(`Commands (${rows.length})`, table(['Command', 'Description', 'On'], rows),
        'Turning a command off makes it answer with a short notice. All commands: the Commands page.', { open: false, key: 'commands' });
}

export default {
    key: 'commands',
    label: 'Commands',
    help: 'Disabled commands answer with a short notice. Protected commands (/commands, /configwizard) cannot be disabled.',

    async load(ctx) {
        const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
        return { config, snapshot: ctx.client?.commands ? ctx.services.getCommandAccessSnapshot(ctx.client, config) : null };
    },

    render(ctx, { config, snapshot }) {
        const can = ctx.canEdit && ctx.canAct;
        const botSettings = section('Bot settings', postForm(ctx, 'commands', 'bot-settings', html`<div class="grid">
${textInput('prefix', config?.prefix || getCommandPrefix(), { label: 'Prefix for text commands', max: PREFIX_MAX, help: '1–10 characters, no spaces.' })}
${rolePicker(ctx.guild, 'modRole', roleIdOf(config?.modRole), { label: 'Moderator role', assign: false, help: 'Members with this role may use moderation commands, and log in to this dashboard at the Moderator level (view members, cases, appeals; warn, mute, unmute, kick, time out; no bans or settings). Not a role the bot hands out on its own.' })}</div>`, { canEdit: can }),
        'Same settings as /configwizard.');
        const utilities = section('Utilities', postForm(ctx, 'commands', 'shorten', html`<div class="grid">
${textInput('url', '', { label: 'Link to shorten', max: 2000, type: 'url', placeholder: 'https://example.com/a/long/link' })}
${textInput('custom', '', { label: 'Custom ending (optional)', max: 30, help: 'Letters, numbers, _ and -.' })}</div>`, { submit: 'Shorten', canEdit: can }),
        'Shorten a link with is.gd, as /shorten. The short link is shown at the top of this page.', { open: false });
        const settingsPart = html`${ctx.canAct ? '' : html`<p class="muted">Bot settings and utilities need Administrator in the main server.</p>`}${botSettings}${utilities}`;
        if (!snapshot) return html`${settingsPart}${section('Commands', html`<p class="muted">The command list is not loaded yet.</p>`)}`;
        const categories = snapshot.categories.map((cat) => {
            const disabled = new Set(cat.disabledCommandNames);
            const rows = cat.commands.map((cmd) => {
                const on = !disabled.has(cmd.name);
                return [html`<code>/${cmd.name}</code>`, cmd.description,
                    html`<span class="state ${on ? 'state-on' : 'state-off'}">${on ? 'on' : 'off'}</span>`,
                    cmd.protected || cat.categoryDisabled ? html`<span class="muted">${cmd.protected ? 'protected' : 'category off'}</span>`
                        : buttonForm(ctx, 'commands', 'command', on ? 'Turn off' : 'Turn on', { name: cmd.name, enabled: on ? 'false' : 'true' }, { danger: on })];
            });
            const header = html`<p>${cat.enabledCount}/${cat.totalCount} on. ${buttonForm(ctx, 'commands', 'category', cat.categoryDisabled ? 'Turn category on' : 'Turn category off', { key: cat.key, enabled: cat.categoryDisabled ? 'true' : 'false' }, { danger: !cat.categoryDisabled })}</p>`;
            return section(`${cat.displayName}${cat.categoryDisabled ? ' (off)' : ''}`, html`${header}${table(['Command', 'Description', 'State', ''], rows)}`);
        });
        // Every command and subcommand: who may use it, where its job is on the dashboard, and
        // what happens to it when admin commands are retired (RETIRE_ADMIN_COMMANDS).
        const entries = commandEntries(ctx.client.commands);
        const retired = adminCommandsRetired();
        const WHO = { everyone: 'Everyone', 'owner kit': 'Bot owners (emergency kit)', admin: 'Administrators' };
        const AFTER = { everyone: 'Stays a command', 'owner kit': 'Stays, owners only', admin: 'Dashboard only' };
        const every = html`<p>${retired
            ? html`<span class="state state-on">Retired</span> Admin commands are retired: only everyone-commands and the owners' emergency kit are registered.`
            : html`<span class="state state-off">Not retired</span> All commands are registered. Set <code>RETIRE_ADMIN_COMMANDS=true</code> to leave only the everyone-commands and the owners' emergency kit.`}</p>
${table(['Command', 'What it does', 'Who', 'On the dashboard', 'When retired'], entries.map((e) => [
            html`<code>/${e.key}</code>`, e.description, WHO[e.access],
            e.page ? html`<a href="${path(`/${e.page}`)}">${e.page}</a>` : html`<span class="muted">—</span>`,
            AFTER[e.access]]))}
<p class="muted">Support server too: ${[...SUPPORT_SERVER_COMMANDS].sort().map((c, i) => html`${i ? ', ' : ''}<code>${c}</code>`)}. Who may use what is part of the bot's code (read-only).</p>`;
        return html`${settingsPart}${section(`Every command (${entries.length})`, every)}${categories}`;
    },

    actions: {
        'bot-settings': {
            admin: true,
            async run(ctx, form) {
                const prefix = prefixField(form);
                const modRole = roleField(ctx.guild, form, 'modRole', { label: 'Moderator role' });
                if (modRole) {
                    const where = (await autoAssignedRoles(ctx)).get(modRole);
                    if (where) throw new InputError(`Moderator role: @${ctx.guild.roles.cache.get(modRole)?.name || modRole} is ${where}, so everyone who gets it would become a moderator. Pick a staff-only role.`, 400, 'modRole');
                }
                const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
                const current = { prefix: config.prefix || getCommandPrefix(), modRole: roleIdOf(config.modRole) };
                const changes = [];
                for (const [key, value] of Object.entries({ prefix, modRole })) {
                    if ((current[key] ?? null) === (value ?? null)) continue;
                    await ctx.services.updateConfigSetting(ctx.client, ctx.guildId, key, value, ctx.actor.userId);
                    changes.push({ key, old: current[key] ?? null, new: value ?? null });
                }
                return { changes, message: changes.length ? 'Bot settings saved.' : 'Nothing changed.' };
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
                    message: `Short link: ${shortUrl} (for ${url})`,
                };
            },
        },
        async command(ctx, form) {
            const name = text(form, 'name', 100).toLowerCase();
            const enabled = boolField(form, 'enabled', 'Command');
            const target = ctx.services.resolveCommandTarget(ctx.client, name);
            if (!target) throw new InputError(`Unknown command: /${name}.`);
            if (!enabled && target.protected) throw new InputError(`/${name} cannot be disabled.`);
            const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
            const wasDisabled = Boolean(config.disabledCommands?.[name]);
            if (enabled) await ctx.services.enableCommand(ctx.client, ctx.guildId, name);
            else await ctx.services.disableCommand(ctx.client, ctx.guildId, name);
            const changes = wasDisabled === !enabled ? [] : [{ key: `disabledCommands.${name}`, old: wasDisabled, new: !enabled }];
            return { changes, message: `/${name} is now ${enabled ? 'on' : 'off'}.` };
        },
        async category(ctx, form) {
            const key = normalizeCategoryKey(text(form, 'key', 60));
            const enabled = boolField(form, 'enabled', 'Category');
            const category = ctx.services.getCategoryRegistry(ctx.client, key);
            if (!category) throw new InputError('Unknown category.');
            const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
            const wasDisabled = Boolean(config.disabledCategories?.[key]);
            if (enabled) await ctx.services.enableCategory(ctx.client, ctx.guildId, key);
            else await ctx.services.disableCategory(ctx.client, ctx.guildId, key);
            const changes = wasDisabled === !enabled ? [] : [{ key: `disabledCategories.${key}`, old: wasDisabled, new: !enabled }];
            return { changes, message: `${category.displayName} is now ${enabled ? 'on' : 'off'}.` };
        },
    },
};
