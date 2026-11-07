// rules.js — Rules: the main server's rules (an ordered list, max 30: short title, text and
// an optional consequence), shown on the public /rules page, and which prebuilt reason links
// to which rule. A case with a linked reason gets "Rule 3: No spam" (+ the /rules link when
// PUBLIC_URL is set) in the member's punishment DM (dmTemplates.js via
// services/rules/serverRules.js); the /enforcements confirm step shows the rule and its
// listed consequence as a hint.
//
// Rules can be written by hand or added from the ready-made library (config/rulesLibrary.js):
// a library rule is a normal rule plus `preset` (its library key), and adding it links the
// library's reason when that reason is not linked yet.
//
// "Post to Discord": the rules as embeds in a channel (services/rules/rulesPost.js), styled
// here (title, colour, intro, footer, layout, banner and thumbnail). The design is the
// rulesPost setting; `posted` keeps the message ids so "Update posted message" edits them in
// place. Uploaded pictures are stored like the Welcome page's (storeUpload → the audit log
// channel) and attached to the rules message at post time.
//
// Stored as registry settings in guild_settings (serverRules, reasonRuleLinks, rulesPost),
// so the settings service validates them, writes under a row lock and writes the audit rows;
// the mod-log line names what changed. Rules keep a stable id: moving or deleting one never
// re-points a reason link (a link to a deleted rule is removed with it).
//
// Words: src/content/dashboard/<lang>/rules.json. Not translated here: the library rules and
// reason labels (config), the post preview's own text (rulesPost.js), the note stored with an
// uploaded picture in Discord, and the audit/mod-log rows.

import { ENFORCEMENT_REASONS } from '../../../config/enforcement.js';
import { RULES_LIBRARY, libraryRule } from '../../../config/rulesLibrary.js';
import { html, raw } from '../html.js';
import {
    InputError, PERMS, buttonForm, channelField, channelName, channelPicker, choiceField, pill, postForm, selectInput, text, textArea, textInput,
} from '../forms.js';
import { NOTHING, registryValue, saveRegistry, section, table } from './common.js';
import { imageUrlField, storeUpload } from './welcome.js';
import { MAX_UPLOAD_BYTES } from '../multipart.js';
import { isAllowedImageUrl, isSafeLink } from '../pages.js';
import {
    RULES_LIMITS, addRule, deleteRule, editRule, moveRule, numberedRules, pruneLinks,
} from '../../rules/serverRules.js';
import {
    buildRulesMessages, postAndSaveRules, rulesMessagesFor, rulesPostDesign, serializedRules, updateAndSaveRules,
} from '../../rules/rulesPost.js';
import { RULES_POST_LIMITS } from '../../settings/settingsRegistry.js';
import { EMBED_COLOURS, colourFromKey, parseHexColour } from '../../botMessageService.js';
import { siteOrigin } from '../../site/shell.js';
import { logger } from '../../../utils/logger.js';
import { textFor } from '../language.js';

const { maxRules, titleMax, textMax, consequenceMax } = RULES_LIMITS;
const RULE_ID = /^[a-z0-9]{4,16}$/;
/** English names (stored-picture note in Discord); the page uses rules.image.<name>.* */
const IMAGES = { banner: 'Banner', thumbnail: 'Thumbnail' };
const UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);

