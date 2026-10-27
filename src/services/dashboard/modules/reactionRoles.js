// reactionRoles.js — Reaction role panels: create a panel (posted by the bot), add or
// remove a role, delete a panel. Everything goes through services/reactionRoleService.js
// (role safety, bot permissions, row-locked panel data, rebuilds the live message), the
// same functions /reactroles setup and /reactroles dashboard use.

import { html } from '../html.js';
import {
    InputError, PERMS, buttonForm, channelField, channelName, channelPicker, isSnowflake, list, postForm, rolePicker, roleName,
    roleWarnings, text, textArea, textInput,
} from '../forms.js';
import { section, table } from './common.js';
import { MAX_PANELS_PER_GUILD, PANEL_DESCRIPTION_MAX, PANEL_TITLE_MAX } from '../../reactionRoleService.js';

function messageIdField(form) {
    const id = text(form, 'messageId', 25);
    if (!isSnowflake(id)) throw new InputError('Unknown panel.');
    return id;
}

export default {
    key: 'reaction-roles',
    label: 'Reaction roles',
    help: 'Self-assign role panels: members pick roles from a menu under the panel message. Unsafe roles (staff permissions, above my highest role, managed) are refused.',

    async load(ctx) {
        return { panels: await ctx.services.getAllReactionRoleMessages(ctx.client, ctx.guildId) };
    },

    render(ctx, { panels }) {
        const g = ctx.guild;
        const canPost = ctx.canEdit && ctx.canAct;
        const create = panels.length >= MAX_PANELS_PER_GUILD
            ? html`<p class="muted">This server has the maximum of ${MAX_PANELS_PER_GUILD} panels. Delete one to create another.</p>`
            : postForm(ctx, 'reaction-roles', 'panel-create', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: 'Post in', perms: PERMS.post, optional: false })}
${textInput('title', '', { label: 'Title', max: PANEL_TITLE_MAX })}
${textArea('description', '', { label: 'Description', max: PANEL_DESCRIPTION_MAX, rows: 3 })}
${rolePicker(g, 'roleIds', [], { label: 'Roles (choose up to 25; Ctrl/Cmd-click for several)', autoAssign: true, multiple: true })}</div>`,
            { submit: 'Create and post the panel', canEdit: canPost });
        const existing = panels.map((panel) => {
            const roles = Array.isArray(panel.roles) ? panel.roles : Object.values(panel.roles || {});
            const rows = roles.map((roleId) => [roleName(g, roleId), roleWarnings(g, roleId, { autoAssign: true }).join('; ') || html`<span class="ok">ok</span>`,
                buttonForm(ctx, 'reaction-roles', 'role-remove', 'Remove', { messageId: panel.messageId, roleId })]);
            const body = html`<p>In ${channelName(g, panel.channelId)} · message <code>${panel.messageId}</code> · ${roles.length}/25 roles</p>
${table(['Role', 'Problems', ''], rows, 'No roles.')}
<div class="row-actions">${postForm(ctx, 'reaction-roles', 'role-add', rolePicker(g, 'roleId', null, { label: 'Add role', optional: false, autoAssign: true }), { submit: 'Add', inline: true, hidden: { messageId: panel.messageId } })}
${buttonForm(ctx, 'reaction-roles', 'panel-delete', 'Delete panel', { messageId: panel.messageId }, { confirm: 'Delete this panel and its message in Discord?' })}</div>`;
            return section(`Panel ${panel.messageId}`, body);
        });
        return html`${section('New panel', create, `Same as /reactroles setup.${ctx.canAct ? '' : ' Posting needs Administrator in the main server.'}`, { open: panels.length === 0 })}
${existing.length ? existing : section('Panels', html`<p class="muted">No reaction role panels yet.</p>`)}`;
    },

    actions: {
        'panel-create': {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const channelId = channelField(g, form, 'channelId', { optional: false, label: 'Post in' });
                const roleIds = list(form, 'roleIds', { max: 25 }).filter(isSnowflake);
                if (!roleIds.length) throw new InputError('Choose at least one role.');
                const { message, roles, rejected } = await ctx.services.createReactionRolePanel(ctx.client, g, {
                    channel: g.channels.cache.get(channelId), title: text(form, 'title', PANEL_TITLE_MAX + 1),
                    description: text(form, 'description', PANEL_DESCRIPTION_MAX + 1), roleIds,
                    actorId: ctx.actor.userId, actorTag: `${ctx.actor.username} (dashboard)`,
                });
                return {
                    changes: [{ key: `panel.${message.id}`, old: null, new: { channelId, roles: roles.map((r) => r.id) } }],
                    message: `Panel posted with ${roles.length} role(s).`,
                    warnings: rejected.length ? [`Skipped: ${rejected.join('; ')}`] : [],
                };
            },
        },
        async 'role-add'(ctx, form) {
            const messageId = messageIdField(form);
            const roleId = text(form, 'roleId', 25);
            if (!isSnowflake(roleId) || !ctx.guild?.roles?.cache?.get(roleId)) throw new InputError('Role: that role is not in the server.');
            const before = await ctx.services.getAllReactionRoleMessages(ctx.client, ctx.guildId).then((p) => p.find((x) => x.messageId === messageId));
            const { panel } = await ctx.services.addPanelRole(ctx.client, ctx.guildId, messageId, roleId);
            return { changes: [{ key: `panel.${messageId}.roles`, old: before?.roles || [], new: panel.roles }], message: 'Role added to the panel.' };
        },
        async 'role-remove'(ctx, form) {
            const messageId = messageIdField(form);
            const roleId = text(form, 'roleId', 25);
            if (!isSnowflake(roleId)) throw new InputError('Unknown role.');
            const { panel, deletedPanel } = await ctx.services.removePanelRole(ctx.client, ctx.guildId, messageId, roleId);
            const old = [...(panel?.roles || []), roleId];
            return {
                changes: [{ key: `panel.${messageId}.roles`, old, new: deletedPanel ? null : panel.roles }],
                message: deletedPanel ? 'That was the last role: the panel was deleted.' : 'Role removed from the panel.',
            };
        },
        async 'panel-delete'(ctx, form) {
            const messageId = messageIdField(form);
            const { deleted, panel } = await ctx.services.deletePanel(ctx.client, ctx.guildId, messageId, { actorId: ctx.actor.userId, actorTag: `${ctx.actor.username} (dashboard)` });
            if (!deleted) throw new InputError('That panel no longer exists.');
            return { changes: [{ key: `panel.${messageId}`, old: panel?.roles || null, new: null }], message: 'Panel deleted.' };
        },
    },
};
