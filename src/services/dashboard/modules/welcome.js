// welcome.js — Welcome & goodbye: messages and channels, auto roles, join/leave logs.
// Writes go through services/welcomeService.js (row-locked), shared with /greet,
// /welcome, /goodbye and /autorole. The embed (title, colour, footer) and the image
// are edited here too, with the checks of /welcome setup and /greet dashboard; an image
// is a link (uploads stay in /greet, which re-posts the file so its link keeps working).

import { html } from '../html.js';
import { isExpiredDiscordCdnUrl } from '../../../utils/welcomeImageStore.js';
import {
    InputError, PERMS, autoRoleField, boolField, buttonForm, channelField, channelPicker, checkbox, switchInput, intField,
    numberInput, postForm, rolePicker, roleName, text, textArea, textInput, toggleForm, roleWarnings,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, section, table } from './common.js';

const KEYS = ['enabled', 'channelId', 'welcomeMessage', 'welcomePing', 'dmMessage', 'goodbyeEnabled', 'goodbyeChannelId',
    'leaveMessage', 'goodbyePing', 'roleIds', 'autoRoleDelay', 'joinLogs', 'leaveLogs',
    'welcomeEmbed', 'welcomeImage', 'welcomeImageRef', 'leaveEmbed', 'goodbyeImageRef'];

// Discord's embed limits (title 256, footer 2048); the image link as in welcomeService.
export const EMBED_TITLE_MAX = 256;
export const EMBED_FOOTER_MAX = 2048;
export const IMAGE_URL_MAX = 2048;
const HEX_COLOUR = /^#?([0-9a-f]{6})$/i;
const DISCORD_CDN = /(^|\.)(discordapp\.(com|net)|discord\.com)$/i;

/** '#RRGGBB' (or RRGGBB) → the number embeds store; '' → null (the default colour). */
export function colourField(form, name, label) {
    const raw = text(form, name, 7);
    if (!raw) return null;
    const match = raw.match(HEX_COLOUR);
    if (!match) throw new InputError(`${label} must be a hex colour like #57F287.`, 400, name);
    return parseInt(match[1], 16);
}

/** A stored colour (number or '#hex') as '#RRGGBB' for the form; '' when unset. */
export function colourText(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
    if (typeof value === 'string' && HEX_COLOUR.test(value)) return `#${value.replace('#', '').toUpperCase()}`;
    return '';
}

/**
 * An image link: https only, at most IMAGE_URL_MAX characters (as /greet: a valid URL;
 * the dashboard also refuses http). '' → null (no image). An expired Discord attachment
 * link is refused; a fresh one is accepted with a warning (it stops working in about a day).
 */
export function imageUrlField(form, name, label) {
    const raw = text(form, name, IMAGE_URL_MAX);
    if (!raw) return { url: null, warning: null };
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new InputError(`${label}: not a valid link.`, 400, name);
    }
    if (parsed.protocol !== 'https:') throw new InputError(`${label} must start with https://.`, 400, name);
    if (isExpiredDiscordCdnUrl(raw)) throw new InputError(`${label}: that Discord attachment link has expired. Upload the image again with /greet, or use a permanent image link.`, 400, name);
    const warning = DISCORD_CDN.test(parsed.hostname) && parsed.searchParams.has('ex')
        ? `${label}: Discord attachment links stop working after about a day. For a lasting image, upload it with /greet or use a permanent image host.`
        : null;
    return { url: raw, warning };
}

/** The embed with title / footer / colour set, or removed when empty (the defaults apply). */
function embedWith(current, { title, footer, color }) {
    const next = { ...(current && typeof current === 'object' ? current : {}) };
    for (const [key, value] of Object.entries({ title, footer, color })) {
        if (value === null || value === '') delete next[key];
        else next[key] = value;
    }
    return next;
}

/** The goodbye image link: a string (current format) or { url } (older embeds). */
function goodbyeImageOf(leaveEmbed) {
    const image = leaveEmbed?.image;
    return typeof image === 'string' ? image : image?.url || '';
}

