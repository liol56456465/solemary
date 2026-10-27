// commands.js — Commands: turn commands, subcommands and whole categories off and on
// in the main server (commandAccessService, the functions /commands uses). Who may use
// a command (EVERYONE / support server lists) is code, shown read-only.

import { EVERYONE_COMMANDS, SUPPORT_SERVER_COMMANDS } from '../../../config/commands/commandAccess.js';
import { normalizeCategoryKey } from '../../../config/commands/commandCategories.js';
import { html } from '../html.js';
import { InputError, boolField, buttonForm, text } from '../forms.js';
import { section, table } from './common.js';

export default {
    key: 'commands',
    label: 'Commands',
    help: 'Disabled commands answer with a short notice. Protected commands (/commands, /configwizard) cannot be disabled.',

    async load(ctx) {
        const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
        return { snapshot: ctx.client?.commands ? ctx.services.getCommandAccessSnapshot(ctx.client, config) : null };
    },

    render(ctx, { snapshot }) {
        if (!snapshot) return section('Commands', html`<p class="muted">The command list is not loaded yet.</p>`);
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
        const access = html`<p>Everyone may use: ${[...EVERYONE_COMMANDS].sort().map((c, i) => html`${i ? ', ' : ''}<code>${c}</code>`)}</p>
<p>Support server only: ${[...SUPPORT_SERVER_COMMANDS].sort().map((c, i) => html`${i ? ', ' : ''}<code>${c}</code>`)}</p>
<p class="muted">Every other command needs staff permissions. These lists are part of the bot's code (read-only).</p>`;
        return html`${section('Who can use commands', access)}${categories}`;
    },

    actions: {
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
