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
    help: 'Mewvo wishes members a happy birthday in a channel on their birthday, and can give them a special role for that day. Members add their own birthday with /birthday set in Discord.',

    load,

    render(ctx, b) {
        const g = ctx.guild;
        const status = b.channelId
            ? html`<p>Announcements are <span class="state state-on">on</span>.</p>${buttonForm(ctx, 'birthdays', 'off', 'Turn off (clear the channel)')}`
            : html`<p>Announcements are <span class="state state-off">off</span>. Pick a channel below to turn them on.</p>`;
        const form = postForm(ctx, 'birthdays', 'settings', html`<div class="grid">
${channelPicker(g, 'channelId', b.channelId, { label: 'Announcement channel', perms: PERMS.post, noneLabel: 'off', help: 'Where the birthday message is posted.' })}
${textInput('timezone', b.timezone, { label: 'Time zone', max: 64, help: 'Birthdays start at midnight in this time zone. Write it as region and city, like Europe/London or America/New_York.' })}
${rolePicker(g, 'roleId', b.roleId, { label: 'Birthday role', autoAssign: true, noneLabel: 'none', help: 'Given on the birthday and taken away the next day.' })}</div>`);
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
