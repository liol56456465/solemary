// reactionRoles.js — Reaction role panels: create a panel (posted by the bot), add or
// remove a role, delete a panel. Everything goes through services/reactionRoleService.js
// (role safety, bot permissions, row-locked panel data, rebuilds the live message), the
// same functions /reactroles setup and /reactroles dashboard use.

import { html } from '../html.js';
import {
    InputError, PERMS, buttonForm, channelField, channelName, channelPicker, isSnowflake, list, postForm, rolePicker, roleName,
    roleWarnings, selectInput, text, textArea, textInput,
} from '../forms.js';
import { section, table } from './common.js';
import { MAX_PANELS_PER_GUILD, PANEL_DESCRIPTION_MAX, PANEL_TITLE_MAX } from '../../reactionRoleService.js';
import { textFor } from '../language.js';

// Words: src/content/dashboard/<lang>/reactionRoles.json.

// Ready-made panels (owner, 2026-11-10): languages, hobbies, identity. A preset only fills the
// title and description the admin left empty, in the dashboard's language.
export const PANEL_PRESETS = Object.freeze(['language', 'hobbies', 'identity']);

/**
 * The server's Discord onboarding questions that give roles: [{ id, title, roleIds }].
 * Empty when onboarding is off or cannot be read (never an error for the page).
 */
export async function onboardingPrompts(guild) {
    try {
        const onboarding = await guild?.fetchOnboarding?.();
        if (!onboarding?.prompts) return [];
        return [...onboarding.prompts.values()].map((prompt) => ({
            id: String(prompt.id),
            title: String(prompt.title || '').slice(0, 100),
            roleIds: [...new Set([...prompt.options.values()].flatMap((option) => [...(option.roles?.keys?.() || [])]))],
        })).filter((prompt) => prompt.roleIds.length);
    } catch {
        return [];
    }
}

/** Title, description and roles for a new panel after the preset and onboarding choice. Pure. */
export function resolvePanelInput({ title, description, roleIds, preset, promptRoleIds = null }, tr) {
    const known = PANEL_PRESETS.includes(preset) ? preset : null;
    return {
        title: title || (known ? tr.t(`reactionRoles.presets.${known}.title`) : ''),
        description: description || (known ? tr.t(`reactionRoles.presets.${known}.description`) : ''),
        // An onboarding question chosen: only its roles (the panel matches onboarding).
        roleIds: promptRoleIds ? promptRoleIds : roleIds,
    };
}

function messageIdField(ctx, form) {
    const id = text(form, 'messageId', 25);
    if (!isSnowflake(id)) throw new InputError(textFor(ctx).t('reactionRoles.action.unknownPanel'));
    return id;
}

export default {
    key: 'reaction-roles',
    label: 'Reaction roles',
    help: 'Let members pick their own roles, like colours, pronouns or games. Mewvo posts a message (a panel) with a menu, and members choose the roles they want from it. Mewvo only offers roles below its own role in the role list, never roles with staff powers, and never roles that belong to another bot or app.',

    async load(ctx) {
        const [panels, prompts] = await Promise.all([
            ctx.services.getAllReactionRoleMessages(ctx.client, ctx.guildId),
            onboardingPrompts(ctx.guild),
        ]);
        return { panels, prompts };
    },

    render(ctx, { panels, prompts = [] }) {
        const g = ctx.guild;
        const tr = textFor(ctx);
        const canPost = ctx.canEdit && ctx.canAct;
        const create = panels.length >= MAX_PANELS_PER_GUILD
            ? html`<p class="muted">${tr.tx('reactionRoles.create.max', { count: tr.fmtNumber(MAX_PANELS_PER_GUILD) })}</p>`
            : postForm(ctx, 'reaction-roles', 'panel-create', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: tr.t('reactionRoles.create.postIn'), perms: PERMS.post, optional: false, help: tr.t('reactionRoles.create.postInHelp') })}
${selectInput('preset', '', [['', tr.t('reactionRoles.presets.none')], ...PANEL_PRESETS.map((key) => [key, tr.t(`reactionRoles.presets.${key}.name`)])], { label: tr.t('reactionRoles.presets.label'), help: tr.t('reactionRoles.presets.help') })}
${prompts.length ? selectInput('promptId', '', [['', tr.t('reactionRoles.presets.onboardingNone')], ...prompts.map((p) => [p.id, p.title])], { label: tr.t('reactionRoles.presets.onboarding'), help: tr.t('reactionRoles.presets.onboardingHelp') }) : ''}
${textInput('title', '', { label: tr.t('reactionRoles.create.titleLabel'), max: PANEL_TITLE_MAX, help: tr.t('reactionRoles.create.titleHelp') })}
${textArea('description', '', { label: tr.t('reactionRoles.create.description'), max: PANEL_DESCRIPTION_MAX, rows: 3, help: tr.t('reactionRoles.create.descriptionHelp') })}
${rolePicker(g, 'roleIds', [], { label: tr.t('reactionRoles.create.roles'), autoAssign: true, multiple: true, help: tr.t('reactionRoles.create.rolesHelp') })}</div>`,
            { submit: tr.t('reactionRoles.create.submit'), canEdit: canPost });
        const existing = panels.map((panel) => {
            const roles = Array.isArray(panel.roles) ? panel.roles : Object.values(panel.roles || {});
            const rows = roles.map((roleId) => [roleName(g, roleId), roleWarnings(g, roleId, { autoAssign: true }).join('; ') || html`<span class="ok">${tr.t('reactionRoles.panel.ok')}</span>`,
                buttonForm(ctx, 'reaction-roles', 'role-remove', tr.t('reactionRoles.panel.remove'), { messageId: panel.messageId, roleId }, { canEdit: canPost })]);
            const body = html`<p>${tr.tx('reactionRoles.panel.info', { channel: channelName(g, panel.channelId), message: html`<code>${panel.messageId}</code>`, count: tr.fmtNumber(roles.length) })}</p>
