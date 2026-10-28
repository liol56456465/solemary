// birthdays.js — Birthdays: announcement channel, time zone and the birthday role.
// Writes go through birthdayService.updateBirthdaySettings (also used by
// /birthday setchannel). The birthday role was read by the bot but could not be set
// anywhere before (audit finding): it is set here.

import { html } from '../html.js';
import { PERMS, autoRoleField, buttonForm, channelField, channelPicker, postForm, rolePicker, text, textInput } from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { DEFAULT_TIMEZONE } from '../../../utils/timezone.js';
import { NOTHING, changedOnly, section } from './common.js';

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
    help: 'Birthday announcements once per local day in the server time zone, plus an optional role for the day. Members add their birthday with /birthday set.',

    load,

    render(ctx, b) {
        const g = ctx.guild;
        const status = b.channelId
            ? html`<p>Announcements are <span class="state state-on">on</span>.</p>${buttonForm(ctx, 'birthdays', 'off', 'Turn off (clear the channel)')}`
            : html`<p>Announcements are <span class="state state-off">off</span>: pick a channel to turn them on.</p>`;
        const form = postForm(ctx, 'birthdays', 'settings', html`<div class="grid">
${channelPicker(g, 'channelId', b.channelId, { label: 'Announcement channel', perms: PERMS.post, noneLabel: 'off' })}
${textInput('timezone', b.timezone, { label: 'Time zone (IANA, e.g. Europe/London)', max: 64 })}
${rolePicker(g, 'roleId', b.roleId, { label: 'Birthday role (given for the day)', autoAssign: true, noneLabel: 'none' })}</div>`);
        return html`${section('Status', status)}${section('Settings', form)}`;
    },

    actions: {
        async settings(ctx, form) {
            const current = await load(ctx);
            const patch = changedOnly({
                channelId: channelField(ctx.guild, form, 'channelId', { label: 'Announcement channel' }),
                timezone: text(form, 'timezone', 64) || DEFAULT_TIMEZONE,
                roleId: autoRoleField(ctx.guild, form, 'roleId', { label: 'Birthday role' }),
            }, current);
            if (!Object.keys(patch).length) return NOTHING;
            const { before, after } = await ctx.services.updateBirthdaySettings(ctx.client, ctx.guildId, patch);
            const changes = diffSnapshots(before, after);
            return { changes, message: changes.length ? 'Birthday settings saved.' : 'Nothing changed.' };
        },
        async off(ctx) {
            const { before, after } = await ctx.services.updateBirthdaySettings(ctx.client, ctx.guildId, { channelId: null });
            const changes = diffSnapshots(before, after);
            return { changes, message: 'Birthday announcements are off.' };
        },
    },
};
