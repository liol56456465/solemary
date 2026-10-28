// support.js — Support server (owner decision 6): the banned role members with an
// active main-server ban get in the support server, where they appeal. Stored in
// guild_settings on the support server's row (settings service).

import { html, path } from '../html.js';
import { postForm, roleField, rolePicker } from '../forms.js';
import { registryGuildId, registryValue, saveRegistry, section, NOTHING } from './common.js';

export default {
    key: 'support',
    label: 'Support server',
    help: 'The support server is where banned members appeal. Its invite is set on Enforcement & appeals.',

    async load(ctx) {
        const supportGuildId = registryGuildId('bannedRoleId', ctx.env);
        return {
            supportGuildId,
            supportGuild: supportGuildId ? ctx.client?.guilds?.cache?.get(supportGuildId) || null : null,
            bannedRoleId: registryValue(ctx, 'bannedRoleId'),
            invite: registryValue(ctx, 'supportServerInvite'),
        };
    },

    render(ctx, d) {
        if (!d.supportGuildId) return section('Support server', html`<p class="warn">SUPPORT_GUILD_ID is not set, so there is no support server.</p>`);
        const form = d.supportGuild
            ? postForm(ctx, 'support', 'banned-role', rolePicker(d.supportGuild, 'bannedRoleId', d.bannedRoleId, { label: 'Banned role (support server)', help: 'Given to members with an active ban in the main server; removed when the ban ends.' }))
            : html`<p class="warn">The bot is not in the support server (or it is not cached), so its roles can't be listed.</p>`;
        return html`${section(d.supportGuild ? `Support server · ${d.supportGuild.name}` : 'Support server', html`${form}
<p class="muted">Invite sent to banned members: ${d.invite || 'not set'} — <a href="${path('/enforcement')}">change on Enforcement &amp; appeals</a>.</p>`)}`;
    },

    actions: {
        async 'banned-role'(ctx, form) {
            const supportGuildId = registryGuildId('bannedRoleId', ctx.env);
            const supportGuild = supportGuildId ? ctx.client?.guilds?.cache?.get(supportGuildId) : null;
            const bannedRoleId = roleField(supportGuild, form, 'bannedRoleId', { label: 'Banned role' });
            if (bannedRoleId === registryValue(ctx, 'bannedRoleId')) return NOTHING;
            return saveRegistry(ctx, { bannedRoleId }, 'support');
        },
    },
};
