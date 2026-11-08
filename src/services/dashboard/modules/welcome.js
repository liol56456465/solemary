// welcome.js — Welcome & goodbye: messages and channels, auto roles, join/leave logs.
// Writes go through services/welcomeService.js (row-locked), shared with /greet,
// /welcome, /goodbye and /autorole. The embed (title, colour, footer) and the image
// are edited here too, with the checks of /welcome setup and /greet dashboard. An image
// is a link, or an uploaded file: like /greet dashboard, the upload is re-posted through
// utils/welcomeImageStore.js (storeWelcomeImage) into the audit log channel and saved as
// { channelId, messageId, url }, so the join/leave events fetch a fresh link from that
// message (Discord attachment links expire after about a day).
//
// Words: src/content/dashboard/<lang>/welcome.json. The exported helpers (colourField,
// imageUrlField, storeUpload) are used by the Rules page too: their texts stay in the welcome
// namespace and use the request's language (currentText()).

import { html } from '../html.js';
import { isExpiredDiscordCdnUrl } from '../../../utils/welcomeImageStore.js';
import {
    InputError, PERMS, autoRoleField, boolField, buttonForm, channelField, channelPicker, checkbox, switchInput, intField,
    numberInput, postForm, rolePicker, roleName, text, textArea, textInput, toggleForm, roleWarnings,
} from '../forms.js';
import { MAX_UPLOAD_BYTES, sniffImage } from '../multipart.js';
import { isAllowedImageUrl, isSafeLink } from '../pages.js';
import { diffSnapshots } from '../audit.js';
import { currentText, textFor } from '../language.js';
import { changedOnly, section, table, topic } from './common.js';
import { managerActions } from './serverScope.js';

const KEYS = ['enabled', 'channelId', 'welcomeMessage', 'welcomePing', 'dmMessage', 'goodbyeEnabled', 'goodbyeChannelId',
    'leaveMessage', 'goodbyePing', 'roleIds', 'autoRoleDelay', 'joinLogs', 'leaveLogs',
    'welcomeEmbed', 'welcomeImage', 'welcomeImageRef', 'leaveEmbed', 'goodbyeImageRef'];

// Discord's embed limits (title 256, footer 2048); the image link as in welcomeService.
export const EMBED_TITLE_MAX = 256;
export const EMBED_FOOTER_MAX = 2048;
export const IMAGE_URL_MAX = 2048;
const HEX_COLOUR = /^#?([0-9a-f]{6})$/i;
const DISCORD_CDN = /(^|\.)(discordapp\.(com|net)|discord\.com)$/i;

// The message placeholders shown as they are typed ({user} …), not filled in by the translator.
const TOKENS = Object.freeze({ user: '{user}', server: '{server}', memberCount: '{memberCount}' });

// Texts that differ only by welcome / goodbye.
const IMAGE_TEXT = {
    welcome: { alt: 'welcome.image.welcomeAlt', stored: 'welcome.image.welcomeStored', confirm: 'welcome.image.welcomeConfirm', uploaded: 'welcome.action.welcomeUploaded', uploadedNote: 'welcome.action.welcomeUploadedNote' },
    goodbye: { alt: 'welcome.image.goodbyeAlt', stored: 'welcome.image.goodbyeStored', confirm: 'welcome.image.goodbyeConfirm', uploaded: 'welcome.action.goodbyeUploaded', uploadedNote: 'welcome.action.goodbyeUploadedNote' },
};

/** '#RRGGBB' (or RRGGBB) → the number embeds store; '' → null (the default colour). */
export function colourField(form, name, label) {
    const raw = text(form, name, 7);
    if (!raw) return null;
    const match = raw.match(HEX_COLOUR);
    if (!match) throw new InputError(currentText().t('welcome.error.colour', { label }), 400, name);
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
    const tr = currentText();
    const raw = text(form, name, IMAGE_URL_MAX);
    if (!raw) return { url: null, warning: null };
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new InputError(tr.t('welcome.error.badLink', { label }), 400, name);
    }
    if (parsed.protocol !== 'https:') throw new InputError(tr.t('welcome.error.https', { label }), 400, name);
    if (isExpiredDiscordCdnUrl(raw)) throw new InputError(tr.t('welcome.error.expiredLink', { label }), 400, name);
    const warning = DISCORD_CDN.test(parsed.hostname) && parsed.searchParams.has('ex')
        ? tr.t('welcome.warn.discordLink', { label })
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

