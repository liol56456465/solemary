// verification.js — Verification (button panel) and auto-verify. Writes go through
// services/verificationSettingsService.js (row-locked), shared with /verification.
// Setting up and (re)posting the panel go through services/verificationPanelService.js,
// as /verification setup and /verification dashboard do (Administrators only).

import { botConfig } from '../../../config/bot.js';
import { html } from '../html.js';
import {
    InputError, PERMS, autoRoleField, boolField, buttonForm, channelField, channelName, channelPicker, choiceField, intField, numberInput, postForm, rolePicker,
    selectInput, text, textArea, textInput, toggleForm, channelWarnings,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, registryValue, saveRegistry, section } from './common.js';

const CRITERIA = [['none', 'Everyone'], ['account_age', 'Account older than N days'], ['server_size', 'Server size']];

async function update(ctx, patch, message) {
    if (!Object.keys(patch).length) return NOTHING;
    const { before, after } = await ctx.services.updateVerificationSettings(ctx.client, ctx.guildId, patch);
    const changes = [
        ...diffSnapshots(before, after, Object.keys(patch).filter((k) => k !== 'autoVerify'), 'verification.'),
        ...(patch.autoVerify ? diffSnapshots(before?.autoVerify || {}, after?.autoVerify || {}, Object.keys(patch.autoVerify), 'verification.autoVerify.') : []),
    ];
    return { changes, message: changes.length ? message : 'Nothing changed.' };
}

async function autoRoleConfigured(ctx) {
    const [config, welcome] = await Promise.all([
        ctx.services.getGuildConfig(ctx.client, ctx.guildId),
        ctx.services.getWelcomeSettings(ctx.client, ctx.guildId),
    ]);
    return Boolean(config.autoRole) || (Array.isArray(welcome.roleIds) && welcome.roleIds.length > 0);
}

export default {
    key: 'verification',
    label: 'Verification',
    state: 'verification',
    help: 'New members press a button (or verify with Discord) to get the verified role; auto-verify gives it on join instead. The two cannot run together.',

    async load(ctx) {
        return {
            v: await ctx.services.getVerificationSettings(ctx.client, ctx.guildId),
            redirect: registryValue(ctx, 'verifySuccessRedirect'),
        };
    },

    render(ctx, { v, redirect }) {
        const g = ctx.guild;
        const auto = v.autoVerify || {};
        const canPost = ctx.canEdit && ctx.canAct;
        const panel = v.channelId
            ? html`<div class="panel-row"><p>Panel in ${channelName(g, v.channelId)}${channelWarnings(g, v.channelId, PERMS.post).map((w) => html` <span class="field-warn">${w}</span>`)}.</p>
${buttonForm(ctx, 'verification', 'panel-publish', 'Update or re-post the panel', {}, { danger: false, canEdit: canPost })}</div>`
            : html`<p class="warn">No verification panel yet.</p>${postForm(ctx, 'verification', 'setup', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: 'Post the panel in', perms: PERMS.post, optional: false })}
${rolePicker(g, 'roleId', null, { label: 'Verified role', autoAssign: true, optional: false })}
${textInput('buttonText', botConfig.verification?.defaultButtonText || 'Verify', { label: 'Button text', max: 80 })}
${textArea('message', botConfig.verification?.defaultMessage || '', { label: 'Panel message', max: 2000 })}</div>`, { submit: 'Set up and post the panel', canEdit: canPost })}`;
        const manual = html`${toggleForm(ctx, 'verification', 'enabled', v.enabled === true, { label: 'Verification' })}${panel}
${postForm(ctx, 'verification', 'settings', html`<div class="grid">
${rolePicker(g, 'roleId', v.roleId || null, { label: 'Verified role', autoAssign: true, optional: false })}
${textInput('buttonText', v.buttonText || botConfig.verification?.defaultButtonText || 'Verify', { label: 'Button text', max: 80 })}
${textArea('message', v.message || botConfig.verification?.defaultMessage || '', { label: 'Panel message', max: 2000 })}</div>`)}
<p class="muted">Saved text shows on the live panel after "Update or re-post the panel".</p>`;
        const autoForm = html`${toggleForm(ctx, 'verification', 'auto-enabled', auto.enabled === true, { label: 'Auto-verify' })}
