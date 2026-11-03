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

import { ENFORCEMENT_REASONS } from '../../../config/enforcement.js';
import { RULES_LIBRARY, libraryRule } from '../../../config/rulesLibrary.js';
import { formatDate, html, raw } from '../html.js';
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
import { buildRulesMessages, resolveRulesImages } from '../../rules/rulesPost.js';
import { RULES_POST_DEFAULT, RULES_POST_LIMITS } from '../../settings/settingsRegistry.js';
import { EMBED_COLOURS, colourFromKey, parseHexColour } from '../../botMessageService.js';
import { siteOrigin } from '../../site/shell.js';
import { logger } from '../../../utils/logger.js';

const { maxRules, titleMax, textMax, consequenceMax } = RULES_LIMITS;
const RULE_ID = /^[a-z0-9]{4,16}$/;
const IMAGES = { banner: 'Banner', thumbnail: 'Thumbnail' };
const UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);

const clip = (value, max = 120) => {
    const t = String(value ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const hexOf = (value) => `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
const reasonLabel = (key) => ENFORCEMENT_REASONS.find((r) => r.key === key)?.label || key;

// One change at a time: each action reads the list, changes it and writes it back.
let queue = Promise.resolve();
function serialized(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
}

function current(ctx) {
    return { value: registryValue(ctx, 'serverRules'), links: registryValue(ctx, 'reasonRuleLinks') || {} };
}

/** The saved post design (the defaults filled in for keys an older value lacks). */
function currentPost(ctx) {
    const value = registryValue(ctx, 'rulesPost');
    return { ...RULES_POST_DEFAULT, ...(value && typeof value === 'object' ? value : {}) };
}

/** A textarea value: line breaks normalised, trimmed, refused (never cut) over `max`. */
function longText(form, name, max, label) {
    const value = typeof form?.[name] === 'string' ? form[name].replace(/\r\n?/g, '\n').trim() : '';
    if (value.length > max) throw new InputError(`${label} is too long: at most ${max} characters (you wrote ${value.length}).`, 400, name);
    return value;
}

/** A one-line text field, refused (never cut) over `max` or with a line break. */
function lineText(form, name, max, label) {
    const value = typeof form?.[name] === 'string' ? form[name].trim() : '';
    if (value.length > max) throw new InputError(`${label} is too long: at most ${max} characters (you wrote ${value.length}).`, 400, name);
    if (/[\r\n]/.test(value)) throw new InputError(`${label} must be one line.`, 400, name);
    return value;
}

/** Title (required, one line, ≤ 80), text (≤ 1000, line breaks kept), consequence (≤ 100, one line). */
function ruleFields(form) {
    const title = text(form, 'title', titleMax);
    if (!title) throw new InputError('A rule needs a title.', 400, 'title');
    if (/[\r\n]/.test(title)) throw new InputError('The title must be one line.', 400, 'title');
    const ruleTextValue = typeof form?.text === 'string' ? form.text.replace(/\r\n?/g, '\n').trim() : '';
    if (ruleTextValue.length > textMax) throw new InputError(`Rule text is too long: at most ${textMax} characters (you wrote ${ruleTextValue.length}).`, 400, 'text');
    const consequence = lineText(form, 'consequence', consequenceMax, 'Consequence');
    return { title, text: ruleTextValue, consequence };
}

/** The posted rule id, which must be a rule that exists now. */
function existingRule(ctx, form) {
    const id = text(form, 'id', 16);
    const { rules } = numberedRules(current(ctx).value);
    const rule = RULE_ID.test(id) ? rules.find((r) => r.id === id) : null;
    if (!rule) throw new InputError('That rule no longer exists. Reload the page.');
    return rule;
}

function ruleText(rule) {
    if (!rule) return null;
    return `${rule.title}${rule.text ? `: ${clip(rule.text, 200)}` : ''}${rule.consequence ? ` (consequence: ${rule.consequence})` : ''}`;
}

// ── Post to Discord ───────────────────────────────────────────────────────

/** The colour: a typed hex code wins, else one of the fixed choices. */
function colourFromForm(form) {
    const hex = text(form, 'hex', 7);
    if (hex) {
        const value = parseHexColour(hex);
        if (value === null) throw new InputError('Colour: write a colour code like #9B59B6, or leave it empty and pick from the list.', 400, 'hex');
        return value;
    }
    const value = colourFromKey(text(form, 'colour', 20) || 'primary');
    if (value === null) throw new InputError('Colour: unknown choice.', 400, 'colour');
    return value;
}

/** The colour used for the post: the saved one, else Mewvo blue. */
const postColour = (design) => (Number.isInteger(design.colour) ? design.colour : colourFromKey('primary'));

/** A picture from the design form's link field: the stored upload is kept while its link is unchanged. */
function imageFromForm(form, name, saved, label) {
    // The saved upload posted back unchanged: kept as it is. Its Discord link expires after a
    // day, but the post loads a fresh one from the stored message, so it must not be checked.
    if (saved?.ref && text(form, `${name}Url`, 2048) === saved.url) return { image: saved, warning: null };
    const { url, warning } = imageUrlField(form, `${name}Url`, `${label} link`);
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
    const images = await resolveRulesImages(ctx.client, ctx.guildId, design, ctx.services.resolveWelcomeImageUrl);
    return buildRulesMessages(rules, { ...design, colour: postColour(design) }, images);
}

/** True for errors meant for the admin (refusals with a readable message). */
const isReadable = (error) => error instanceof InputError || ['validation', 'permission', 'user_input', 'configuration'].includes(error?.type);

/** Runs a Discord-side call; an unexpected Discord error becomes a readable refusal. */
async function discordCall(task, refusal) {
    try {
        return await task();
    } catch (error) {
        if (isReadable(error)) throw error;
        logger.warn(`Dashboard rules post: ${error.message}`);
        throw new InputError(`${refusal} Discord said: ${clip(error.message, 200)}`);
    }
}

/** Escaped text with the **bold** and *italic* Discord uses in the post turned into tags. */
function markdownPreview(value) {
    const escaped = String(html`${value}`);
    return raw(escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>'));
}

/** A picture in the preview: shown when it is on Discord (the page's security rules allow only that), else its link as text. */
function previewImage(url, label, className) {
    if (!url) return '';
    if (url.startsWith('attachment://')) return html`<p class="muted">${label}: the uploaded picture</p>`;
    if (isAllowedImageUrl(url)) return html`<img class="${className}" src="${url}" alt="${label}" loading="lazy" referrerpolicy="no-referrer">`;
    return html`<p class="muted">${label}: ${url}</p>`;
}

/** An HTML look-alike of the post: every message with its embeds (coloured edge, title, text, fields, footer). */
function postPreview(d) {
    const { design, rules } = d;
    if (!rules.length) return html`<p class="muted">Add a rule first. The preview shows here once there is something to post.</p>`;
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
${e.thumbnail ? previewImage(e.thumbnail.url, 'Thumbnail', 'rules-embed-thumb') : ''}
${e.title ? html`<p class="rules-embed-title">${e.title}</p>` : ''}
${e.description ? html`<p class="rules-embed-text">${markdownPreview(e.description)}</p>` : ''}
${(e.fields || []).map((f) => html`<div class="rules-embed-field"><p class="rules-embed-field-name">${f.name}</p><p class="rules-embed-text">${f.value === '​' ? '' : markdownPreview(f.value)}</p></div>`)}
${e.image ? previewImage(e.image.url, 'Banner', 'rules-embed-banner') : ''}
${e.footer ? html`<p class="rules-embed-footer">${e.footer.text}</p>` : ''}</div></div>`;
    };
    return html`<p>Posting needs <strong>${messages.length} ${messages.length === 1 ? 'message' : 'messages'}</strong>.</p>
<div class="rules-preview">${messages.map((m, i) => html`<div class="rules-preview-msg">${messages.length > 1 ? html`<p class="muted">Message ${i + 1}</p>` : ''}${m.embeds.map(embedHtml)}</div>`)}</div>
<p class="muted">An approximation of how Discord shows it. Mentions in the text never ping anyone.</p>`;
}

