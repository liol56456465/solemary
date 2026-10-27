// reactionRoles.js — Reaction role panels: list, add/remove a role, delete a panel.
// Writes go through services/reactionRoleService.js (row-locked, rebuilds the live
// panel message), the same functions /reactroles dashboard uses. Creating a new panel
// stays in Discord (/reactroles setup): the bot has to post the panel message.

import { html } from '../html.js';
import { InputError, buttonForm, channelName, isSnowflake, postForm, rolePicker, roleName, roleWarnings, text } from '../forms.js';
import { section, table } from './common.js';

function messageIdField(form) {
    const id = text(form, 'messageId', 25);
    if (!isSnowflake(id)) throw new InputError('Unknown panel.');
    return id;
}

export default {
    key: 'reaction-roles',
    label: 'Reaction roles',
    help: 'Self-assign role panels. Create a new panel with /reactroles setup in Discord; manage existing panels here.',

    async load(ctx) {
        return { panels: await ctx.services.getAllReactionRoleMessages(ctx.client, ctx.guildId) };
    },

    render(ctx, { panels }) {
        const g = ctx.guild;
        if (!panels.length) return section('Panels', html`<p class="muted">No reaction role panels. Create one with /reactroles setup in Discord.</p>`);
        return html`${panels.map((panel) => {
            const roles = Array.isArray(panel.roles) ? panel.roles : Object.values(panel.roles || {});
            const rows = roles.map((roleId) => [roleName(g, roleId), roleWarnings(g, roleId, { autoAssign: true }).join('; ') || html`<span class="ok">ok</span>`,
                buttonForm(ctx, 'reaction-roles', 'role-remove', 'Remove', { messageId: panel.messageId, roleId })]);
            const body = html`<p>In ${channelName(g, panel.channelId)} · message <code>${panel.messageId}</code> · ${roles.length}/25 roles</p>
${table(['Role', 'Problems', ''], rows, 'No roles.')}
${postForm(ctx, 'reaction-roles', 'role-add', rolePicker(g, 'roleId', null, { label: 'Add role', optional: false, autoAssign: true }), { submit: 'Add', inline: true, hidden: { messageId: panel.messageId } })}
${buttonForm(ctx, 'reaction-roles', 'panel-delete', 'Delete panel', { messageId: panel.messageId })}`;
            return section(`Panel ${panel.messageId}`, body);
        })}`;
    },

    actions: {
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