${postForm(ctx, 'verification', 'auto', html`<div class="grid">
${selectInput('criteria', auto.criteria || 'none', CRITERIA, { label: 'Who is auto-verified' })}
${numberInput('accountAgeDays', auto.accountAgeDays ?? '', { label: 'Account age (days, for "account older than")', min: 1, max: 365 })}
${rolePicker(g, 'autoRoleId', auto.roleId || null, { label: 'Role given', autoAssign: true, noneLabel: 'the verified role' })}</div>`)}`;
        const web = postForm(ctx, 'verification', 'redirect', textInput('verifySuccessRedirect', redirect, { label: 'Page after "Verify with Discord"', max: 500, placeholder: 'https://…' }), { inline: true });
        return html`${section('Verification panel', manual)}${section('Auto-verify', autoForm)}${section('Web verification', web)}`;
    },

    actions: {
        setup: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const channelId = channelField(g, form, 'channelId', { optional: false, label: 'Panel channel' });
                const roleId = autoRoleField(g, form, 'roleId', { optional: false, label: 'Verified role' });
                const before = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
                if (before.channelId) throw new InputError('The verification panel is already set up: use "Update or re-post the panel".');
                const { settings } = await ctx.services.setupVerification(ctx.client, g, {
                    channel: g.channels.cache.get(channelId), role: g.roles.cache.get(roleId),
                    message: text(form, 'message', 2000), buttonText: text(form, 'buttonText', 80),
                });
                return {
                    changes: ['enabled', 'channelId', 'roleId', 'message', 'buttonText'].map((key) => ({ key: `verification.${key}`, old: before[key] ?? null, new: settings[key] ?? null })),
                    message: 'Verification set up: the panel is posted and verification is on.',
                };
            },
        },
        'panel-publish': {
            admin: true,
            async run(ctx) {
                const { action, message } = await ctx.services.publishVerificationPanel(ctx.client, ctx.guild);
                return {
                    changes: [{ key: 'verification.panel', old: null, new: action === 'posted' ? { posted: message?.id || true } : { updated: true } }],
                    message: action === 'posted' ? 'The panel was missing: a new one is posted.' : 'The live panel now shows the saved text.',
                };
            },
        },
        async enabled(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Verification');
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            if (enabled && v.autoVerify?.enabled) throw new InputError('Auto-verify is on. Turn auto-verify off before turning the verification panel on.');
            if (enabled && !v.channelId) throw new InputError('The verification panel is not set up yet: set it up first.');
            const result = await update(ctx, { enabled }, `Verification is now ${enabled ? 'on' : 'off'}.`);
            result.warnings = ['Turning it on or off does not post or remove the panel message: use "Update or re-post the panel" when needed.'];
            return result;
        },
        async settings(ctx, form) {
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            const buttonText = text(form, 'buttonText', 80);
            const message = text(form, 'message', 2000);
            if (!buttonText) throw new InputError('Button text cannot be empty.');
            if (!message) throw new InputError('The panel message cannot be empty.');
            return update(ctx, changedOnly({
                roleId: autoRoleField(ctx.guild, form, 'roleId', { optional: false, label: 'Verified role' }),
                buttonText,
                message,
            }, v), 'Verification settings saved.');
        },
        async 'auto-enabled'(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Auto-verify');
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            if (enabled) {
                const blocking = [];
                if (v.enabled) blocking.push('the verification panel is on');
                if (await autoRoleConfigured(ctx)) blocking.push('auto roles are configured (Welcome & goodbye)');
                if (blocking.length) throw new InputError(`To turn auto-verify on, first turn off: ${blocking.join(', ')}.`);
            }
            return update(ctx, { autoVerify: { enabled } }, `Auto-verify is now ${enabled ? 'on' : 'off'}.`);
        },
        async auto(ctx, form) {
            const v = await ctx.services.getVerificationSettings(ctx.client, ctx.guildId);
            const criteria = choiceField(form, 'criteria', CRITERIA.map(([c]) => c), 'Criteria');
            const accountAgeDays = intField(form, 'accountAgeDays', { min: 1, max: 365, label: 'Account age', fallback: null });
            ctx.services.validateAutoVerifyCriteria(criteria, accountAgeDays);
            const roleId = autoRoleField(ctx.guild, form, 'autoRoleId', { label: 'Auto-verify role' });
            const patch = changedOnly({ criteria, accountAgeDays: criteria === 'account_age' ? accountAgeDays : null, roleId }, v.autoVerify || {});
            if (!Object.keys(patch).length) return NOTHING;
            return update(ctx, { autoVerify: patch }, 'Auto-verify settings saved.');
        },
        async redirect(ctx, form) {
            const value = text(form, 'verifySuccessRedirect', 500);
            if (value === registryValue(ctx, 'verifySuccessRedirect')) return NOTHING;
            return saveRegistry(ctx, { verifySuccessRedirect: value }, 'verification');
        },
    },
};
