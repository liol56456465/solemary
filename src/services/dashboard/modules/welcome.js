// welcome.js — Welcome & goodbye: messages and channels, auto roles, join/leave logs.
// Writes go through services/welcomeService.js (row-locked), shared with /greet,
// /welcome, /goodbye and /autorole. Embeds and images are edited in Discord (/greet).

import { html } from '../html.js';
import {
    PERMS, autoRoleField, boolField, buttonForm, channelField, channelPicker, checkbox, switchInput, intField,
    numberInput, postForm, rolePicker, roleName, text, textArea, toggleForm, roleWarnings,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, section, table } from './common.js';

const KEYS = ['enabled', 'channelId', 'welcomeMessage', 'welcomePing', 'dmMessage', 'goodbyeEnabled', 'goodbyeChannelId',
    'leaveMessage', 'goodbyePing', 'roleIds', 'autoRoleDelay', 'joinLogs', 'leaveLogs'];

async function update(ctx, patch, message) {
    if (!Object.keys(patch).length) return NOTHING;
    const { before, after } = await ctx.services.updateWelcomeSettings(ctx.client, ctx.guildId, patch);
    const changes = diffSnapshots(before, after, Object.keys(patch).filter((k) => KEYS.includes(k)));
    return { changes, message: changes.length ? message : 'Nothing changed.' };
}

