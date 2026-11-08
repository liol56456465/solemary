// birthdays.js — Birthdays: announcement channel, time zone and the birthday role.
// Writes go through birthdayService.updateBirthdaySettings (also used by
// /birthday setchannel). The birthday role was read by the bot but could not be set
// anywhere before (audit finding): it is set here.

import { html } from '../html.js';
import { PERMS, autoRoleField, buttonForm, channelField, channelPicker, postForm, rolePicker, text, textInput } from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { DEFAULT_TIMEZONE } from '../../../utils/timezone.js';
import { changedOnly, section } from './common.js';
import { textFor } from '../language.js';
import { requireCanAct, managerActions } from './serverScope.js';

// Words: src/content/dashboard/<lang>/birthdays.json.

async function load(ctx) {
    const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
    return {
        channelId: config.birthdayChannelId || null,
        timezone: config.birthdayTimezone || DEFAULT_TIMEZONE,
        roleId: config.birthdayRoleId || null,
    };
}

export default {
    key: 'birthdays',
    label: 'Birthdays',
    state: 'birthdays',
    help: 'Mewvo wishes members a happy birthday in a channel on their birthday, and can give them a special role for that day. Members add their own birthday with /birthday set in Discord.',

    load,

    render(ctx, b) {
        const g = ctx.guild;
        const tr = textFor(ctx);
        const status = b.channelId
            ? html`<p>${tr.tx('birthdays.status.on', { state: html`<span class="state state-on">${tr.t('forms.pillOn')}</span>` })}</p>${buttonForm(ctx, 'birthdays', 'off', tr.t('birthdays.status.turnOff'))}`
            : html`<p>${tr.tx('birthdays.status.off', { state: html`<span class="state state-off">${tr.t('forms.pillOff')}</span>` })}</p>`;
        const form = postForm(ctx, 'birthdays', 'settings', html`<div class="grid">
${channelPicker(g, 'channelId', b.channelId, { label: tr.t('birthdays.settings.channel'), perms: PERMS.post, noneLabel: tr.t('birthdays.settings.channelNone'), help: tr.t('birthdays.settings.channelHelp') })}
${textInput('timezone', b.timezone, { label: tr.t('birthdays.settings.timezone'), max: 64, help: tr.t('birthdays.settings.timezoneHelp') })}
${rolePicker(g, 'roleId', b.roleId, { label: tr.t('birthdays.settings.role'), autoAssign: true, noneLabel: tr.t('birthdays.settings.roleNone'), help: tr.t('birthdays.settings.roleHelp') })}</div>`);
        return html`${section(tr.t('birthdays.status.title'), status, '', { key: 'status' })}${section(tr.t('birthdays.settings.title'), form, '', { key: 'settings' })}`;
    },

    actions: managerActions(['settings', 'off'], {
        async settings(ctx, form) {
            const tr = textFor(ctx);
            const current = await load(ctx);
            // A field absent from the form stays unchanged (Setup step by step sends only the channel).
            const patch = changedOnly({
                ...(form.channelId !== undefined ? { channelId: channelField(ctx.guild, form, 'channelId', { label: tr.t('birthdays.settings.channel') }) } : {}),
                ...(form.timezone !== undefined ? { timezone: text(form, 'timezone', 64) || DEFAULT_TIMEZONE } : {}),
                ...(form.roleId !== undefined ? { roleId: autoRoleField(ctx.guild, form, 'roleId', { label: tr.t('birthdays.settings.role') }) } : {}),
            }, current);
            if (!Object.keys(patch).length) return { changes: [], message: tr.t('errors.nothingChanged') };
            // The birthday role is given by the bot: changing it needs Administrator (the channel and time zone do not).
            if (Object.hasOwn(patch, 'roleId')) requireCanAct(ctx, tr.t('birthdays.roleNeedsAdmin'), 'roleId');
            const { before, after } = await ctx.services.updateBirthdaySettings(ctx.client, ctx.guildId, patch);
            const changes = diffSnapshots(before, after);
            return { changes, message: tr.t(changes.length ? 'birthdays.action.saved' : 'errors.nothingChanged') };
        },
        async off(ctx) {
            const { before, after } = await ctx.services.updateBirthdaySettings(ctx.client, ctx.guildId, { channelId: null });
            const changes = diffSnapshots(before, after);
            return { changes, message: textFor(ctx).t('birthdays.action.off') };

        },
    }),
};
