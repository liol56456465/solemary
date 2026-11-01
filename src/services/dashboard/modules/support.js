// support.js — Support server (owner decision 6): the banned role members with an
// active main-server ban get in the support server, where they appeal, and the category
// their ban/kick appeal channels open in (they are added; staff use a private thread).
// Stored in guild_settings on the support server's row (settings service).

import { html, path } from '../html.js';
import { PERMS, channelField, channelPicker, postForm, roleField, rolePicker } from '../forms.js';
import { registryGuildId, registryValue, saveRegistry, section, NOTHING } from './common.js';

export default {
    key: 'support',
    label: 'Support server',
    help: 'A second Discord server that banned members can still join. They ask for their ban to be lifted (appeal) there, because they cannot reach your main server. The invite link to it is set on Enforcement & appeals.',

    async load(ctx) {
        const supportGuildId = registryGuildId('bannedRoleId', ctx.env);
        return {
            supportGuildId,
            supportGuild: supportGuildId ? ctx.client?.guilds?.cache?.get(supportGuildId) || null : null,
            bannedRoleId: registryValue(ctx, 'bannedRoleId'),
            supportAppealsCategoryId: registryValue(ctx, 'supportAppealsCategoryId'),
            invite: registryValue(ctx, 'supportServerInvite'),
        };
    },

    render(ctx, d) {
        if (!d.supportGuildId) return section('Support server', html`<p class="warn">No support server is connected yet. The bot owner has to set one up first.</p>`);
        const form = d.supportGuild
            ? postForm(ctx, 'support', 'banned-role', rolePicker(d.supportGuild, 'bannedRoleId', d.bannedRoleId, { label: 'Banned role (support server)', help: 'Members who are banned from the main server get this role in the support server. Mewvo takes it away when the ban ends.' }))
            : html`<p class="warn">Mewvo cannot see the support server right now, so its roles cannot be listed. Check that Mewvo is a member there.</p>`;
        const appeals = d.supportGuild
            ? postForm(ctx, 'support', 'appeals-category', channelPicker(d.supportGuild, 'supportAppealsCategoryId', d.supportAppealsCategoryId, {
                label: 'Ban and kick appeals category', kinds: ['category'], perms: PERMS.category,
                help: 'A category is a folder of channels. Each ban or kick appeal gets a channel here where the member can talk to staff. Staff decide in a staff-only channel in the main server. Not set: appeals open staff-only in the main server.',
            }))
            : '';
        return html`${section(d.supportGuild ? `Support server · ${d.supportGuild.name}` : 'Support server', html`${form}${appeals}
<p class="muted">Invite link sent to banned members: ${d.invite || 'not set'}. You can <a href="${path('/enforcement')}">change it on Enforcement &amp; appeals</a>.</p>`)}`;
    },

    actions: {
        async 'banned-role'(ctx, form) {
            const supportGuildId = registryGuildId('bannedRoleId', ctx.env);
            const supportGuild = supportGuildId ? ctx.client?.guilds?.cache?.get(supportGuildId) : null;
            const bannedRoleId = roleField(supportGuild, form, 'bannedRoleId', { label: 'Banned role' });
            if (bannedRoleId === registryValue(ctx, 'bannedRoleId')) return NOTHING;
            return saveRegistry(ctx, { bannedRoleId }, 'support');
        },
        async 'appeals-category'(ctx, form) {
            const supportGuildId = registryGuildId('supportAppealsCategoryId', ctx.env);
            const supportGuild = supportGuildId ? ctx.client?.guilds?.cache?.get(supportGuildId) : null;
            const supportAppealsCategoryId = channelField(supportGuild, form, 'supportAppealsCategoryId', { kinds: ['category'], label: 'Ban and kick appeals category' });
            if (supportAppealsCategoryId === registryValue(ctx, 'supportAppealsCategoryId')) return NOTHING;
            return saveRegistry(ctx, { supportAppealsCategoryId }, 'support');
        },
    },
};