export default {
    key: 'welcome',
    label: 'Welcome & goodbye',
    state: 'welcome',
    help: 'Messages when members join and leave, roles given on join, and join/leave logs. Placeholders: {user}, {user.tag}, {server}, {memberCount}. Embeds and images are edited with /greet in Discord.',

    async load(ctx) {
        return { welcome: await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId) };
    },

    render(ctx, { welcome: w }) {
        const g = ctx.guild;
        const welcome = html`${toggleForm(ctx, 'welcome', 'welcome-enabled', w.enabled, { label: 'Welcome messages' })}
${postForm(ctx, 'welcome', 'welcome', html`<div class="grid">
${channelPicker(g, 'channelId', w.channelId, { label: 'Welcome channel', perms: PERMS.postFiles })}
${switchInput('welcomePing', w.welcomePing, { label: 'Ping the member' })}
${textArea('welcomeMessage', w.welcomeMessage, { label: 'Welcome message', max: 2000 })}
${textArea('dmMessage', w.dmMessage, { label: 'DM to the new member (empty = none)', max: 2000 })}</div>`)}`;
        const goodbye = html`${toggleForm(ctx, 'welcome', 'goodbye-enabled', w.goodbyeEnabled, { label: 'Goodbye messages' })}
${postForm(ctx, 'welcome', 'goodbye', html`<div class="grid">
${channelPicker(g, 'goodbyeChannelId', w.goodbyeChannelId, { label: 'Goodbye channel', perms: PERMS.postFiles })}
${switchInput('goodbyePing', w.goodbyePing, { label: 'Ping the member' })}
${textArea('leaveMessage', w.leaveMessage, { label: 'Goodbye message', max: 2000 })}</div>`)}`;
        const roles = html`${table(['Role', 'Problems', ''], (w.roleIds || []).map((id) => [roleName(g, id), roleWarnings(g, id, { autoAssign: true }).join('; ') || html`<span class="ok">ok</span>`,
            buttonForm(ctx, 'welcome', 'autorole-remove', 'Remove', { roleId: id })]), 'No roles are given on join.')}
${postForm(ctx, 'welcome', 'autorole-add', rolePicker(g, 'roleId', null, { label: 'Role given on join', optional: false, autoAssign: true, includeManaged: false }), { submit: 'Set', inline: true })}
${postForm(ctx, 'welcome', 'autorole-delay', html`<div class="grid">${numberInput('autoRoleDelay', w.autoRoleDelay || 0, { label: 'Delay before giving roles (seconds)', min: 0, max: 3600 })}</div>`)}`;
        const logs = postForm(ctx, 'welcome', 'logs', html`<div class="grid">
${switchInput('joinLogsEnabled', w.joinLogs?.enabled, { label: 'Log joins' })}
${channelPicker(g, 'joinLogsChannelId', w.joinLogs?.channelId || null, { label: 'Join log channel', perms: PERMS.post })}
${switchInput('leaveLogsEnabled', w.leaveLogs?.enabled, { label: 'Log leaves' })}
${channelPicker(g, 'leaveLogsChannelId', w.leaveLogs?.channelId || null, { label: 'Leave log channel', perms: PERMS.post })}</div>`);
        return html`${section('Welcome', welcome)}${section('Goodbye', goodbye)}
${section('Auto role', roles, 'One role, as with /autorole: setting a role replaces the current one. Roles with staff permissions or above my highest role are refused.')}
${section('Join and leave logs', logs)}`;
    },

    actions: {
        async 'welcome-enabled'(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Welcome messages');
            return update(ctx, { enabled }, `Welcome messages are ${enabled ? 'on' : 'off'}.`);
        },
        async 'goodbye-enabled'(ctx, form) {
            const goodbyeEnabled = boolField(form, 'enabled', 'Goodbye messages');
            return update(ctx, { goodbyeEnabled }, `Goodbye messages are ${goodbyeEnabled ? 'on' : 'off'}.`);
        },
        async welcome(ctx, form) {
            const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
            return update(ctx, changedOnly({
                channelId: channelField(ctx.guild, form, 'channelId', { label: 'Welcome channel' }),
                welcomePing: checkbox(form, 'welcomePing'),
                welcomeMessage: text(form, 'welcomeMessage', 2000) || current.welcomeMessage,
                dmMessage: text(form, 'dmMessage', 2000),
            }, current), 'Welcome settings saved.');
        },
        async goodbye(ctx, form) {
            const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
            return update(ctx, changedOnly({
                goodbyeChannelId: channelField(ctx.guild, form, 'goodbyeChannelId', { label: 'Goodbye channel' }),
                goodbyePing: checkbox(form, 'goodbyePing'),
                leaveMessage: text(form, 'leaveMessage', 2000) || current.leaveMessage,
            }, current), 'Goodbye settings saved.');
        },
        async 'autorole-add'(ctx, form) {
            const roleId = autoRoleField(ctx.guild, form, 'roleId', { optional: false, label: 'Role' });
            const { before, after, changed } = await ctx.services.addAutoRole(ctx.client, ctx.guildId, roleId);
            if (!changed) return { changes: [], message: 'That role is already given on join.' };
            return { changes: diffSnapshots(before, after, ['roleIds']), message: 'Auto role set.' };
        },
        async 'autorole-remove'(ctx, form) {
            const roleId = text(form, 'roleId', 25);
            const { before, after, changed } = await ctx.services.removeAutoRole(ctx.client, ctx.guildId, roleId);
            if (!changed) return { changes: [], message: 'That role was not an auto role.' };
            return { changes: diffSnapshots(before, after, ['roleIds']), message: 'Auto role removed.' };
        },
        async 'autorole-delay'(ctx, form) {
            const autoRoleDelay = intField(form, 'autoRoleDelay', { min: 0, max: 3600, label: 'Delay' });
            return update(ctx, { autoRoleDelay }, 'Auto role delay saved.');
        },
        async logs(ctx, form) {
            const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
            return update(ctx, changedOnly({
                joinLogs: { enabled: checkbox(form, 'joinLogsEnabled'), channelId: channelField(ctx.guild, form, 'joinLogsChannelId', { label: 'Join log channel' }) },
                leaveLogs: { enabled: checkbox(form, 'leaveLogsEnabled'), channelId: channelField(ctx.guild, form, 'leaveLogsChannelId', { label: 'Leave log channel' }) },
            }, current), 'Join and leave logs saved.');
        },
    },
};