// `defaultTitle`: the title Mewvo posts when none is set ("Welcome" / "Goodbye", as the bot writes it).
function embedFields(tr, prefix, embed, imageUrl, defaultTitle) {
    return html`<div class="grid">
${textInput(`${prefix}Title`, embed?.title || '', { label: tr.t('welcome.embed.title'), max: EMBED_TITLE_MAX, help: tr.t('welcome.embed.titleHelp', { title: defaultTitle }) })}
${textInput(`${prefix}Color`, colourText(embed?.color), { label: tr.t('welcome.embed.colour'), max: 7, placeholder: '#57F287', help: tr.t('welcome.embed.colourHelp') })}
${textInput(`${prefix}Footer`, embed?.footer || '', { label: tr.t('welcome.embed.footer'), max: EMBED_FOOTER_MAX, help: tr.t('welcome.embed.footerHelp') })}
${textInput(`${prefix}Image`, imageUrl || '', { label: tr.t('welcome.embed.image'), max: IMAGE_URL_MAX, type: 'url', placeholder: 'https://example.com/banner.png', help: tr.t('welcome.embed.imageHelp') })}</div>`;
}

const UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);

/**
 * The current image (a preview when it is stored on Discord, which the CSP allows; else
 * the link), the upload form and Remove image. `image`: { url, fresh, ref } from load().
 */
