// support.js — Support server (owner decision 6): the banned role members with an
// active main-server ban get in the support server, where they appeal, and the category
// their ban/kick appeal channels open in (they are added; staff use a private thread).
// Stored in guild_settings on the support server's row (settings service).
// Words: src/content/dashboard/<lang>/support.json.

import { html, path } from '../html.js';
import { PERMS, channelField, channelPicker, postForm, roleField, rolePicker } from '../forms.js';
import { registryGuildId, registryValue, saveRegistry, section, slug } from './common.js';
import { textFor } from '../language.js';

/** "Nothing changed." in the page language. */
const nothing = (ctx) => ({ changes: [], message: textFor(ctx).t('errors.nothingChanged') });

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
        const tr = textFor(ctx);
        // Card ids: the slug of the English title, as before.
        if (!d.supportGuildId) return section(tr.t('support.title'), html`<p class="warn">${tr.t('support.notConnected')}</p>`, '', { key: 'support-server' });
        const form = d.supportGuild
            ? postForm(ctx, 'support', 'banned-role', rolePicker(d.supportGuild, 'bannedRoleId', d.bannedRoleId, { label: tr.t('support.bannedRole'), help: tr.t('support.bannedRoleHelp') }))
            : html`<p class="warn">${tr.t('support.cannotSee')}</p>`;
        const appeals = d.supportGuild
            ? postForm(ctx, 'support', 'appeals-category', channelPicker(d.supportGuild, 'supportAppealsCategoryId', d.supportAppealsCategoryId, {
                label: tr.t('support.appealsCategory'), kinds: ['category'], perms: PERMS.category,
                help: tr.t('support.appealsCategoryHelp'),
            }))
            : '';
        const title = d.supportGuild ? tr.t('support.titleNamed', { name: d.supportGuild.name }) : tr.t('support.title');
        const key = slug(d.supportGuild ? `Support server · ${d.supportGuild.name}` : 'Support server');
        const change = html`<a href="${path('/enforcement')}">${tr.t('support.changeLink')}</a>`;
        return html`${section(title, html`${form}${appeals}
<p class="muted">${tr.tx('support.invite', { invite: d.invite || tr.t('forms.notSet'), change })}</p>`, '', { key })}`;
    },

    actions: {
        async 'banned-role'(ctx, form) {
            const supportGuildId = registryGuildId('bannedRoleId', ctx.env);
            const supportGuild = supportGuildId ? ctx.client?.guilds?.cache?.get(supportGuildId) : null;
            const bannedRoleId = roleField(supportGuild, form, 'bannedRoleId', { label: textFor(ctx).t('support.bannedRoleShort') });
            if (bannedRoleId === registryValue(ctx, 'bannedRoleId')) return nothing(ctx);
            return saveRegistry(ctx, { bannedRoleId }, 'support');
        },
        async 'appeals-category'(ctx, form) {
            const supportGuildId = registryGuildId('supportAppealsCategoryId', ctx.env);
            const supportGuild = supportGuildId ? ctx.client?.guilds?.cache?.get(supportGuildId) : null;
            const supportAppealsCategoryId = channelField(supportGuild, form, 'supportAppealsCategoryId', { kinds: ['category'], label: textFor(ctx).t('support.appealsCategory') });
            if (supportAppealsCategoryId === registryValue(ctx, 'supportAppealsCategoryId')) return nothing(ctx);
            return saveRegistry(ctx, { supportAppealsCategoryId }, 'support');
        },
    },
};
