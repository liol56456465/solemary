// appearance.js: Bot → Bot in this server. A nickname and an avatar for Mewvo in this server
// only (Discord's per-server profile). A paid perk: Mewvo Pro and Max, by the server owner's
// plan (premiumEffects.guildPlan). The global name and avatar stay on Owner → Bot profile.

import { Routes } from 'discord.js';
import { html } from '../html.js';
import { InputError, postForm, text, textInput } from '../forms.js';
import { MAX_UPLOAD_BYTES, sniffImage } from '../multipart.js';
import { section } from './common.js';
import { guildPlan as defaultGuildPlan } from '../../billing/premiumEffects.js';
import { textFor } from '../language.js';

// Words: src/content/dashboard/<lang>/appearance.json.

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
        throw new InputError(textFor(ctx).t('appearance.error.plan'), 403);
    }
}

export default {
    key: 'appearance',
    label: 'Bot in this server',
    help: 'Give Mewvo its own name and profile picture (avatar) in this server, so it fits your server. Other servers still see the normal ones.',

    async load(ctx) {
        const me = ctx.guild?.members?.me || null;
        return { nickname: me?.nickname || '', hasAvatar: Boolean(me?.avatar), unlocked: PAID.has(svc(ctx, 'guildPlan')(ctx.guildId)) };
    },

    render(ctx, { nickname, hasAvatar, unlocked }) {
        const tr = textFor(ctx);
        // Card ids: the slugs of the English titles, as before.
        if (!unlocked) {
            return section(tr.t('appearance.title'), html`<p class="muted">${tr.tx('appearance.locked')} <a href="/pricing">${tr.t('appearance.plans')}</a></p>`, '', { key: 'bot-in-this-server' });
        }
        const nick = postForm(ctx, 'appearance', 'nickname', textInput('nickname', nickname, { label: tr.t('appearance.nickname.label'), max: NICKNAME_MAX, placeholder: 'Mewvo', help: tr.t('appearance.nickname.help') }));
        const avatar = postForm(ctx, 'appearance', 'avatar', html`<label class="wide">${tr.t('appearance.avatar.label')}<input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required></label>`,
            { submit: tr.t('appearance.avatar.upload'), multipart: true, canEdit: ctx.canEdit && ctx.canAct });
        const reset = hasAvatar ? postForm(ctx, 'appearance', 'avatar-reset', '', { submit: tr.t('appearance.avatar.reset'), danger: true, inline: true, canEdit: ctx.canEdit && ctx.canAct, confirm: tr.t('appearance.avatar.resetConfirm') }) : '';
        return html`${section(tr.t('appearance.nickname.title'), nick, '', { key: 'nickname' })}${section(tr.t('appearance.avatar.title'), html`${avatar}${reset}`, tr.t(hasAvatar ? 'appearance.avatar.own' : 'appearance.avatar.normal'), { key: 'avatar' })}`;
    },

    actions: {
        nickname: {
            admin: true,
            async run(ctx, form) {
                requirePlan(ctx);
                const nick = text(form, 'nickname', NICKNAME_MAX + 10).replace(/\s+/g, ' ').trim();
                const tr = textFor(ctx);
                if (nick.length > NICKNAME_MAX) throw new InputError(tr.t('appearance.error.tooLong', { max: tr.fmtNumber(NICKNAME_MAX) }), 400, 'nickname');
                const old = ctx.guild.members.me?.nickname || null;
                if ((old || '') === nick) return { changes: [], message: tr.t('errors.nothingChanged') };
                await svc(ctx, 'setBotNickname')(ctx.guild, nick || null, `dashboard: ${ctx.actor.username}`);
                return { changes: [{ key: 'botNickname', old, new: nick || null }], message: nick ? tr.t('appearance.action.renamed', { nick }) : tr.t('appearance.action.normalName') };
            },
        },
        avatar: {
            admin: true,
            upload: true,
            async run(ctx) {
                requirePlan(ctx);
                const tr = textFor(ctx);
                const file = ctx.upload?.file || null;
                if (!file) throw new InputError(tr.t('appearance.error.choose'), 400, 'image');
                if (file.data.length > MAX_UPLOAD_BYTES) throw new InputError(tr.t('appearance.error.tooLarge'), 413, 'image');
                const image = sniffImage(file.data);
                if (!image) throw new InputError(tr.t('appearance.error.notImage'), 400, 'image');
                await svc(ctx, 'setBotAvatar')(ctx.client, ctx.guildId, `data:${image.type};base64,${file.data.toString('base64')}`);
                return { changes: [{ key: 'botAvatar', old: null, new: 'uploaded' }], message: tr.t('appearance.action.avatarSet') };
            },
        },
        'avatar-reset': {
            admin: true,
            async run(ctx) {
                requirePlan(ctx);
                await svc(ctx, 'setBotAvatar')(ctx.client, ctx.guildId, null);
                return { changes: [{ key: 'botAvatar', old: 'uploaded', new: null }], message: textFor(ctx).t('appearance.action.avatarReset') };
            },
        },
    },
};