function imageBlock(ctx, prefix, image) {
    const tr = textFor(ctx);
    const words = IMAGE_TEXT[prefix];
    const canEdit = ctx.canEdit && ctx.canAct;
    const storedIn = image.ref ? ctx.guild?.channels?.cache?.get(image.ref.channelId) : null;
    let current;
    if (!image.url) current = html`<p class="muted">${tr.t('welcome.image.none')}</p>`;
    else if (isAllowedImageUrl(image.fresh)) current = html`<img class="image-preview" src="${image.fresh}" alt="${tr.t(words.alt)}" loading="lazy" referrerpolicy="no-referrer">`;
    else if (isSafeLink(image.url)) current = html`<p>${tr.tx('welcome.image.current', { link: html`<a href="${image.url}" rel="noopener noreferrer" target="_blank">${image.url}</a>` })} <span class="muted">${tr.t('welcome.image.onlyDiscord')}</span></p>`;
    else current = html`<p>${tr.tx('welcome.image.current', { link: html`<code>${image.url}</code>` })}</p>`;
    const stored = image.ref
        ? html`<p class="hint">${tr.tx(words.stored, { where: storedIn ? html`#${storedIn.name}` : tr.t('welcome.image.channelId', { id: image.ref.channelId }) })}</p>`
        : '';
    const upload = postForm(ctx, 'welcome', `${prefix}-image-upload`, html`<div class="grid"><label class="wide">${tr.tx('welcome.image.uploadLabel', { mb: tr.fmtNumber(UPLOAD_MB) })}<input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required><span class="hint">${tr.tx('welcome.image.uploadHint')}</span></label></div>`,
        { submit: tr.t('welcome.image.upload'), multipart: true, canEdit });
    const remove = image.url ? buttonForm(ctx, 'welcome', `${prefix}-image-remove`, tr.t('welcome.image.remove'), {}, { confirm: tr.t(words.confirm), canEdit }) : '';
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
 * when the file is not an image or there is no usable storage channel. `content`: the text
 * of the stored message when it is not for welcome/goodbye (the Rules page uses this).
 */
export async function storeUpload(ctx, prefix, label, { content = null } = {}) {
    const tr = currentText();
    const field = 'image';
    const file = ctx.upload?.file || null;
    if (!file) throw new InputError(tr.t('welcome.error.chooseFile'), 400, field);
    const image = sniffImage(file.data);
    if (!image) throw new InputError(tr.t('welcome.error.notImage'), 400, field);
    const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
    const channelId = ctx.services.resolveLogChannel(config, 'audit');
    if (!channelId) {
        throw new InputError(tr.t('welcome.error.noLogChannel', { label }), 400, field);
    }
    const ref = await ctx.services.storeWelcomeImage(ctx.guild, { data: file.data, name: `${prefix}-image.${image.ext}` }, [channelId], prefix, ...(content ? [{ content }] : []));
    if (!ref) {
        const channel = ctx.guild?.channels?.cache?.get(channelId);
        throw new InputError(tr.t('welcome.error.cannotPost', { label, channel: channel ? `#${channel.name}` : channelId }), 400, field);
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

/** "<Welcome> image uploaded. A copy is kept in #channel; …" in the request's language. */
function uploadedMessage(ctx, ref, prefix) {
    const tr = textFor(ctx);
    const channel = ctx.guild?.channels?.cache?.get(ref.channelId);
    return tr.t(IMAGE_TEXT[prefix].uploadedNote, { where: channel ? `#${channel.name}` : tr.t('welcome.action.auditChannel') });
}

/** "Nothing changed." in the request's language. */
function nothing(ctx) {
    return { changes: [], message: textFor(ctx).t('errors.nothingChanged') };
}

async function update(ctx, patch, message) {
    if (!Object.keys(patch).length) return nothing(ctx);
    const { before, after } = await ctx.services.updateWelcomeSettings(ctx.client, ctx.guildId, patch);
    const changes = diffSnapshots(before, after, Object.keys(patch).filter((k) => KEYS.includes(k)));
    return { changes, message: changes.length ? message : textFor(ctx).t('errors.nothingChanged') };
}

/** { [name]: text } when the form sent the field (an empty value clears it), {} when absent. */
function sentText(form, name, max = 2000) {
    return form?.[name] !== undefined ? { [name]: text(form, name, max) } : {};
}

export default {
    key: 'welcome',
    label: 'Welcome & goodbye',
    state: 'welcome',
    helpParams: { user: '{user}', server: '{server}', memberCount: '{memberCount}' },
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
        const tr = textFor(ctx);
        const g = ctx.guild;
        const welcome = html`${toggleForm(ctx, 'welcome', 'welcome-enabled', w.enabled, { label: tr.t('welcome.join.toggle') })}
${postForm(ctx, 'welcome', 'welcome', html`<div class="grid">
${channelPicker(g, 'channelId', w.channelId, { label: tr.t('welcome.join.channel'), perms: PERMS.postFiles, help: tr.t('welcome.join.channelHelp') })}
${switchInput('welcomePing', w.welcomePing, { label: tr.t('welcome.join.ping'), help: tr.t('welcome.join.pingHelp') })}
${textArea('welcomeMessage', w.welcomeMessage, { label: tr.t('welcome.join.message'), max: 2000, help: tr.t('welcome.join.messageHelp', TOKENS) })}
${textArea('dmMessage', w.dmMessage, { label: tr.t('welcome.join.dm'), max: 2000, help: tr.t('welcome.join.dmHelp') })}</div>`)}`;
        const goodbye = html`${toggleForm(ctx, 'welcome', 'goodbye-enabled', w.goodbyeEnabled, { label: tr.t('welcome.leave.toggle') })}
${postForm(ctx, 'welcome', 'goodbye', html`<div class="grid">
${channelPicker(g, 'goodbyeChannelId', w.goodbyeChannelId, { label: tr.t('welcome.leave.channel'), perms: PERMS.postFiles, help: tr.t('welcome.leave.channelHelp') })}
${switchInput('goodbyePing', w.goodbyePing, { label: tr.t('welcome.leave.ping'), help: tr.t('welcome.leave.pingHelp') })}
${textArea('leaveMessage', w.leaveMessage, { label: tr.t('welcome.leave.message'), max: 2000, help: tr.t('welcome.leave.messageHelp') })}</div>`)}`;
        const roles = html`${table([tr.t('welcome.autoRole.role'), tr.t('welcome.autoRole.problems'), ''], (w.roleIds || []).map((id) => [roleName(g, id), roleWarnings(g, id, { autoAssign: true }).join('; ') || html`<span class="ok">${tr.t('welcome.autoRole.ok')}</span>`,
            buttonForm(ctx, 'welcome', 'autorole-remove', tr.t('welcome.autoRole.remove'), { roleId: id }, { canEdit: ctx.canEdit && ctx.canAct })]), tr.t('welcome.autoRole.none'))}
${postForm(ctx, 'welcome', 'autorole-add', rolePicker(g, 'roleId', null, { label: tr.t('welcome.autoRole.pick'), optional: false, autoAssign: true, includeManaged: false }), { submit: tr.t('welcome.autoRole.set'), inline: true, canEdit: ctx.canEdit && ctx.canAct })}
${postForm(ctx, 'welcome', 'autorole-delay', html`<div class="grid">${numberInput('autoRoleDelay', w.autoRoleDelay || 0, { label: tr.t('welcome.autoRole.delay'), min: 0, max: 3600, help: tr.t('welcome.autoRole.delayHelp') })}</div>`, { canEdit: ctx.canEdit && ctx.canAct })}`;
        const logs = postForm(ctx, 'welcome', 'logs', html`<div class="grid">
${switchInput('joinLogsEnabled', w.joinLogs?.enabled, { label: tr.t('welcome.logs.joins'), help: tr.t('welcome.logs.joinsHelp') })}
${channelPicker(g, 'joinLogsChannelId', w.joinLogs?.channelId || null, { label: tr.t('welcome.logs.joinChannel'), perms: PERMS.post })}
${switchInput('leaveLogsEnabled', w.leaveLogs?.enabled, { label: tr.t('welcome.logs.leaves'), help: tr.t('welcome.logs.leavesHelp') })}
${channelPicker(g, 'leaveLogsChannelId', w.leaveLogs?.channelId || null, { label: tr.t('welcome.logs.leaveChannel'), perms: PERMS.post })}</div>`);
        const welcomeEmbed = html`${postForm(ctx, 'welcome', 'welcome-embed', embedFields(tr, 'welcome', w.welcomeEmbed, w.welcomeImage, 'Welcome'),
            { canEdit: ctx.canEdit && ctx.canAct })}${imageBlock(ctx, 'welcome', images.welcome)}`;
        const goodbyeEmbed = html`${postForm(ctx, 'welcome', 'goodbye-embed', embedFields(tr, 'goodbye', w.leaveEmbed, goodbyeImageOf(w.leaveEmbed), 'Goodbye'),
            { canEdit: ctx.canEdit && ctx.canAct })}${imageBlock(ctx, 'goodbye', images.goodbye)}`;
        // v6: cards grouped by topic (common.js topic/section). Keys: the English titles' slugs.
        const embedHelp = [tr.t('welcome.embed.help'), tr.t('welcome.embed.helpMore')];
        return html`${topic(tr.t('welcome.join.topic'), tr.t('welcome.join.topicLine'), html`${section(tr.t('welcome.join.title'), welcome, tr.t('welcome.join.help'), { key: 'welcome' })}
${section(tr.t('welcome.embed.welcomeTitle'), welcomeEmbed, embedHelp, { key: 'welcome-embed-and-image' })}`, { key: 'welcome' })}
${topic(tr.t('welcome.leave.topic'), tr.t('welcome.leave.topicLine'), html`${section(tr.t('welcome.leave.title'), goodbye, tr.t('welcome.leave.help'), { key: 'goodbye' })}
${section(tr.t('welcome.embed.goodbyeTitle'), goodbyeEmbed, embedHelp, { key: 'goodbye-embed-and-image' })}`, { key: 'goodbye' })}
${topic(tr.t('welcome.members.topic'), tr.t('welcome.members.topicLine'), html`${section(tr.t('welcome.autoRole.title'), roles, tr.t('welcome.autoRole.help'), { key: 'auto-role', size: 'normal' })}
${section(tr.t('welcome.logs.title'), logs, tr.t('welcome.logs.help'), { key: 'join-and-leave-logs' })}`, { key: 'new-members' })}`;
    },

    actions: managerActions(['welcome-enabled', 'goodbye-enabled', 'welcome', 'goodbye'], {
        async 'welcome-enabled'(ctx, form) {
            const tr = textFor(ctx);
            const enabled = boolField(form, 'enabled', tr.t('welcome.join.toggle'));
            return update(ctx, { enabled }, tr.t(enabled ? 'welcome.action.welcomeOn' : 'welcome.action.welcomeOff'));
        },
        async 'goodbye-enabled'(ctx, form) {
            const tr = textFor(ctx);
            const goodbyeEnabled = boolField(form, 'enabled', tr.t('welcome.leave.toggle'));
            return update(ctx, { goodbyeEnabled }, tr.t(goodbyeEnabled ? 'welcome.action.goodbyeOn' : 'welcome.action.goodbyeOff'));
        },
        async welcome(ctx, form) {
            const tr = textFor(ctx);
            const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
            return update(ctx, changedOnly({
                channelId: channelField(ctx.guild, form, 'channelId', { label: tr.t('welcome.join.channel') }),
                welcomePing: checkbox(form, 'welcomePing'),
                // Sent empty = cleared (the bot then posts its default welcome); absent = unchanged.
                ...sentText(form, 'welcomeMessage'),
                ...sentText(form, 'dmMessage'),
            }, current), tr.t('welcome.action.welcomeSaved'));
        },
        async goodbye(ctx, form) {
            const tr = textFor(ctx);
            const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
            return update(ctx, changedOnly({
                goodbyeChannelId: channelField(ctx.guild, form, 'goodbyeChannelId', { label: tr.t('welcome.leave.channel') }),
                goodbyePing: checkbox(form, 'goodbyePing'),
                ...sentText(form, 'leaveMessage'),
            }, current), tr.t('welcome.action.goodbyeSaved'));
        },
        'welcome-embed': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                const { url, warning } = imageUrlField(form, 'welcomeImage', tr.t('welcome.embed.welcomeImage'));
                const welcomeEmbed = embedWith(current.welcomeEmbed, {
                    title: text(form, 'welcomeTitle', EMBED_TITLE_MAX),
                    footer: text(form, 'welcomeFooter', EMBED_FOOTER_MAX),
                    color: colourField(form, 'welcomeColor', tr.t('welcome.embed.embedColour')),
                });
                // A stored upload (see welcomeImageStore.js) is kept only while its link is the one saved.
                const welcomeImageRef = url && current.welcomeImageRef?.url === url ? current.welcomeImageRef : null;
                const result = await update(ctx, changedOnly({ welcomeEmbed, welcomeImage: url, welcomeImageRef }, current), tr.t('welcome.action.welcomeEmbedSaved'));
                return warning && result.changes.length ? { ...result, warnings: [warning] } : result;
            },
        },
        'goodbye-embed': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                const { url, warning } = imageUrlField(form, 'goodbyeImage', tr.t('welcome.embed.goodbyeImage'));
                const leaveEmbed = embedWith(current.leaveEmbed, {
                    title: text(form, 'goodbyeTitle', EMBED_TITLE_MAX),
                    footer: text(form, 'goodbyeFooter', EMBED_FOOTER_MAX),
                    color: colourField(form, 'goodbyeColor', tr.t('welcome.embed.embedColour')),
                });
                // The goodbye image lives in leaveEmbed.image (as /greet saves it).
                if (url) leaveEmbed.image = url;
                else delete leaveEmbed.image;
                const goodbyeImageRef = url && current.goodbyeImageRef?.url === url ? current.goodbyeImageRef : null;
                const result = await update(ctx, changedOnly({ leaveEmbed, goodbyeImageRef }, current), tr.t('welcome.action.goodbyeEmbedSaved'));
                return warning && result.changes.length ? { ...result, warnings: [warning] } : result;
            },
        },
        // Uploads: the file is re-posted with the /greet store, then saved exactly as
        // /greet dashboard saves it (link = the stored message's attachment, plus its ref).
        'welcome-image-upload': {
            admin: true,
            upload: true,
            async run(ctx) {
                const tr = textFor(ctx);
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                const ref = await storeUpload(ctx, 'welcome', tr.t('welcome.embed.welcomeImage'));
                const result = await saveStored(ctx, ref, changedOnly({ welcomeImage: ref.url, welcomeImageRef: ref }, current), tr.t(IMAGE_TEXT.welcome.uploaded));
                return { ...result, message: uploadedMessage(ctx, ref, 'welcome') };
            },
        },
        'goodbye-image-upload': {
            admin: true,
            upload: true,
            async run(ctx) {
                const tr = textFor(ctx);
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                const ref = await storeUpload(ctx, 'goodbye', tr.t('welcome.embed.goodbyeImage'));
                const leaveEmbed = { ...(current.leaveEmbed && typeof current.leaveEmbed === 'object' ? current.leaveEmbed : {}), image: ref.url };
                const result = await saveStored(ctx, ref, changedOnly({ leaveEmbed, goodbyeImageRef: ref }, current), tr.t(IMAGE_TEXT.goodbye.uploaded));
                return { ...result, message: uploadedMessage(ctx, ref, 'goodbye') };
            },
        },
        // Remove: no image (as /greet with an empty link). The stored copy's message is kept.
        'welcome-image-remove': {
            admin: true,
            async run(ctx) {
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                return update(ctx, changedOnly({ welcomeImage: null, welcomeImageRef: null }, current), textFor(ctx).t('welcome.action.welcomeImageRemoved'));
            },
        },
        'goodbye-image-remove': {
            admin: true,
            async run(ctx) {
                const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
                const leaveEmbed = { ...(current.leaveEmbed && typeof current.leaveEmbed === 'object' ? current.leaveEmbed : {}) };
                delete leaveEmbed.image;
                return update(ctx, changedOnly({ leaveEmbed, goodbyeImageRef: null }, current), textFor(ctx).t('welcome.action.goodbyeImageRemoved'));
            },
        },
        // Administrator only: roles the bot gives to new members.
        'autorole-add': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const roleId = autoRoleField(ctx.guild, form, 'roleId', { optional: false, label: tr.t('welcome.autoRole.pick') });
                const { before, after, changed } = await ctx.services.addAutoRole(ctx.client, ctx.guildId, roleId);
                if (!changed) return { changes: [], message: tr.t('welcome.action.autoRoleAlready') };
                return { changes: diffSnapshots(before, after, ['roleIds']), message: tr.t('welcome.action.autoRoleSet') };
            },
        },
        // Administrator only: roles the bot gives to new members.
        'autorole-remove': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const roleId = text(form, 'roleId', 25);
                const { before, after, changed } = await ctx.services.removeAutoRole(ctx.client, ctx.guildId, roleId);
                if (!changed) return { changes: [], message: tr.t('welcome.action.autoRoleNotSet') };
                return { changes: diffSnapshots(before, after, ['roleIds']), message: tr.t('welcome.action.autoRoleRemoved') };
            },
        },
        // Administrator only: roles the bot gives to new members.
        'autorole-delay': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const autoRoleDelay = intField(form, 'autoRoleDelay', { min: 0, max: 3600, label: tr.t('welcome.autoRole.delayLabel') });
                return update(ctx, { autoRoleDelay }, tr.t('welcome.action.delaySaved'));
            },
        },
        async logs(ctx, form) {
            const tr = textFor(ctx);
            const current = await ctx.services.getWelcomeSettings(ctx.client, ctx.guildId);
            return update(ctx, changedOnly({
                joinLogs: { enabled: checkbox(form, 'joinLogsEnabled'), channelId: channelField(ctx.guild, form, 'joinLogsChannelId', { label: tr.t('welcome.logs.joinChannel') }) },
                leaveLogs: { enabled: checkbox(form, 'leaveLogsEnabled'), channelId: channelField(ctx.guild, form, 'leaveLogsChannelId', { label: tr.t('welcome.logs.leaveChannel') }) },
            }, current), tr.t('welcome.action.logsSaved'));
        },
    }),
};