/** The current picture, its upload form and Remove, for the banner or the thumbnail. */
function imageBlock(ctx, name, image, preview) {
    const label = IMAGES[name];
    const canAdmin = ctx.canEdit && ctx.canAct;
    let shown;
    if (!image) shown = html`<p class="muted">No ${label.toLowerCase()}.</p>`;
    else if (isAllowedImageUrl(preview)) shown = html`<img class="image-preview" src="${preview}" alt="Current ${label.toLowerCase()}" loading="lazy" referrerpolicy="no-referrer">`;
    else if (isSafeLink(image.url)) shown = html`<p>Current ${label.toLowerCase()}: <a href="${image.url}" rel="noopener noreferrer" target="_blank">${image.url}</a> <span class="muted">(only pictures stored on Discord can be shown here)</span></p>`;
    else shown = html`<p>Current ${label.toLowerCase()}: <code>${image.url}</code></p>`;
    const storedIn = image?.ref ? ctx.guild?.channels?.cache?.get(image.ref.channelId) : null;
    const stored = image?.ref
        ? html`<p class="hint">Uploaded file: a copy is kept in ${storedIn ? html`#${storedIn.name}` : html`channel ${image.ref.channelId}`}. Do not delete that message, because Mewvo loads the picture from it when it posts the rules.</p>`
        : '';
    const upload = postForm(ctx, 'rules', `${name}-upload`, html`<div class="grid"><label class="wide">Upload a ${label.toLowerCase()} (PNG, JPEG, GIF or WebP, up to ${UPLOAD_MB} MB)<input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required><span class="hint">Replaces the ${label.toLowerCase()} link. Mewvo keeps a copy in your main log channel and attaches the picture to the rules post.</span></label></div>`,
        { submit: `Upload ${label.toLowerCase()}`, multipart: true, canEdit: canAdmin });
    const remove = image ? buttonForm(ctx, 'rules', `${name}-remove`, `Remove ${label.toLowerCase()}`, {}, { confirm: `Remove the ${label.toLowerCase()}? The posted rules keep it until you update them.` }) : '';
    return html`<h3>${label}</h3><div class="image-current">${shown}${stored}</div>${upload}${remove}`;
}

