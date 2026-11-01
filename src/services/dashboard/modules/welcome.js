// welcome.js — Welcome & goodbye: messages and channels, auto roles, join/leave logs.
// Writes go through services/welcomeService.js (row-locked), shared with /greet,
// /welcome, /goodbye and /autorole. The embed (title, colour, footer) and the image
// are edited here too, with the checks of /welcome setup and /greet dashboard. An image
// is a link, or an uploaded file: like /greet dashboard, the upload is re-posted through
// utils/welcomeImageStore.js (storeWelcomeImage) into the audit log channel and saved as
// { channelId, messageId, url }, so the join/leave events fetch a fresh link from that
// message (Discord attachment links expire after about a day).

import { html } from '../html.js';
import { isExpiredDiscordCdnUrl } from '../../../utils/welcomeImageStore.js';
import {
    InputError, PERMS, autoRoleField, boolField, buttonForm, channelField, channelPicker, checkbox, switchInput, intField,
    numberInput, postForm, rolePicker, roleName, text, textArea, textInput, toggleForm, roleWarnings,
} from '../forms.js';
import { MAX_UPLOAD_BYTES, sniffImage } from '../multipart.js';
import { isAllowedImageUrl, isSafeLink } from '../pages.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, section, table, topic } from './common.js';

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
    if (isExpiredDiscordCdnUrl(raw)) throw new InputError(`${label}: that Discord attachment link has expired. Upload the image file below instead, or use a permanent image link.`, 400, name);
    const warning = DISCORD_CDN.test(parsed.hostname) && parsed.searchParams.has('ex')
        ? `${label}: Discord attachment links stop working after about a day. For a lasting image, upload the file below (Upload image) or use a permanent image host.`
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
${textInput(`${prefix}Title`, embed?.title || '', { label: 'Box title', max: EMBED_TITLE_MAX, help: `The bold line at the top of the box. Leave empty for ${defaults.title}. The same words in curly brackets as in the message work here too.` })}
${textInput(`${prefix}Color`, colourText(embed?.color), { label: 'Box colour', max: 7, placeholder: '#57F287', help: 'The coloured stripe on the left of the box, as a colour code: # and six letters or numbers, like #57F287 for green. Leave empty for the default colour.' })}
${textInput(`${prefix}Footer`, embed?.footer || '', { label: 'Box footer', max: EMBED_FOOTER_MAX, help: `Small text at the bottom of the box. Leave empty for ${defaults.footer}. The same words in curly brackets as in the message work here too.` })}
${textInput(`${prefix}Image`, imageUrl || '', { label: 'Image link', max: IMAGE_URL_MAX, type: 'url', placeholder: 'https://example.com/banner.png', help: 'A link that starts with https:// and opens a PNG, JPG, GIF or WebP picture. It shows large at the bottom of the box. Leave empty for no image. To use a picture from your computer, use Upload an image below.' })}</div>`;
}

const UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);

/**
 * The current image (a preview when it is stored on Discord, which the CSP allows; else
 * the link), the upload form and Remove image. `image`: { url, fresh, ref } from load().
 */
function imageBlock(ctx, prefix, image) {
    const canEdit = ctx.canEdit && ctx.canAct;
    const storedIn = image.ref ? ctx.guild?.channels?.cache?.get(image.ref.channelId) : null;
    let current;
    if (!image.url) current = html`<p class="muted">No image.</p>`;
    else if (isAllowedImageUrl(image.fresh)) current = html`<img class="image-preview" src="${image.fresh}" alt="Current ${prefix} image" loading="lazy" referrerpolicy="no-referrer">`;
    else if (isSafeLink(image.url)) current = html`<p>Current image: <a href="${image.url}" rel="noopener noreferrer" target="_blank">${image.url}</a> <span class="muted">(only pictures stored on Discord can be shown here)</span></p>`;
    else current = html`<p>Current image: <code>${image.url}</code></p>`;
    const stored = image.ref
        ? html`<p class="hint">Uploaded file: a copy is kept in ${storedIn ? html`#${storedIn.name}` : html`channel ${image.ref.channelId}`}. Do not delete that message, because the ${prefix} message loads the picture from it.</p>`
        : '';
    const upload = postForm(ctx, 'welcome', `${prefix}-image-upload`, html`<div class="grid"><label class="wide">Upload an image (PNG, JPEG, GIF or WebP, up to ${UPLOAD_MB} MB)<input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required><span class="hint">Replaces the image link above. Mewvo posts the file in your main log channel and uses it from there, so the picture keeps working. /greet in Discord does the same.</span></label></div>`,
        { submit: 'Upload image', multipart: true, canEdit });
    const remove = image.url ? buttonForm(ctx, 'welcome', `${prefix}-image-remove`, 'Remove image', {}, { confirm: `Remove the ${prefix} image?`, canEdit }) : '';
    return html`<div class="image-current">${current}${stored}</div>${upload}${remove}`;
}

/** The image for the page: the saved link, a fresh link for the preview, and the stored copy (only while it is the saved link). */
async function imageFor(ctx, url, ref, label) {
    if (!url) return { url: null, fresh: null, ref: null };
    const ownRef = ref?.url && ref.url === url ? ref : null;
    let fresh = url;
    try {
        fresh = (await ctx.services.resolveWelcomeImageUrl?.(ctx.client, url, ownRef, { guildId: ctx.guildId, label })) || url;
    } catch {
        fresh = url;
    }
    return { url, fresh, ref: ownRef };
}

/**
 * Re-posts an uploaded image with storeWelcomeImage (the /greet store) into the audit log
 * channel. Returns the stored ref { channelId, messageId, url }; refuses (nothing saved)
 * when the file is not an image or there is no usable storage channel.
 */
async function storeUpload(ctx, prefix, label) {
    const field = 'image';
    const file = ctx.upload?.file || null;
    if (!file) throw new InputError('Choose an image file to upload.', 400, field);
    const image = sniffImage(file.data);
    if (!image) throw new InputError('That file is not a PNG, JPEG, GIF or WebP image.', 400, field);
    const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
    const channelId = ctx.services.resolveLogChannel(config, 'audit');
    if (!channelId) {
        throw new InputError(`${label}: no main log channel is set, so the uploaded picture has nowhere to be kept. Set one on the Logging page, or use an image link instead. Nothing was changed.`, 400, field);
    }
    const ref = await ctx.services.storeWelcomeImage(ctx.guild, { data: file.data, name: `${prefix}-image.${image.ext}` }, [channelId], prefix);
    if (!ref) {
        const channel = ctx.guild?.channels?.cache?.get(channelId);
        throw new InputError(`${label}: Mewvo could not post the picture in the main log channel (${channel ? `#${channel.name}` : channelId}). Mewvo needs the View Channel, Send Messages and Attach Files permissions there. Nothing was changed.`, 400, field);
    }
    return ref;
}

/** Saves the stored image; when the save fails, the just-posted copy is deleted again (as evidence uploads do). */
async function saveStored(ctx, ref, patch, message) {
    try {
        return await update(ctx, patch, message);
    } catch (error) {
        const channel = ctx.guild?.channels?.cache?.get(ref.channelId);
        await Promise.resolve(channel?.messages?.delete?.(ref.messageId)).catch(() => {});
        throw error;
    }
}

function storedNote(ctx, ref, prefix) {
    const channel = ctx.guild?.channels?.cache?.get(ref.channelId);
    return `A copy is kept in ${channel ? `#${channel.name}` : 'the audit log channel'}; don't delete that message, the ${prefix} message loads the image from it.`;
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
    help: 'Greet new members with a message when they join, say goodbye when they leave, and give new members a role by themselves. In the messages you can use {user} (mentions the member), {user.tag} (their username, without a mention), {server} (the server name) and {memberCount} (how many members the server has now).',

    async load(ctx) {
        const welcome = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
        const [welcomeImage, goodbyeImage] = await Promise.all([
            imageFor(ctx, welcome.welcomeImage || null, welcome.welcomeImageRef, 'welcome'),
            imageFor(ctx, goodbyeImageOf(welcome.leaveEmbed) || null, welcome.goodbyeImageRef, 'goodbye'),
        ]);
        return { welcome, images: { welcome: welcomeImage, goodbye: goodbyeImage } };
    },

    render(ctx, { welcome: w, images = { welcome: { url: null }, goodbye: { url: null } } }) {
        const g = ctx.guild;
        const welcome = html`${toggleForm(ctx, 'welcome', 'welcome-enabled', w.enabled, { label: 'Welcome messages' })}
${postForm(ctx, 'welcome', 'welcome', html`<div class="grid">
${channelPicker(g, 'channelId', w.channelId, { label: 'Welcome channel', perms: PERMS.postFiles, help: 'Where the welcome message is posted.' })}
${switchInput('welcomePing', w.welcomePing, { label: 'Ping the member', help: 'Mentions them so they get a notification.' })}
${textArea('welcomeMessage', w.welcomeMessage, { label: 'Welcome message', max: 2000, help: 'For example: Welcome to {server}, {user}. You are member number {memberCount}.' })}
${textArea('dmMessage', w.dmMessage, { label: 'Private message to the new member', max: 2000, help: 'Sent to them directly (a DM). Leave empty to send nothing.' })}</div>`)}`;
        const goodbye = html`${toggleForm(ctx, 'welcome', 'goodbye-enabled', w.goodbyeEnabled, { label: 'Goodbye messages' })}
${postForm(ctx, 'welcome', 'goodbye', html`<div class="grid">
${channelPicker(g, 'goodbyeChannelId', w.goodbyeChannelId, { label: 'Goodbye channel', perms: PERMS.postFiles, help: 'Where the goodbye message is posted.' })}
${switchInput('goodbyePing', w.goodbyePing, { label: 'Ping the member', help: 'Mentions them by name in the message.' })}
${textArea('leaveMessage', w.leaveMessage, { label: 'Goodbye message', max: 2000, help: 'For example: {user.tag} left the server.' })}</div>`)}`;
        const roles = html`${table(['Role', 'Problems', ''], (w.roleIds || []).map((id) => [roleName(g, id), roleWarnings(g, id, { autoAssign: true }).join('; ') || html`<span class="ok">ok</span>`,
            buttonForm(ctx, 'welcome', 'autorole-remove', 'Remove', { roleId: id })]), 'No roles are given on join.')}
${postForm(ctx, 'welcome', 'autorole-add', rolePicker(g, 'roleId', null, { label: 'Role for new members', optional: false, autoAssign: true, includeManaged: false }), { submit: 'Set', inline: true })}
${postForm(ctx, 'welcome', 'autorole-delay', html`<div class="grid">${numberInput('autoRoleDelay', w.autoRoleDelay || 0, { label: 'Wait before giving the role (seconds)', min: 0, max: 3600, help: 'How long Mewvo waits after someone joins. 0 gives it at once.' })}</div>`)}`;
        const logs = postForm(ctx, 'welcome', 'logs', html`<div class="grid">
${switchInput('joinLogsEnabled', w.joinLogs?.enabled, { label: 'Log joins', help: 'Post a short line for staff each time someone joins.' })}
${channelPicker(g, 'joinLogsChannelId', w.joinLogs?.channelId || null, { label: 'Join log channel', perms: PERMS.post })}
${switchInput('leaveLogsEnabled', w.leaveLogs?.enabled, { label: 'Log leaves', help: 'Post a short line for staff each time someone leaves.' })}
${channelPicker(g, 'leaveLogsChannelId', w.leaveLogs?.channelId || null, { label: 'Leave log channel', perms: PERMS.post })}</div>`);
        const embedHint = 'The message is sent inside a box (an embed) with a title, a colour and an optional picture. The message text above goes inside the box. If Mewvo lacks the Embed Links permission in that channel, only the text is sent.';
        const welcomeEmbed = html`${postForm(ctx, 'welcome', 'welcome-embed', embedFields('welcome', w.welcomeEmbed, w.welcomeImage,
            { title: '🎉 Welcome!', footer: 'Welcome to <server name>!' }), { canEdit: ctx.canEdit && ctx.canAct })}${imageBlock(ctx, 'welcome', images.welcome)}`;
        const goodbyeEmbed = html`${postForm(ctx, 'welcome', 'goodbye-embed', embedFields('goodbye', w.leaveEmbed, goodbyeImageOf(w.leaveEmbed),
            { title: '👋 Goodbye', footer: 'Goodbye from <server name>!' }), { canEdit: ctx.canEdit && ctx.canAct })}${imageBlock(ctx, 'goodbye', images.goodbye)}`;
        // v6: cards grouped by topic (common.js topic/section).
        const embedHelp = ['The box around the message: title, colour and an optional picture.', embedHint];
        return html`${topic('Welcome', 'What Mewvo posts when someone joins.', html`${section('Welcome', welcome, 'The welcome message, where it goes, and an optional private message.', { key: 'welcome' })}
${section('Welcome embed and image', welcomeEmbed, embedHelp)}`)}
${topic('Goodbye', 'What Mewvo posts when someone leaves.', html`${section('Goodbye', goodbye, 'The goodbye message and where it goes.', { key: 'goodbye' })}
${section('Goodbye embed and image', goodbyeEmbed, embedHelp)}`)}
${topic('New members', 'A starting role, and a record of joins and leaves for staff.', html`${section('Auto role', roles, 'Every new member gets this role by itself. You can have one: setting a new one replaces the old one. Mewvo can only give roles below its own role in the role list, and it will not give roles with staff powers. You can also do this with /autorole in Discord.', { size: 'normal' })}
${section('Join and leave logs', logs, 'A record for staff of who joined and who left, separate from the public messages.')}`)}`;
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
        // Uploads: the file is re-posted with the /greet store, then saved exactly as
        // /greet dashboard saves it (link = the stored message's attachment, plus its ref).
        'welcome-image-upload': {
            admin: true,
            upload: true,
            async run(ctx) {
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                const ref = await storeUpload(ctx, 'welcome', 'Welcome image');
                const result = await saveStored(ctx, ref, changedOnly({ welcomeImage: ref.url, welcomeImageRef: ref }, current), 'Welcome image uploaded.');
                return { ...result, message: `Welcome image uploaded. ${storedNote(ctx, ref, 'welcome')}` };
            },
        },
        'goodbye-image-upload': {
            admin: true,
            upload: true,
            async run(ctx) {
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                const ref = await storeUpload(ctx, 'goodbye', 'Goodbye image');
                const leaveEmbed = { ...(current.leaveEmbed && typeof current.leaveEmbed === 'object' ? current.leaveEmbed : {}), image: ref.url };
                const result = await saveStored(ctx, ref, changedOnly({ leaveEmbed, goodbyeImageRef: ref }, current), 'Goodbye image uploaded.');
                return { ...result, message: `Goodbye image uploaded. ${storedNote(ctx, ref, 'goodbye')}` };
            },
        },
        // Remove: no image (as /greet with an empty link). The stored copy's message is kept.
        'welcome-image-remove': {
            admin: true,
            async run(ctx) {
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                return update(ctx, changedOnly({ welcomeImage: null, welcomeImageRef: null }, current), 'Welcome image removed.');
            },
        },
        'goodbye-image-remove': {
            admin: true,
            async run(ctx) {
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                const leaveEmbed = { ...(current.leaveEmbed && typeof current.leaveEmbed === 'object' ? current.leaveEmbed : {}) };
                delete leaveEmbed.image;
                return update(ctx, changedOnly({ leaveEmbed, goodbyeImageRef: null }, current), 'Goodbye image removed.');
            },
        },
        async 'autorole-add'(ctx, form) {
            const roleId = autoRoleField(ctx.guild, form, 'roleId', { optional: false, label: 'Role for new members' });
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
            const autoRoleDelay = intField(form, 'autoRoleDelay', { min: 0, max: 3600, label: 'Wait before giving the role' });
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
