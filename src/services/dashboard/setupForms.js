// setupForms.js — the small form each step of "Setup step by step" shows on the page itself.
//
// No save logic of its own: every form posts to the module's existing save route
// (POST /dashboard/<module>/<action>, with its CSRF, Origin, Administrator and validation
// checks) and comes back with back=setup&step=<key>. Each form sends only its one field:
// those actions leave a field that is absent from the form unchanged, so nothing else is
// touched (no stale hidden copies of other settings). Steps that need several settings at
// once (tickets, welcome, verification) keep the link to their page.

import { PERMS, channelPicker, postForm, rolePicker } from './forms.js';
import { registryGuildId, registryValue } from './modules/common.js';

const REGISTRY_KEYS = ['modLogChannelId', 'appealsCategoryId', 'reviewChannelId', 'alertsChannelId', 'mutedRoleId', 'bannedRoleId'];

const roleIdOf = (value) => (value && typeof value === 'object' ? value.id || null : value || null);

/** The current values the pickers preselect: registry values, the guild config and the log channels. Read per request. */
export async function setupStepData(ctx) {
    const registry = {};
    for (const key of REGISTRY_KEYS) registry[key] = registryValue(ctx, key) ?? null;
    const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
    const supportId = registryGuildId(ctx, 'bannedRoleId'); // null outside Mewvo's own servers
    return {
        registry,
        config: config || {},
        logChannels: config?.logging?.channels || {},
        supportGuild: supportId ? ctx.client?.guilds?.cache?.get(supportId) || null : null,
    };
}

/**
 * The step's form, or null (the page then shows the link to the setting's page).
 * `data` from setupStepData (null = could not be read: links only).
 */
export function setupStepForm(ctx, step, data) {
    if (!ctx?.guild || !data || !step?.key) return null;
    const g = ctx.guild;
    const r = data.registry;
    const canAdmin = ctx.canEdit && ctx.canAct;
    const form = (module, action, fields, opts = {}) => postForm(ctx, module, action, fields, { hidden: { back: 'setup', step: step.key }, canEdit: ctx.canEdit, ...opts });
    switch (step.key) {
        case 'modLog':
            return form('enforcement', 'channels', channelPicker(g, 'modLogChannelId', r.modLogChannelId, { label: step.label, perms: PERMS.post }));
        case 'appeals':
            return form('enforcement', 'channels', channelPicker(g, 'appealsCategoryId', r.appealsCategoryId, { label: step.label, kinds: ['category'], perms: PERMS.category }));
        case 'review':
            return form('automod', 'channels', channelPicker(g, 'reviewChannelId', r.reviewChannelId, { label: step.label }));
        case 'alerts':
            return form('automod', 'channels', channelPicker(g, 'alertsChannelId', r.alertsChannelId, { label: step.label }));
        case 'muted':
            return form('enforcement', 'roles', rolePicker(g, 'mutedRoleId', r.mutedRoleId, { label: step.label }));
        case 'logChannel':
            return form('logging', 'channels', channelPicker(g, 'audit', data.logChannels.audit || null, { label: step.label, perms: PERMS.post }));
        case 'modRole':
            return form('commands', 'bot-settings', rolePicker(g, 'modRole', roleIdOf(data.config.modRole), { label: step.label, assign: false }), { canEdit: canAdmin });
        case 'birthdays':
            return form('birthdays', 'settings', channelPicker(g, 'channelId', data.config.birthdayChannelId || null, { label: step.label, perms: PERMS.post }));
        case 'bannedRole':
            return data.supportGuild ? form('support', 'banned-role', rolePicker(data.supportGuild, 'bannedRoleId', r.bannedRoleId, { label: step.label })) : null;
        case 'appealPanel':
            return form('enforcement', 'appeal-panels', channelPicker(g, 'channelId', null, { label: 'Channel for the appeal panel', perms: PERMS.post, optional: false }),
                { submit: step.done ? 'Post the appeal panels again' : 'Post the appeal panels', canEdit: canAdmin, confirm: 'Post the appeal panels now? Earlier appeal panels in these channels are replaced.' });
        default:
            return null;
    }
}