function postSection(ctx, d) {
    const g = ctx.guild;
    const { design } = d;
    const colourHex = Number.isInteger(design.colour) ? hexOf(design.colour) : '';
    const known = colourHex ? EMBED_COLOURS.find(([, , h]) => h.toUpperCase() === colourHex) : EMBED_COLOURS[0];
    const form = postForm(ctx, 'rules', 'post-design', html`<div class="grid">
${channelPicker(g, 'channelId', design.channelId, { label: 'Channel', perms: PERMS.post, help: 'Where the rules are posted, usually a channel like #rules that only staff can write in.' })}
${textInput('title', design.title, { label: 'Title', max: RULES_POST_LIMITS.titleMax, help: 'The bold line at the top of the post. Leave empty for no title.' })}
${selectInput('colour', known ? known[0] : 'primary', EMBED_COLOURS.map(([key, label, h]) => [key, `${label} (${h})`]), { label: 'Colour', help: 'The coloured edge on the left of the post.' })}
${textInput('hex', known ? '' : colourHex, { label: 'Or a colour code', max: 7, placeholder: '#9B59B6', help: 'A # and six letters or numbers. When filled in, it is used instead of the colour above.' })}
${textArea('intro', design.intro, { label: 'Intro', max: RULES_POST_LIMITS.introMax, rows: 3, help: 'Optional text above the rules, for example a short welcome.' })}
${textInput('footer', design.footer, { label: 'Footer', max: RULES_POST_LIMITS.footerMax, help: 'Optional small text at the bottom, for example "Breaking a rule can lead to a warning, mute or ban."' })}
${selectInput('layout', design.layout, [['list', 'One numbered list'], ['fields', 'One box per rule']], { label: 'Layout', help: 'A numbered list reads like a document. One box per rule puts each rule in its own block with its title in bold.' })}
${textInput('bannerUrl', design.banner?.url || '', { label: 'Banner link', max: 2048, type: 'url', placeholder: 'https://example.com/banner.png', help: 'Optional. A wide picture shown above the rules. A link that starts with https://, or upload a file below.' })}
${textInput('thumbnailUrl', design.thumbnail?.url || '', { label: 'Thumbnail link', max: 2048, type: 'url', placeholder: 'https://example.com/logo.png', help: 'Optional. A small picture in the top right corner of the post. A link that starts with https://, or upload a file below.' })}</div>`,
    { submit: 'Save design' });

    const channel = design.channelId ? g?.channels?.cache?.get(design.channelId) : null;
    const canAdmin = ctx.canEdit && ctx.canAct;
    let post;
    if (!design.channelId) post = html`<p class="muted">Pick a channel in the design above and save it. Then you can post the rules.</p>`;
    else if (!channel) post = html`<p class="warn">The saved channel no longer exists. Pick another one and save the design.</p>`;
    else {
        const confirm = design.posted
            ? `Post the rules in #${channel.name} as a new copy? The earlier post stays where it is. To change it instead, use Update posted message.`
            : `Post the rules in #${channel.name}?`;
        post = buttonForm(ctx, 'rules', 'post', `Post to #${channel.name}`, {}, { confirm, danger: false, canEdit: canAdmin });
    }
    let posted = html`<p class="muted">The rules have not been posted from here yet.</p>`;
    if (design.posted) {
        const where = g?.channels?.cache?.get(design.posted.channelId);
        const count = design.posted.messageIds.length;
        posted = html`<p>Posted in ${channelName(g, design.posted.channelId)} on ${formatDate(design.posted.at)} (${count} ${count === 1 ? 'message' : 'messages'}).${where && design.channelId && design.channelId !== design.posted.channelId ? html` <span class="muted">Update changes that post. To move the rules to the new channel, post them there.</span>` : ''}</p>
${buttonForm(ctx, 'rules', 'post-update', 'Update posted message', {}, { confirm: 'Change the posted rules to the current rules and design?', danger: false, canEdit: canAdmin })}`;
    }
    return html`${form}
${imageBlock(ctx, 'banner', design.banner, d.images.banner.fresh)}
${imageBlock(ctx, 'thumbnail', design.thumbnail, d.images.thumbnail.fresh)}
<h3>Preview</h3>${postPreview(d)}
<h3>Post</h3>${posted}${post}`;
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
    const label = IMAGES[name];
    const ref = await storeUpload(ctx, `rules-${name}`, label, {
        content: `Stored ${label.toLowerCase()} for the server rules post (dashboard Rules page). Please keep this message: Mewvo loads the picture from here when it posts or updates the rules.`,
    });
    try {
        return await serialized(async () => {
            const design = currentPost(ctx);
            const next = { ...design, [name]: { url: ref.url, ref } };
            const storedIn = ctx.guild?.channels?.cache?.get(ref.channelId);
            const result = await savePost(ctx, next, [{ key: `rules post ${name}`, old: describeImage(design[name]), new: 'uploaded picture' }], '');
            return { ...result, message: `${label} uploaded. A copy is kept in ${storedIn ? `#${storedIn.name}` : 'the main log channel'}. Do not delete that message.` };
        });
    } catch (error) {
        const channel = ctx.guild?.channels?.cache?.get(ref.channelId);
        await Promise.resolve(channel?.messages?.delete?.(ref.messageId)).catch(() => {});
        throw error;
    }
}

function removeImage(ctx, name) {
    return serialized(async () => {
        const design = currentPost(ctx);
        if (!design[name]) return NOTHING;
        return savePost(ctx, { ...design, [name]: null }, [{ key: `rules post ${name}`, old: describeImage(design[name]), new: null }], `${IMAGES[name]} removed.`);
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
        const last = d.rules.length - 1;
        const rows = d.rules.map((rule, i) => [
            html`<span class="num">${rule.number}</span>`,
            html`<strong>${rule.title}</strong>${rule.text ? html`<br><span class="muted">${clip(rule.text)}</span>` : ''}`,
            rule.consequence ? rule.consequence : html`<span class="muted">None</span>`,
            html`<div class="row-actions">${i > 0 ? buttonForm(ctx, 'rules', 'rule-move', 'Move up', { id: rule.id, direction: 'up' }) : ''}${i < last ? buttonForm(ctx, 'rules', 'rule-move', 'Move down', { id: rule.id, direction: 'down' }) : ''}${buttonForm(ctx, 'rules', 'rule-delete', 'Delete', { id: rule.id }, { confirm: `Delete rule ${rule.number} ("${clip(rule.title, 60)}")? Rules after it move up one number, and reasons linked to it are unlinked.` })}</div>`,
        ]);
        const consequenceHelp = 'Optional. What happens when someone breaks the rule, like "Warning" or "1-hour mute". It is only shown to members and to moderators as a reminder. It never punishes anyone by itself.';
        const edits = d.rules.map((rule) => html`<details class="sub" data-key="rule-${rule.id}"><summary>Edit rule ${rule.number}: ${clip(rule.title, 60)}</summary>
${postForm(ctx, 'rules', 'rule-edit', html`<div class="grid">
${textInput('title', rule.title, { label: 'Title', max: titleMax, help: 'A short name for the rule, on one line.' })}
${textArea('text', rule.text, { label: 'Text', max: textMax, rows: 4, help: 'Optional. Explain the rule in more detail. Line breaks are kept on the web page.' })}
${textInput('consequence', rule.consequence, { label: 'Consequence', max: consequenceMax, help: consequenceHelp })}</div>`, { submit: 'Save rule', hidden: { id: rule.id } })}</details>`);
        const full = d.rules.length >= maxRules;
        const add = full
            ? html`<p class="muted">The server has ${maxRules} rules, the most there can be. Delete one to add another.</p>`
            : postForm(ctx, 'rules', 'rule-add', html`<div class="grid">
${textInput('title', '', { label: 'Title', max: titleMax, placeholder: 'No spam', help: 'A short name for the rule, on one line.' })}
${textArea('text', '', { label: 'Text', max: textMax, rows: 4, help: 'Optional. Explain the rule in more detail. Line breaks are kept on the web page.' })}
${textInput('consequence', '', { label: 'Consequence', max: consequenceMax, placeholder: 'Warning', help: consequenceHelp })}</div>`, { submit: 'Add rule', inline: false });

        const added = new Set(d.rules.map((r) => r.preset).filter(Boolean));
        const libraryRows = RULES_LIBRARY.map((entry) => [
            html`<strong>${entry.title}</strong><br><span class="muted">${entry.text}</span>`,
            entry.consequence,
            entry.reason ? reasonLabel(entry.reason) : html`<span class="muted">None</span>`,
            added.has(entry.key)
                ? pill(false, 'Added')
                : full ? html`<span class="muted">List is full</span>` : buttonForm(ctx, 'rules', 'library-add', 'Add', { key: entry.key }),
        ]);
        const library = html`${table(['Rule', 'Consequence', 'Linked reason', ''], libraryRows)}`;

        const choices = [['', 'No rule'], ...d.rules.map((r) => [r.id, `Rule ${r.number}: ${clip(r.title, 60)}`])];
        const links = d.rules.length
            ? postForm(ctx, 'rules', 'links', html`<div class="grid">${ENFORCEMENT_REASONS.map((reason) => selectInput(`link_${reason.key}`, d.links[reason.key] || '', choices, { label: reason.label }))}</div>`)
            : html`<p class="muted">Add a rule first. Then each reason can point to one.</p>`;
        const updated = d.updatedAt ? html` Last changed ${formatDate(d.updatedAt)}.` : '';
        const page = d.origin
            ? html` Members see them at <a href="${`${d.origin}/rules`}" rel="noopener">${d.origin}/rules</a>.`
            : ' Members see them at /rules on the website. The website address is not set up yet, so punishment messages name the rule without a link.';
        return html`${section('Rules', html`${table(['No.', 'Rule', 'Consequence', ''], rows, 'No rules yet. Until you add some, the web page says the server has not published its rules.')}${edits}`,
            html`${d.rules.length} of ${maxRules} rules. The numbers follow the order in this list.${updated}${page}`)}
${section('Add a rule', add)}
${section('Add from the library', library, ['Ready-made rules you can add with one click. You can edit or delete them afterwards like any other rule.', 'Adding a rule also links its reason (used by /enforcements) to it, unless that reason already points to another rule. Rules you already added show as Added.'], { key: 'library' })}
${section('Reasons linked to rules', links, 'Moderators pick a reason when they punish someone with /enforcements. Link a reason to a rule here, and the member\'s private message names that rule, like "Rule 3: No spam", with a link to it. The moderator also sees the rule and its consequence before confirming. Reasons a moderator types in by hand never name a rule.')}
${section('Post to Discord', postSection(ctx, d), ['Post your rules in a Discord channel as a styled message, and update that message when the rules change.', 'Save the design first, check the preview, then post. Posting and updating need Administrator. Mentions in the rules never ping anyone.'], { key: 'post', size: 'full' })}`;
    },

    actions: {
        'rule-add'(ctx, form) {
            const fields = ruleFields(form);
            return serialized(async () => {
                const { value } = current(ctx);
                const next = addRule(value, fields);
                if (!next) throw new InputError(`The server already has ${maxRules} rules. Delete one first.`);
                await saveRegistry(ctx, { serverRules: next }, 'rules');
                const number = next.rules.length;
                return { changes: [{ key: `rule ${number}`, old: null, new: ruleText(fields) }], audited: true, message: `Rule ${number} added.` };
            });
        },
        'rule-edit'(ctx, form) {
            const fields = ruleFields(form);
            return serialized(async () => {
                const rule = existingRule(ctx, form);
                if (rule.title === fields.title && rule.text === fields.text && rule.consequence === fields.consequence) return NOTHING;
                await saveRegistry(ctx, { serverRules: editRule(current(ctx).value, rule.id, fields) }, 'rules');
                return { changes: [{ key: `rule ${rule.number}`, old: ruleText(rule), new: ruleText(fields) }], audited: true, message: `Rule ${rule.number} saved.` };
            });
        },
        'library-add'(ctx, form) {
            const key = text(form, 'key', 40);
            const entry = libraryRule(key);
            if (!entry) throw new InputError('That library rule does not exist. Reload the page.', 400, 'key');
            return serialized(async () => {
                const { value, links } = current(ctx);
                const { rules } = numberedRules(value);
                if (rules.some((r) => r.preset === entry.key)) throw new InputError(`"${entry.title}" is already in your rules.`);
                const fields = { title: entry.title, text: entry.text, consequence: entry.consequence, preset: entry.key };
                const next = addRule(value, fields);
                if (!next) throw new InputError(`The server already has ${maxRules} rules. Delete one first.`);
                const number = next.rules.length;
                const patch = { serverRules: next };
                const changes = [{ key: `rule ${number}`, old: null, new: ruleText(fields) }];
                let linked = '';
                if (entry.reason && !links[entry.reason]) {
                    patch.reasonRuleLinks = { ...links, [entry.reason]: next.rules[number - 1].id };
                    changes.push({ key: `reason ${entry.reason}`, old: null, new: `rule ${number}: ${entry.title}` });
                    linked = ` The reason "${reasonLabel(entry.reason)}" now points to it.`;
                }
                await saveRegistry(ctx, patch, 'rules');
                return { changes, audited: true, message: `Rule ${number} "${entry.title}" added.${linked}` };
            });
        },
        'rule-delete'(ctx, form) {
            return serialized(async () => {
                const rule = existingRule(ctx, form);
                const { value, links } = current(ctx);
                const next = deleteRule(value, rule.id);
                const pruned = pruneLinks(links, next);
                const patch = { serverRules: next };
                if (Object.keys(pruned).length !== Object.keys(links).length) patch.reasonRuleLinks = pruned;
                await saveRegistry(ctx, patch, 'rules');
                return { changes: [{ key: `rule ${rule.number}`, old: ruleText(rule), new: null }], audited: true, message: `Rule ${rule.number} deleted.` };
            });
        },
        'rule-move'(ctx, form) {
            const direction = choiceField(form, 'direction', ['up', 'down'], 'Direction');
            return serialized(async () => {
                const rule = existingRule(ctx, form);
                const next = moveRule(current(ctx).value, rule.id, direction === 'up' ? -1 : 1);
                if (!next) throw new InputError(`Rule ${rule.number} is already the ${direction === 'up' ? 'first' : 'last'} one.`);
                await saveRegistry(ctx, { serverRules: next }, 'rules');
                const to = rule.number + (direction === 'up' ? -1 : 1);
                return { changes: [{ key: `rule ${rule.number}`, old: `rule ${rule.number}: ${rule.title}`, new: `rule ${to}: ${rule.title}` }], audited: true, message: `"${clip(rule.title, 60)}" is now rule ${to}.` };
            });
        },
        links(ctx, form) {
            return serialized(async () => {
                const { value, links } = current(ctx);
                const { rules } = numberedRules(value);
                const byId = new Map(rules.map((r) => [r.id, r]));
                const next = {};
                for (const reason of ENFORCEMENT_REASONS) {
                    const id = text(form, `link_${reason.key}`, 16);
                    if (!id) continue;
                    if (!byId.has(id)) throw new InputError(`${reason.label}: that rule no longer exists. Reload the page.`, 400, `link_${reason.key}`);
                    next[reason.key] = id;
                }
                const label = (id) => (id && byId.get(id) ? `rule ${byId.get(id).number}: ${byId.get(id).title}` : null);
                const changes = ENFORCEMENT_REASONS
                    .filter((reason) => (links[reason.key] || null) !== (next[reason.key] || null))
                    .map((reason) => ({ key: `reason ${reason.key}`, old: label(links[reason.key]), new: label(next[reason.key]) }));
                if (!changes.length) return NOTHING;
                await saveRegistry(ctx, { reasonRuleLinks: next }, 'rules');
                return { changes, audited: true, message: 'Reason links saved.' };
            });
        },

        // ── Post to Discord ──
        'post-design'(ctx, form) {
            const channelId = channelField(ctx.guild, form, 'channelId', { label: 'Channel' });
            const title = lineText(form, 'title', RULES_POST_LIMITS.titleMax, 'Title');
            const colour = colourFromForm(form);
            const intro = longText(form, 'intro', RULES_POST_LIMITS.introMax, 'Intro');
            const footer = lineText(form, 'footer', RULES_POST_LIMITS.footerMax, 'Footer');
            const layout = choiceField(form, 'layout', ['list', 'fields'], 'Layout');
            return serialized(async () => {
                const design = currentPost(ctx);
                const banner = imageFromForm(form, 'banner', design.banner, 'Banner');
                const thumbnail = imageFromForm(form, 'thumbnail', design.thumbnail, 'Thumbnail');
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
                const result = await savePost(ctx, next, changes, 'Design saved. Check the preview, then post or update.');
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
                return serialized(async () => {
                    const design = currentPost(ctx);
                    if (!design.channelId) throw new InputError('Pick a channel in the design and save it first. Nothing was posted.', 400, 'channelId');
                    const channel = ctx.guild.channels.cache.get(design.channelId);
                    if (!channel) throw new InputError('The saved channel no longer exists. Pick another one and save the design. Nothing was posted.', 400, 'channelId');
                    const messages = await messagesFor(ctx, design);
                    const ids = await discordCall(() => ctx.services.postRulesMessages(ctx.guild, channel, messages), 'Discord refused the post. Nothing was posted.');
                    const posted = { channelId: channel.id, messageIds: ids, at: new Date().toISOString() };
                    try {
                        await saveRegistry(ctx, { rulesPost: { ...design, posted } }, 'rules');
                    } catch (error) {
                        // Not saved: remove the post again, so the page never loses track of a post.
                        await Promise.all(ids.map((id) => Promise.resolve(channel.messages?.delete?.(id)).catch(() => {})));
                        throw error;
                    }
                    const count = ids.length;
                    return {
                        changes: [{ key: 'rules post', old: null, new: `posted in #${channel.name} (${count} ${count === 1 ? 'message' : 'messages'})` }],
                        audited: true, message: `The rules were posted in #${channel.name}.`,
                    };
                });
            },
        },
        'post-update': {
            admin: true,
            run(ctx) {
                return serialized(async () => {
                    const design = currentPost(ctx);
                    if (!design.posted) throw new InputError('The rules have not been posted yet. Use Post first.');
                    const messages = await messagesFor(ctx, design);
                    const { channel, ids, added = [], leftovers = [] } = await discordCall(() => ctx.services.updateRulesMessages(ctx.guild, design.posted, messages),
                        'Discord refused the update. Some messages may already show the new rules. Try Update posted message again.');
                    const posted = { channelId: design.posted.channelId, messageIds: ids, at: new Date().toISOString() };
                    try {
                        await saveRegistry(ctx, { rulesPost: { ...design, posted } }, 'rules');
                    } catch (error) {
                        // Not saved: the new extra messages go again, the old ones stay, so the stored ids still match Discord.
                        await Promise.all(added.map((m) => Promise.resolve(m.delete?.()).catch(() => {})));
                        throw error;
                    }
                    // Saved: only now remove the old messages the shorter post no longer needs.
                    await Promise.all(leftovers.map((m) => Promise.resolve(m.delete?.()).catch(() => {})));
                    const name = channel?.name ? `#${channel.name}` : 'the channel';
                    return {
                        changes: [{ key: 'rules post', old: `${design.posted.messageIds.length} messages`, new: `updated in ${name} (${ids.length} ${ids.length === 1 ? 'message' : 'messages'})` }],
                        audited: true, message: `The posted rules in ${name} were updated.`,
                    };
                });
            },
        },
    },
};