const clip = (value, max = 120) => {
    const t = String(value ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const hexOf = (value) => `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
const reasonLabel = (key) => ENFORCEMENT_REASONS.find((r) => r.key === key)?.label || key;
/** A banner / thumbnail text: rules.image.banner.<part> or rules.image.thumbnail.<part>. */
const imageText = (tr, name, part, params) => tr.t(`rules.image.${name === 'banner' ? 'banner' : 'thumbnail'}.${part}`, params);

// One change at a time: each action reads the list, changes it and writes it back. The
// queue is shared with /rules (services/rules/rulesPost.js), so a post from Discord and
// one from here never overlap.
const serialized = serializedRules;

function current(ctx) {
    return { value: registryValue(ctx, 'serverRules'), links: registryValue(ctx, 'reasonRuleLinks') || {} };
}

/** The saved post design (the defaults filled in for keys an older value lacks). */
function currentPost(ctx) {
    return rulesPostDesign(registryValue(ctx, 'rulesPost'));
}

/** A textarea value: line breaks normalised, trimmed, refused (never cut) over `max`. */
function longText(form, name, max, label, tr) {
    const value = typeof form?.[name] === 'string' ? form[name].replace(/\r\n?/g, '\n').trim() : '';
    if (value.length > max) throw new InputError(tr.t('rules.error.tooLong', { label, max: tr.fmtNumber(max), length: tr.fmtNumber(value.length) }), 400, name);
    return value;
}

/** A one-line text field, refused (never cut) over `max` or with a line break. */
function lineText(form, name, max, label, tr) {
    const value = typeof form?.[name] === 'string' ? form[name].trim() : '';
    if (value.length > max) throw new InputError(tr.t('rules.error.tooLong', { label, max: tr.fmtNumber(max), length: tr.fmtNumber(value.length) }), 400, name);
    if (/[\r\n]/.test(value)) throw new InputError(tr.t('rules.error.oneLine', { label }), 400, name);
    return value;
}

/** Title (required, one line, ≤ 80), text (≤ 1000, line breaks kept), consequence (≤ 100, one line). */
function ruleFields(form, tr) {
    const title = text(form, 'title', titleMax);
    if (!title) throw new InputError(tr.t('rules.error.needsTitle'), 400, 'title');
    if (/[\r\n]/.test(title)) throw new InputError(tr.t('rules.error.titleOneLine'), 400, 'title');
    const ruleTextValue = typeof form?.text === 'string' ? form.text.replace(/\r\n?/g, '\n').trim() : '';
    if (ruleTextValue.length > textMax) {
        throw new InputError(tr.t('rules.error.tooLong', { label: tr.t('rules.error.ruleText'), max: tr.fmtNumber(textMax), length: tr.fmtNumber(ruleTextValue.length) }), 400, 'text');
    }
    const consequence = lineText(form, 'consequence', consequenceMax, tr.t('rules.rule.consequence'), tr);
    return { title, text: ruleTextValue, consequence };
}

/** The posted rule id, which must be a rule that exists now. */
function existingRule(ctx, form) {
    const id = text(form, 'id', 16);
    const { rules } = numberedRules(current(ctx).value);
    const rule = RULE_ID.test(id) ? rules.find((r) => r.id === id) : null;
    if (!rule) throw new InputError(textFor(ctx).t('rules.error.ruleGone'));
    return rule;
}

function ruleText(rule) {
    if (!rule) return null;
    return `${rule.title}${rule.text ? `: ${clip(rule.text, 200)}` : ''}${rule.consequence ? ` (consequence: ${rule.consequence})` : ''}`;
}

// ── Post to Discord ───────────────────────────────────────────────────────

/** The colour: a typed hex code wins, else one of the fixed choices. */
function colourFromForm(form, tr) {
    const hex = text(form, 'hex', 7);
    if (hex) {
        const value = parseHexColour(hex);
        if (value === null) throw new InputError(tr.t('rules.error.colourHex'), 400, 'hex');
        return value;
    }
    const value = colourFromKey(text(form, 'colour', 20) || 'primary');
    if (value === null) throw new InputError(tr.t('rules.error.colourChoice'), 400, 'colour');
    return value;
}

/** The colour used for the post: the saved one, else Mewvo blue. */
const postColour = (design) => (Number.isInteger(design.colour) ? design.colour : colourFromKey('primary'));

/** A picture from the design form's link field: the stored upload is kept while its link is unchanged. */
function imageFromForm(form, name, saved, linkLabel) {
    // The saved upload posted back unchanged: kept as it is. Its Discord link expires after a
    // day, but the post loads a fresh one from the stored message, so it must not be checked.
    if (saved?.ref && text(form, `${name}Url`, 2048) === saved.url) return { image: saved, warning: null };
    const { url, warning } = imageUrlField(form, `${name}Url`, linkLabel);
    if (!url) return { image: null, warning: null };
    const ref = saved?.url === url ? saved.ref || null : null;
    return { image: { url, ref }, warning };
}

/** Short text for the audit / mod log of a design value. */
function describeImage(image) {
    if (!image) return null;
    return image.ref ? 'uploaded picture' : image.url;
}

/** Saves a new rulesPost value; `changes` are the readable rows for the mod log. */
async function savePost(ctx, next, changes, message) {
    if (!changes.length) return NOTHING;
    await saveRegistry(ctx, { rulesPost: next }, 'rules');
    return { changes, audited: true, message };
}

/** The design's messages with the pictures as they are at post time (uploads attached). */
async function messagesFor(ctx, design) {
    const { rules } = numberedRules(current(ctx).value);
    return rulesMessagesFor({ client: ctx.client, guildId: ctx.guildId, rules, design: { ...design, colour: postColour(design) }, resolve: ctx.services.resolveWelcomeImageUrl });
}

/** True for errors meant for the admin (refusals with a readable message). */
const isReadable = (error) => error instanceof InputError || ['validation', 'permission', 'user_input', 'configuration'].includes(error?.type);

/** Runs a Discord-side call; an unexpected Discord error becomes a readable refusal. */
async function discordCall(task, refusal, tr) {
    try {
        return await task();
    } catch (error) {
        if (isReadable(error)) throw error;
        logger.warn(`Dashboard rules post: ${error.message}`);
        throw new InputError(tr.t('rules.error.discordSaid', { refusal, detail: clip(error.message, 200) }));
    }
}

/** Escaped text with the **bold** and *italic* Discord uses in the post turned into tags. */
function markdownPreview(value) {
    const escaped = String(html`${value}`);
    return raw(escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>'));
}

/** A picture in the preview: shown when it is on Discord (the page's security rules allow only that), else its link as text. */
function previewImage(tr, url, label, className) {
    if (!url) return '';
    if (url.startsWith('attachment://')) return html`<p class="muted">${tr.t('rules.preview.uploaded', { label })}</p>`;
    if (isAllowedImageUrl(url)) return html`<img class="${className}" src="${url}" alt="${label}" loading="lazy" referrerpolicy="no-referrer">`;
    return html`<p class="muted">${tr.t('rules.preview.link', { label, url })}</p>`;
}

/** An HTML look-alike of the post: every message with its embeds (coloured edge, title, text, fields, footer). */
function postPreview(d, tr) {
    const { design, rules } = d;
    if (!rules.length) return html`<p class="muted">${tr.t('rules.preview.empty')}</p>`;
    let messages;
    try {
        const images = {
            banner: design.banner ? { url: d.images.banner.fresh || design.banner.url } : null,
            thumbnail: design.thumbnail ? { url: d.images.thumbnail.fresh || design.thumbnail.url } : null,
        };
        messages = buildRulesMessages(rules, { ...design, colour: postColour(design) }, images);
    } catch (error) {
        return html`<p class="error" role="alert">${error.userMessage || error.message}</p>`;
    }
    const edge = hexOf(postColour(design));
    const embedHtml = (embed) => {
        const e = embed.data;
        return html`<div class="rules-embed"><svg class="rules-embed-edge" viewBox="0 0 4 10" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect width="4" height="10" fill="${edge}"></rect></svg><div class="rules-embed-body">
${e.thumbnail ? previewImage(tr, e.thumbnail.url, imageText(tr, 'thumbnail', 'title'), 'rules-embed-thumb') : ''}
${e.title ? html`<p class="rules-embed-title">${e.title}</p>` : ''}
${e.description ? html`<p class="rules-embed-text">${markdownPreview(e.description)}</p>` : ''}
${(e.fields || []).map((f) => html`<div class="rules-embed-field"><p class="rules-embed-field-name">${f.name}</p><p class="rules-embed-text">${f.value === '​' ? '' : markdownPreview(f.value)}</p></div>`)}
${e.image ? previewImage(tr, e.image.url, imageText(tr, 'banner', 'title'), 'rules-embed-banner') : ''}
${e.footer ? html`<p class="rules-embed-footer">${e.footer.text}</p>` : ''}</div></div>`;
    };
    return html`<p>${tr.tx('rules.preview.needs', { messages: html`<strong>${tr.tp('rules.preview.messages', messages.length)}</strong>` })}</p>
<div class="rules-preview">${messages.map((m, i) => html`<div class="rules-preview-msg">${messages.length > 1 ? html`<p class="muted">${tr.t('rules.preview.message', { number: tr.fmtNumber(i + 1) })}</p>` : ''}${m.embeds.map(embedHtml)}</div>`)}</div>
<p class="muted">${tr.t('rules.preview.note')}</p>`;
}

/** The current picture, its upload form and Remove, for the banner or the thumbnail. */
function imageBlock(ctx, name, image, preview) {
    const tr = textFor(ctx);
    const say = (part, params) => imageText(tr, name, part, params);
    const canAdmin = ctx.canEdit && ctx.canAct;
    let shown;
    if (!image) shown = html`<p class="muted">${say('none')}</p>`;
    else if (isAllowedImageUrl(preview)) shown = html`<img class="image-preview" src="${preview}" alt="${say('alt')}" loading="lazy" referrerpolicy="no-referrer">`;
    else if (isSafeLink(image.url)) shown = html`<p>${tr.tx(`rules.image.${name === 'banner' ? 'banner' : 'thumbnail'}.current`, { link: html`<a href="${image.url}" rel="noopener noreferrer" target="_blank">${image.url}</a>` })} <span class="muted">${tr.t('rules.image.onlyDiscord')}</span></p>`;
    else shown = html`<p>${tr.tx(`rules.image.${name === 'banner' ? 'banner' : 'thumbnail'}.current`, { link: html`<code>${image.url}</code>` })}</p>`;
    const storedIn = image?.ref ? ctx.guild?.channels?.cache?.get(image.ref.channelId) : null;
    const stored = image?.ref
        ? html`<p class="hint">${tr.tx('rules.image.stored', { where: storedIn ? html`#${storedIn.name}` : tr.t('rules.image.storedChannel', { id: image.ref.channelId }) })}</p>`
        : '';
    const upload = postForm(ctx, 'rules', `${name}-upload`, html`<div class="grid"><label class="wide">${say('uploadLabel', { mb: tr.fmtNumber(UPLOAD_MB) })}<input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required><span class="hint">${say('uploadHint')}</span></label></div>`,
        { submit: say('upload'), multipart: true, canEdit: canAdmin });
    const remove = image ? buttonForm(ctx, 'rules', `${name}-remove`, say('remove'), {}, { confirm: say('removeConfirm') }) : '';
    return html`<h3>${say('title')}</h3><div class="image-current">${shown}${stored}</div>${upload}${remove}`;
}

function postSection(ctx, d) {
    const tr = textFor(ctx);
    const g = ctx.guild;
    const { design } = d;
    const colourHex = Number.isInteger(design.colour) ? hexOf(design.colour) : '';
    const known = colourHex ? EMBED_COLOURS.find(([, , h]) => h.toUpperCase() === colourHex) : EMBED_COLOURS[0];
    const colourLabel = (key, label) => (tr.has(`rules.colours.${key}`) ? tr.t(`rules.colours.${key}`) : label);
    const form = postForm(ctx, 'rules', 'post-design', html`<div class="grid">
${channelPicker(g, 'channelId', design.channelId, { label: tr.t('rules.design.channel'), perms: PERMS.post, help: tr.t('rules.design.channelHelp') })}
${textInput('title', design.title, { label: tr.t('rules.design.title'), max: RULES_POST_LIMITS.titleMax, help: tr.t('rules.design.titleHelp') })}
${selectInput('colour', known ? known[0] : 'primary', EMBED_COLOURS.map(([key, label, h]) => [key, `${colourLabel(key, label)} (${h})`]), { label: tr.t('rules.design.colour'), help: tr.t('rules.design.colourHelp') })}
${textInput('hex', known ? '' : colourHex, { label: tr.t('rules.design.hex'), max: 7, placeholder: '#9B59B6', help: tr.t('rules.design.hexHelp') })}
${textArea('intro', design.intro, { label: tr.t('rules.design.intro'), max: RULES_POST_LIMITS.introMax, rows: 3, help: tr.t('rules.design.introHelp') })}
${textInput('footer', design.footer, { label: tr.t('rules.design.footer'), max: RULES_POST_LIMITS.footerMax, help: tr.t('rules.design.footerHelp') })}
${selectInput('layout', design.layout, [['list', tr.t('rules.design.layoutList')], ['fields', tr.t('rules.design.layoutFields')]], { label: tr.t('rules.design.layout'), help: tr.t('rules.design.layoutHelp') })}
${textInput('bannerUrl', design.banner?.url || '', { label: tr.t('rules.design.bannerUrl'), max: 2048, type: 'url', placeholder: 'https://example.com/banner.png', help: tr.t('rules.design.bannerUrlHelp') })}
${textInput('thumbnailUrl', design.thumbnail?.url || '', { label: tr.t('rules.design.thumbnailUrl'), max: 2048, type: 'url', placeholder: 'https://example.com/logo.png', help: tr.t('rules.design.thumbnailUrlHelp') })}</div>`,
    { submit: tr.t('rules.design.submit'), reset: true });

    const channel = design.channelId ? g?.channels?.cache?.get(design.channelId) : null;
    const canAdmin = ctx.canEdit && ctx.canAct;
    let post;
    if (!design.channelId) post = html`<p class="muted">${tr.t('rules.post.noChannel')}</p>`;
    else if (!channel) post = html`<p class="warn">${tr.t('rules.post.channelGone')}</p>`;
    else {
        const confirm = design.posted
            ? tr.t('rules.post.confirmAgain', { channel: channel.name })
            : tr.t('rules.post.confirm', { channel: channel.name });
        post = buttonForm(ctx, 'rules', 'post', tr.t('rules.post.button', { channel: channel.name }), {}, { confirm, danger: false, canEdit: canAdmin });
    }
    let posted = html`<p class="muted">${tr.t('rules.post.notPosted')}</p>`;
    if (design.posted) {
        const where = g?.channels?.cache?.get(design.posted.channelId);
        const count = design.posted.messageIds.length;
        const postedIn = tr.tx('rules.post.postedIn', { channel: channelName(g, design.posted.channelId), date: tr.fmtDateTime(design.posted.at), messages: tr.tp('rules.preview.messages', count) });
        posted = html`<p>${postedIn}${where && design.channelId && design.channelId !== design.posted.channelId ? html` <span class="muted">${tr.t('rules.post.moved')}</span>` : ''}</p>
${buttonForm(ctx, 'rules', 'post-update', tr.t('rules.post.update'), {}, { confirm: tr.t('rules.post.updateConfirm'), danger: false, canEdit: canAdmin })}`;
    }
    return html`${form}
${imageBlock(ctx, 'banner', design.banner, d.images.banner.fresh)}
${imageBlock(ctx, 'thumbnail', design.thumbnail, d.images.thumbnail.fresh)}
<h3>${tr.t('rules.post.preview')}</h3>${postPreview(d, tr)}
<h3>${tr.t('rules.post.title')}</h3>${posted}${post}`;
}

/** The fresh link of a stored picture for the preview (the saved link when it cannot be refreshed). */
async function previewUrl(ctx, image, label) {
    if (!image?.url) return { fresh: null };
    if (!image.ref) return { fresh: image.url };
    try {
        return { fresh: (await ctx.services.resolveWelcomeImageUrl?.(ctx.client, image.url, image.ref, { guildId: ctx.guildId, label })) || image.url };
    } catch {
        return { fresh: image.url };
    }
}

/** Stores an uploaded banner or thumbnail and saves it; the stored copy is deleted again when the save fails. */
async function uploadImage(ctx, name) {
    const tr = textFor(ctx);
    const label = IMAGES[name];
    // The note stored with the picture in Discord stays English (like the bot's other log posts).
    const ref = await storeUpload(ctx, `rules-${name}`, imageText(tr, name, 'title'), {
        content: `Stored ${label.toLowerCase()} for the server rules post (dashboard Rules page). Please keep this message: Mewvo loads the picture from here when it posts or updates the rules.`,
    });
    try {
        return await serialized(async () => {
            const design = currentPost(ctx);
            const next = { ...design, [name]: { url: ref.url, ref } };
            const storedIn = ctx.guild?.channels?.cache?.get(ref.channelId);
            const result = await savePost(ctx, next, [{ key: `rules post ${name}`, old: describeImage(design[name]), new: 'uploaded picture' }], '');
            return { ...result, message: imageText(tr, name, 'uploaded', { where: storedIn ? `#${storedIn.name}` : tr.t('rules.image.mainLog') }) };
        });
    } catch (error) {
        const channel = ctx.guild?.channels?.cache?.get(ref.channelId);
        await Promise.resolve(channel?.messages?.delete?.(ref.messageId)).catch(() => {});
        throw error;
    }
}