${table([tr.t('reactionRoles.panel.role'), tr.t('reactionRoles.panel.problems'), ''], rows, tr.t('reactionRoles.panel.noRoles'))}
<div class="row-actions">${postForm(ctx, 'reaction-roles', 'role-add', rolePicker(g, 'roleId', null, { label: tr.t('reactionRoles.panel.addRole'), optional: false, autoAssign: true }), { submit: tr.t('reactionRoles.panel.add'), inline: true, hidden: { messageId: panel.messageId }, canEdit: canPost })}
${buttonForm(ctx, 'reaction-roles', 'panel-delete', tr.t('reactionRoles.panel.delete'), { messageId: panel.messageId }, { confirm: tr.t('reactionRoles.panel.deleteConfirm'), canEdit: canPost })}</div>`;
            // Explicit keys: the card ids stay the English slugs in every language.
            return section(tr.t('reactionRoles.panel.title', { id: panel.messageId }), body, '', { key: `panel-${panel.messageId}` });
        });
        return html`${section(tr.t('reactionRoles.create.title'), create, `${tr.t('reactionRoles.create.help')}${ctx.canAct ? '' : tr.t('reactionRoles.create.needsAdmin')}`, { key: 'new-panel' })}
${existing.length ? existing : section(tr.t('reactionRoles.panels.title'), html`<p class="muted">${tr.tx('reactionRoles.panels.empty')}</p>`, '', { key: 'panels' })}`;
    },

    actions: {
        'panel-create': {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const tr = textFor(ctx);
                const channelId = channelField(g, form, 'channelId', { optional: false, label: tr.t('reactionRoles.create.postIn') });
                const promptId = text(form, 'promptId', 25);
                let promptRoleIds = null;
                if (promptId) {
                    const prompt = (await onboardingPrompts(g)).find((p) => p.id === promptId);
                    promptRoleIds = (prompt?.roleIds || []).slice(0, 25);
                    if (!promptRoleIds.length) throw new InputError(tr.t('reactionRoles.action.onboardingEmpty'));
                }
                const input = resolvePanelInput({
                    title: text(form, 'title', PANEL_TITLE_MAX + 1), description: text(form, 'description', PANEL_DESCRIPTION_MAX + 1),
                    roleIds: list(form, 'roleIds', { max: 25 }).filter(isSnowflake), preset: text(form, 'preset', 20), promptRoleIds,
                }, tr);
                const roleIds = input.roleIds;
                if (!roleIds.length) throw new InputError(tr.t('reactionRoles.action.chooseRole'));
                const { message, roles, rejected } = await ctx.services.createReactionRolePanel(ctx.client, g, {
                    channel: g.channels.cache.get(channelId), title: input.title,
                    description: input.description, roleIds,
                    actorId: ctx.actor.userId, actorTag: `${ctx.actor.username} (dashboard)`,
                });
                return {
                    changes: [{ key: `panel.${message.id}`, old: null, new: { channelId, roles: roles.map((r) => r.id) } }],
                    message: tr.tp('reactionRoles.action.posted', roles.length),
                    warnings: rejected.length ? [tr.t('reactionRoles.action.skipped', { list: rejected.join('; ') })] : [],
                };
            },
        },
        // Administrator only: roles members can give themselves.
        'role-add': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const messageId = messageIdField(ctx, form);
                const roleId = text(form, 'roleId', 25);
                if (!isSnowflake(roleId) || !ctx.guild?.roles?.cache?.get(roleId)) throw new InputError(tr.t('reactionRoles.action.roleMissing'));
                const before = await ctx.services.getAllReactionRoleMessages(ctx.client, ctx.guildId).then((p) => p.find((x) => x.messageId === messageId));
                const { panel } = await ctx.services.addPanelRole(ctx.client, ctx.guildId, messageId, roleId);
                return { changes: [{ key: `panel.${messageId}.roles`, old: before?.roles || [], new: panel.roles }], message: tr.t('reactionRoles.action.roleAdded') };
            },
        },
        // Administrator only: roles members can give themselves.
        'role-remove': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const messageId = messageIdField(ctx, form);
                const roleId = text(form, 'roleId', 25);
                if (!isSnowflake(roleId)) throw new InputError(tr.t('reactionRoles.action.unknownRole'));
                const { panel, deletedPanel } = await ctx.services.removePanelRole(ctx.client, ctx.guildId, messageId, roleId);
                const old = [...(panel?.roles || []), roleId];
                return {
                    changes: [{ key: `panel.${messageId}.roles`, old, new: deletedPanel ? null : panel.roles }],
                    message: tr.t(deletedPanel ? 'reactionRoles.action.lastRole' : 'reactionRoles.action.roleRemoved'),
                };
            },
        },
        // Administrator only: roles members can give themselves.
        'panel-delete': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const messageId = messageIdField(ctx, form);
                const { deleted, panel } = await ctx.services.deletePanel(ctx.client, ctx.guildId, messageId, { actorId: ctx.actor.userId, actorTag: `${ctx.actor.username} (dashboard)` });
                if (!deleted) throw new InputError(tr.t('reactionRoles.action.panelGone'));
                return { changes: [{ key: `panel.${messageId}`, old: panel?.roles || null, new: null }], message: tr.t('reactionRoles.action.panelDeleted') };
            },
        },
    },
};