function embedFields(prefix, embed, imageUrl, defaults) {
    return html`<div class="grid">
${textInput(`${prefix}Title`, embed?.title || '', { label: 'Embed title', max: EMBED_TITLE_MAX, help: `Empty = ${defaults.title}. Placeholders work here.` })}
${textInput(`${prefix}Color`, colourText(embed?.color), { label: 'Embed colour', max: 7, placeholder: '#57F287', help: 'Hex colour. Empty = the default colour.' })}
${textInput(`${prefix}Footer`, embed?.footer || '', { label: 'Embed footer', max: EMBED_FOOTER_MAX, help: `Empty = ${defaults.footer}. Placeholders work here.` })}
${textInput(`${prefix}Image`, imageUrl || '', { label: 'Image link (empty = no image)', max: IMAGE_URL_MAX, type: 'url', placeholder: 'https://example.com/banner.png', help: 'A direct https:// link to a PNG, JPG, GIF or WebP image, shown large under the message.' })}</div>`;
}

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
    help: 'Messages when members join and leave (with their embed and image), roles given on join, and join/leave logs. Placeholders: {user}, {user.tag}, {server}, {memberCount}.',

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
        const embedHint = 'The message above is the embed text. Without Embed Links in the channel, only the text is sent.';
        const welcomeEmbed = postForm(ctx, 'welcome', 'welcome-embed', embedFields('welcome', w.welcomeEmbed, w.welcomeImage,
            { title: '🎉 Welcome!', footer: 'Welcome to <server name>!' }), { canEdit: ctx.canEdit && ctx.canAct });
        const goodbyeEmbed = postForm(ctx, 'welcome', 'goodbye-embed', embedFields('goodbye', w.leaveEmbed, goodbyeImageOf(w.leaveEmbed),
            { title: '👋 Goodbye', footer: 'Goodbye from <server name>!' }), { canEdit: ctx.canEdit && ctx.canAct });
        return html`${section('Welcome', welcome)}${section('Welcome embed and image', welcomeEmbed, embedHint)}
${section('Goodbye', goodbye)}${section('Goodbye embed and image', goodbyeEmbed, embedHint)}
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
        'welcome-embed': {
            admin: true,
            async run(ctx, form) {
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                const { url, warning } = imageUrlField(form, 'welcomeImage', 'Welcome image');
                const welcomeEmbed = embedWith(current.welcomeEmbed, {
                    title: text(form, 'welcomeTitle', EMBED_TITLE_MAX),
                    footer: text(form, 'welcomeFooter', EMBED_FOOTER_MAX),
                    color: colourField(form, 'welcomeColor', 'Embed colour'),
                });
                // A stored upload (see welcomeImageStore.js) is kept only while its link is the one saved.
                const welcomeImageRef = url && current.welcomeImageRef?.url === url ? current.welcomeImageRef : null;
                const result = await update(ctx, changedOnly({ welcomeEmbed, welcomeImage: url, welcomeImageRef }, current), 'Welcome embed saved.');
                return warning && result.changes.length ? { ...result, warnings: [warning] } : result;
            },
        },
        'goodbye-embed': {
            admin: true,
            async run(ctx, form) {
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                const { url, warning } = imageUrlField(form, 'goodbyeImage', 'Goodbye image');
                const leaveEmbed = embedWith(current.leaveEmbed, {
                    title: text(form, 'goodbyeTitle', EMBED_TITLE_MAX),
                    footer: text(form, 'goodbyeFooter', EMBED_FOOTER_MAX),
                    color: colourField(form, 'goodbyeColor', 'Embed colour'),
                });
                // The goodbye image lives in leaveEmbed.image (as /greet saves it).
                if (url) leaveEmbed.image = url;
                else delete leaveEmbed.image;
                const goodbyeImageRef = url && current.goodbyeImageRef?.url === url ? current.goodbyeImageRef : null;
                const result = await update(ctx, changedOnly({ leaveEmbed, goodbyeImageRef }, current), 'Goodbye embed saved.');
                return warning && result.changes.length ? { ...result, warnings: [warning] } : result;
            },
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