function removeImage(ctx, name) {
    const tr = textFor(ctx);
    return serialized(async () => {
        const design = currentPost(ctx);
        if (!design[name]) return NOTHING;
        return savePost(ctx, { ...design, [name]: null }, [{ key: `rules post ${name}`, old: describeImage(design[name]), new: null }], imageText(tr, name, 'removed'));
    });
}

export default {
    key: 'rules',
    label: 'Rules',
    help: 'Write your server rules once. Members can read them on a web page, and when someone is punished, the private message (DM) they get can name the rule they broke and link to it.',

    async load(ctx) {
        const { value, links } = current(ctx);
        const design = currentPost(ctx);
        const [banner, thumbnail] = await Promise.all([previewUrl(ctx, design.banner, 'rules banner'), previewUrl(ctx, design.thumbnail, 'rules thumbnail')]);
        return { ...numberedRules(value), links, design, images: { banner, thumbnail }, origin: siteOrigin(ctx.env || process.env) };
    },

    render(ctx, d) {
        const tr = textFor(ctx);
        const last = d.rules.length - 1;
        const none = html`<span class="muted">${tr.t('rules.list.none')}</span>`;
        const rows = d.rules.map((rule, i) => [
            html`<span class="num">${rule.number}</span>`,
            html`<strong>${rule.title}</strong>${rule.text ? html`<br><span class="muted">${clip(rule.text)}</span>` : ''}`,
            rule.consequence ? rule.consequence : none,
            html`<div class="row-actions">${i > 0 ? buttonForm(ctx, 'rules', 'rule-move', tr.t('rules.list.moveUp'), { id: rule.id, direction: 'up' }) : ''}${i < last ? buttonForm(ctx, 'rules', 'rule-move', tr.t('rules.list.moveDown'), { id: rule.id, direction: 'down' }) : ''}${buttonForm(ctx, 'rules', 'rule-delete', tr.t('rules.list.delete'), { id: rule.id }, { confirm: tr.t('rules.list.deleteConfirm', { number: rule.number, title: clip(rule.title, 60) }) })}</div>`,
        ]);
        const consequenceHelp = tr.t('rules.rule.consequenceHelp');
        const edits = d.rules.map((rule) => html`<details class="sub" data-key="rule-${rule.id}"><summary>${tr.t('rules.rule.edit', { number: rule.number, title: clip(rule.title, 60) })}</summary>
${postForm(ctx, 'rules', 'rule-edit', html`<div class="grid">
${textInput('title', rule.title, { label: tr.t('rules.rule.title'), max: titleMax, help: tr.t('rules.rule.titleHelp') })}
${textArea('text', rule.text, { label: tr.t('rules.rule.text'), max: textMax, rows: 4, help: tr.t('rules.rule.textHelp') })}
${textInput('consequence', rule.consequence, { label: tr.t('rules.rule.consequence'), max: consequenceMax, help: consequenceHelp })}</div>`, { submit: tr.t('rules.rule.save'), hidden: { id: rule.id }, reset: true })}</details>`);
        const full = d.rules.length >= maxRules;
        const add = full
            ? html`<p class="muted">${tr.t('rules.rule.full', { max: tr.fmtNumber(maxRules) })}</p>`
            : postForm(ctx, 'rules', 'rule-add', html`<div class="grid">
${textInput('title', '', { label: tr.t('rules.rule.title'), max: titleMax, placeholder: tr.t('rules.rule.titlePlaceholder'), help: tr.t('rules.rule.titleHelp') })}
${textArea('text', '', { label: tr.t('rules.rule.text'), max: textMax, rows: 4, help: tr.t('rules.rule.textHelp') })}
${textInput('consequence', '', { label: tr.t('rules.rule.consequence'), max: consequenceMax, placeholder: tr.t('rules.rule.consequencePlaceholder'), help: consequenceHelp })}</div>`, { submit: tr.t('rules.rule.add'), inline: false });

        const added = new Set(d.rules.map((r) => r.preset).filter(Boolean));
        const libraryRows = RULES_LIBRARY.map((entry) => [
            html`<strong>${entry.title}</strong><br><span class="muted">${entry.text}</span>`,
            entry.consequence,
            entry.reason ? reasonLabel(entry.reason) : none,
            added.has(entry.key)
                ? pill(false, tr.t('rules.library.added'))
                : full ? html`<span class="muted">${tr.t('rules.library.full')}</span>` : buttonForm(ctx, 'rules', 'library-add', tr.t('rules.library.add'), { key: entry.key }),
        ]);
        const library = html`${table([tr.t('rules.list.rule'), tr.t('rules.rule.consequence'), tr.t('rules.library.reason'), ''], libraryRows)}`;

        const choices = [['', tr.t('rules.links.noRule')], ...d.rules.map((r) => [r.id, tr.t('rules.links.rule', { number: r.number, title: clip(r.title, 60) })])];
        const links = d.rules.length
            ? postForm(ctx, 'rules', 'links', html`<div class="grid">${ENFORCEMENT_REASONS.map((reason) => selectInput(`link_${reason.key}`, d.links[reason.key] || '', choices, { label: reason.label }))}</div>`)
            : html`<p class="muted">${tr.t('rules.links.empty')}</p>`;
        const updated = d.updatedAt ? html` ${tr.t('rules.list.updated', { date: tr.fmtDateTime(d.updatedAt) })}` : '';
        const page = d.origin
            ? html` ${tr.tx('rules.list.pageAt', { link: html`<a href="${`${d.origin}/rules`}" rel="noopener">${d.origin}/rules</a>` })}`
            : ` ${tr.t('rules.list.pageNoSite')}`;
        // Card keys: the English titles' slugs (stable ids in every language).
        return html`${section(tr.t('rules.list.title'), html`${table([tr.t('rules.list.no'), tr.t('rules.list.rule'), tr.t('rules.rule.consequence'), ''], rows, tr.t('rules.list.empty'))}${edits}`,
            html`${tr.t('rules.list.count', { count: tr.fmtNumber(d.rules.length), max: tr.fmtNumber(maxRules) })}${updated}${page}`, { key: 'rules' })}
${section(tr.t('rules.rule.addTitle'), add, '', { key: 'add-a-rule' })}
${section(tr.t('rules.library.title'), library, [tr.t('rules.library.help'), tr.t('rules.library.more')], { key: 'library' })}
${section(tr.t('rules.links.title'), links, tr.t('rules.links.help'), { key: 'reasons-linked-to-rules' })}
${section(tr.t('rules.post.sectionTitle'), postSection(ctx, d), [tr.t('rules.post.help'), tr.t('rules.post.more')], { key: 'post', size: 'full' })}`;
    },

    actions: {
        'rule-add'(ctx, form) {
            const tr = textFor(ctx);
            const fields = ruleFields(form, tr);
            return serialized(async () => {
                const { value } = current(ctx);
                const next = addRule(value, fields);
                if (!next) throw new InputError(tr.t('rules.error.full', { max: tr.fmtNumber(maxRules) }));
                await saveRegistry(ctx, { serverRules: next }, 'rules');
                const number = next.rules.length;
                return { changes: [{ key: `rule ${number}`, old: null, new: ruleText(fields) }], audited: true, message: tr.t('rules.action.added', { number }) };
            });
        },
        'rule-edit'(ctx, form) {
            const tr = textFor(ctx);
            const fields = ruleFields(form, tr);
            return serialized(async () => {
                const rule = existingRule(ctx, form);
                if (rule.title === fields.title && rule.text === fields.text && rule.consequence === fields.consequence) return NOTHING;
                await saveRegistry(ctx, { serverRules: editRule(current(ctx).value, rule.id, fields) }, 'rules');
                return { changes: [{ key: `rule ${rule.number}`, old: ruleText(rule), new: ruleText(fields) }], audited: true, message: tr.t('rules.action.saved', { number: rule.number }) };
            });
        },
        'library-add'(ctx, form) {
            const tr = textFor(ctx);
            const key = text(form, 'key', 40);
            const entry = libraryRule(key);
            if (!entry) throw new InputError(tr.t('rules.error.libraryGone'), 400, 'key');
            return serialized(async () => {
                const { value, links } = current(ctx);
                const { rules } = numberedRules(value);
                if (rules.some((r) => r.preset === entry.key)) throw new InputError(tr.t('rules.error.alreadyAdded', { title: entry.title }));
                const fields = { title: entry.title, text: entry.text, consequence: entry.consequence, preset: entry.key };
                const next = addRule(value, fields);
                if (!next) throw new InputError(tr.t('rules.error.full', { max: tr.fmtNumber(maxRules) }));
                const number = next.rules.length;
                const patch = { serverRules: next };
                const changes = [{ key: `rule ${number}`, old: null, new: ruleText(fields) }];
                let linked = '';
                if (entry.reason && !links[entry.reason]) {
                    patch.reasonRuleLinks = { ...links, [entry.reason]: next.rules[number - 1].id };
                    changes.push({ key: `reason ${entry.reason}`, old: null, new: `rule ${number}: ${entry.title}` });
                    linked = ` ${tr.t('rules.action.reasonLinked', { reason: reasonLabel(entry.reason) })}`;
                }
                await saveRegistry(ctx, patch, 'rules');
                return { changes, audited: true, message: `${tr.t('rules.action.libraryAdded', { number, title: entry.title })}${linked}` };
            });
        },
        'rule-delete'(ctx, form) {
            const tr = textFor(ctx);
            return serialized(async () => {
                const rule = existingRule(ctx, form);
                const { value, links } = current(ctx);
                const next = deleteRule(value, rule.id);
                const pruned = pruneLinks(links, next);
                const patch = { serverRules: next };
                if (Object.keys(pruned).length !== Object.keys(links).length) patch.reasonRuleLinks = pruned;
                await saveRegistry(ctx, patch, 'rules');
                return { changes: [{ key: `rule ${rule.number}`, old: ruleText(rule), new: null }], audited: true, message: tr.t('rules.action.deleted', { number: rule.number }) };
            });
        },
        'rule-move'(ctx, form) {
            const tr = textFor(ctx);
            const direction = choiceField(form, 'direction', ['up', 'down'], tr.t('rules.action.direction'));
            return serialized(async () => {
                const rule = existingRule(ctx, form);
                const next = moveRule(current(ctx).value, rule.id, direction === 'up' ? -1 : 1);
                if (!next) throw new InputError(tr.t(direction === 'up' ? 'rules.error.alreadyFirst' : 'rules.error.alreadyLast', { number: rule.number }));
                await saveRegistry(ctx, { serverRules: next }, 'rules');
                const to = rule.number + (direction === 'up' ? -1 : 1);
                return { changes: [{ key: `rule ${rule.number}`, old: `rule ${rule.number}: ${rule.title}`, new: `rule ${to}: ${rule.title}` }], audited: true, message: tr.t('rules.action.moved', { title: clip(rule.title, 60), number: to }) };
            });
        },
        links(ctx, form) {
            const tr = textFor(ctx);
            return serialized(async () => {
                const { value, links } = current(ctx);
                const { rules } = numberedRules(value);
                const byId = new Map(rules.map((r) => [r.id, r]));
                const next = {};
                for (const reason of ENFORCEMENT_REASONS) {
                    const id = text(form, `link_${reason.key}`, 16);
                    if (!id) continue;
                    if (!byId.has(id)) throw new InputError(tr.t('rules.error.linkGone', { reason: reason.label }), 400, `link_${reason.key}`);
                    next[reason.key] = id;
                }
                const label = (id) => (id && byId.get(id) ? `rule ${byId.get(id).number}: ${byId.get(id).title}` : null);
                const changes = ENFORCEMENT_REASONS
                    .filter((reason) => (links[reason.key] || null) !== (next[reason.key] || null))
                    .map((reason) => ({ key: `reason ${reason.key}`, old: label(links[reason.key]), new: label(next[reason.key]) }));
                if (!changes.length) return NOTHING;
                await saveRegistry(ctx, { reasonRuleLinks: next }, 'rules');
                return { changes, audited: true, message: tr.t('rules.action.linksSaved') };
            });
        },

        // ── Post to Discord ──
        'post-design'(ctx, form) {
            const tr = textFor(ctx);
            const channelId = channelField(ctx.guild, form, 'channelId', { label: tr.t('rules.design.channel') });
            const title = lineText(form, 'title', RULES_POST_LIMITS.titleMax, tr.t('rules.design.title'), tr);
            const colour = colourFromForm(form, tr);
            const intro = longText(form, 'intro', RULES_POST_LIMITS.introMax, tr.t('rules.design.intro'), tr);
            const footer = lineText(form, 'footer', RULES_POST_LIMITS.footerMax, tr.t('rules.design.footer'), tr);
            const layout = choiceField(form, 'layout', ['list', 'fields'], tr.t('rules.design.layout'));
            return serialized(async () => {
                const design = currentPost(ctx);
                const banner = imageFromForm(form, 'banner', design.banner, tr.t('rules.design.bannerUrl'));
                const thumbnail = imageFromForm(form, 'thumbnail', design.thumbnail, tr.t('rules.design.thumbnailUrl'));
                const next = { ...design, channelId, title, colour, intro, footer, layout, banner: banner.image, thumbnail: thumbnail.image };
                // [stored part, how the mod log shows it]
                const parts = {
                    channel: [(v) => v.channelId, (v) => v.channelId],
                    title: [(v) => v.title, (v) => v.title || null],
                    colour: [(v) => v.colour, (v) => (Number.isInteger(v.colour) ? hexOf(v.colour) : null)],
                    intro: [(v) => v.intro, (v) => (v.intro ? clip(v.intro, 200) : null)],
                    footer: [(v) => v.footer, (v) => v.footer || null],
                    layout: [(v) => v.layout, (v) => v.layout],
                    banner: [(v) => v.banner, (v) => describeImage(v.banner)],
                    thumbnail: [(v) => v.thumbnail, (v) => describeImage(v.thumbnail)],
                };
                const changes = Object.entries(parts)
                    .filter(([, [get]]) => JSON.stringify(get(design) ?? null) !== JSON.stringify(get(next) ?? null))
                    .map(([key, [, show]]) => ({ key: `rules post ${key}`, old: show(design), new: show(next) }));
                const result = await savePost(ctx, next, changes, tr.t('rules.action.designSaved'));
                const warnings = [banner.warning, thumbnail.warning].filter(Boolean);
                return warnings.length && result.changes.length ? { ...result, warnings } : result;
            });
        },
        'banner-upload': { admin: true, upload: true, run: (ctx) => uploadImage(ctx, 'banner') },
        'thumbnail-upload': { admin: true, upload: true, run: (ctx) => uploadImage(ctx, 'thumbnail') },
        'banner-remove': (ctx) => removeImage(ctx, 'banner'),
        'thumbnail-remove': (ctx) => removeImage(ctx, 'thumbnail'),
        post: {
            admin: true,
            run(ctx) {
                const tr = textFor(ctx);
                return serialized(async () => {
                    const design = currentPost(ctx);
                    if (!design.channelId) throw new InputError(tr.t('rules.error.postNoChannel'), 400, 'channelId');
                    const channel = ctx.guild.channels.cache.get(design.channelId);
                    if (!channel) throw new InputError(tr.t('rules.error.postChannelGone'), 400, 'channelId');
                    const messages = await messagesFor(ctx, design);
                    // Not saved: the service removes the post again, so the page never loses track of a post.
                    const { posted } = await postAndSaveRules({
                        guild: ctx.guild, channel, messages,
                        post: (guild, ch, msgs) => discordCall(() => ctx.services.postRulesMessages(guild, ch, msgs), tr.t('rules.error.postRefused'), tr),
                        save: (next) => saveRegistry(ctx, { rulesPost: { ...design, posted: next } }, 'rules'),
                    });
                    const count = posted.messageIds.length;
                    return {
                        changes: [{ key: 'rules post', old: null, new: `posted in #${channel.name} (${count} ${count === 1 ? 'message' : 'messages'})` }],
                        audited: true, message: tr.t('rules.action.posted', { channel: channel.name }),
                    };
                });
            },
        },
        'post-update': {
            admin: true,
            run(ctx) {
                const tr = textFor(ctx);
                return serialized(async () => {
                    const design = currentPost(ctx);
                    if (!design.posted) throw new InputError(tr.t('rules.error.notPosted'));
                    const messages = await messagesFor(ctx, design);
                    // Not saved: the new extra messages go again, the old ones stay. Saved: only then
                    // are the old messages the shorter post no longer needs removed (in the service).
                    const { channel, posted } = await updateAndSaveRules({
                        guild: ctx.guild, current: design.posted, messages,
                        update: (guild, current, msgs) => discordCall(() => ctx.services.updateRulesMessages(guild, current, msgs),
                            tr.t('rules.error.updateRefused'), tr),
                        save: (next) => saveRegistry(ctx, { rulesPost: { ...design, posted: next } }, 'rules'),
                    });
                    const ids = posted.messageIds;
                    const name = channel?.name ? `#${channel.name}` : 'the channel';
                    return {
                        changes: [{ key: 'rules post', old: `${design.posted.messageIds.length} messages`, new: `updated in ${name} (${ids.length} ${ids.length === 1 ? 'message' : 'messages'})` }],
                        audited: true, message: channel?.name ? tr.t('rules.action.updated', { channel: channel.name }) : tr.t('rules.action.updatedNoChannel'),
                    };
                });
            },
        },
    },
};
