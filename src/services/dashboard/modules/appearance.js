// appearance.js: Bot → Bot in this server. A nickname and an avatar for Mewvo in this server
// only (Discord's per-server profile). A paid perk: Mewvo Pro and Max, by the server owner's
// plan (premiumEffects.guildPlan). The global name and avatar stay on Owner → Bot profile.

import { Routes } from 'discord.js';
import { html } from '../html.js';
import { InputError, postForm, text, textInput } from '../forms.js';
import { MAX_UPLOAD_BYTES, sniffImage } from '../multipart.js';
import { section } from './common.js';
import { guildPlan as defaultGuildPlan } from '../../billing/premiumEffects.js';

export const NICKNAME_MAX = 32;
const PAID = new Set(['pro', 'max']);

/** Overridable for tests through ctx.services. */
const defaults = {
    guildPlan: (guildId) => defaultGuildPlan(guildId),
    setBotNickname: (guild, nick, reason) => guild.members.me.setNickname(nick, reason),
    // Discord's per-server bot profile (Modify Current Member). editMe when discord.js has it.
    setBotAvatar: (client, guildId, dataUri) => {
        const guild = client.guilds?.cache?.get?.(guildId);
        if (typeof guild?.members?.editMe === 'function') return guild.members.editMe({ avatar: dataUri });
        return client.rest.patch(Routes.guildMember(guildId), { body: { avatar: dataUri } });
    },
};
const svc = (ctx, name) => (typeof ctx.services?.[name] === 'function' ? ctx.services[name] : defaults[name]);

function requirePlan(ctx) {
    if (!PAID.has(svc(ctx, 'guildPlan')(ctx.guildId))) {
        throw new InputError('A custom bot name and avatar in your server come with Mewvo Pro and Max, on the server owner\'s plan.', 403);
    }
}

export default {
    key: 'appearance',
    label: 'Bot in this server',
    help: 'Give Mewvo its own nickname and avatar in this server. Other servers keep the normal ones.',

    async load(ctx) {
        const me = ctx.guild?.members?.me || null;
        return { nickname: me?.nickname || '', hasAvatar: Boolean(me?.avatar), unlocked: PAID.has(svc(ctx, 'guildPlan')(ctx.guildId)) };
    },

    render(ctx, { nickname, hasAvatar, unlocked }) {
        if (!unlocked) {
            return section('Bot in this server', html`<p class="muted">A custom nickname and avatar for Mewvo in this server come with Mewvo Pro and Max, on the server owner's plan. <a href="/pricing">Plans</a></p>`);
        }
        const nick = postForm(ctx, 'appearance', 'nickname', textInput('nickname', nickname, { label: 'Nickname', max: NICKNAME_MAX, placeholder: 'Mewvo', help: 'Empty: the normal name.' }));
        const avatar = postForm(ctx, 'appearance', 'avatar', html`<label class="wide">Avatar (PNG, JPEG, GIF or WebP)<input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required></label>`,
            { submit: 'Upload avatar', multipart: true, canEdit: ctx.canEdit && ctx.canAct });
        const reset = hasAvatar ? postForm(ctx, 'appearance', 'avatar-reset', '', { submit: 'Use the normal avatar', danger: true, inline: true, canEdit: ctx.canEdit && ctx.canAct, confirm: 'Go back to the normal avatar in this server?' }) : '';
        return html`${section('Nickname', nick)}${section('Avatar', html`${avatar}${reset}`, hasAvatar ? 'This server has its own avatar now.' : 'This server uses the normal avatar.')}`;
    },

    actions: {
        nickname: {
            admin: true,
            async run(ctx, form) {
                requirePlan(ctx);
                const nick = text(form, 'nickname', NICKNAME_MAX + 10).replace(/\s+/g, ' ').trim();
                if (nick.length > NICKNAME_MAX) throw new InputError(`Nicknames are at most ${NICKNAME_MAX} characters.`, 400, 'nickname');
                const old = ctx.guild.members.me?.nickname || null;
                if ((old || '') === nick) return { changes: [], message: 'Nothing changed.' };
                await svc(ctx, 'setBotNickname')(ctx.guild, nick || null, `dashboard: ${ctx.actor.username}`);
                return { changes: [{ key: 'botNickname', old, new: nick || null }], message: nick ? `Mewvo is now called "${nick}" here.` : 'Mewvo uses its normal name here again.' };
            },
        },
        avatar: {
            admin: true,
            upload: true,
            async run(ctx) {
                requirePlan(ctx);
                const file = ctx.upload?.file || null;
                if (!file) throw new InputError('Choose an image file.', 400, 'image');
                if (file.data.length > MAX_UPLOAD_BYTES) throw new InputError('The image is too large.', 413, 'image');
                const image = sniffImage(file.data);
                if (!image) throw new InputError('That file is not a PNG, JPEG, GIF or WebP image.', 400, 'image');
                await svc(ctx, 'setBotAvatar')(ctx.client, ctx.guildId, `data:${image.type};base64,${file.data.toString('base64')}`);
                return { changes: [{ key: 'botAvatar', old: null, new: 'uploaded' }], message: 'Mewvo has its own avatar in this server now. Discord can take a minute to show it.' };
            },
        },
        'avatar-reset': {
            admin: true,
            async run(ctx) {
                requirePlan(ctx);
                await svc(ctx, 'setBotAvatar')(ctx.client, ctx.guildId, null);
                return { changes: [{ key: 'botAvatar', old: 'uploaded', new: null }], message: 'Mewvo uses its normal avatar here again.' };
            },
        },
    },
};
