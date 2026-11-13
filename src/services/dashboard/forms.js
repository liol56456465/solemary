// forms.js — the dashboard's form framework: rendering (forms, inputs, live channel and
// role pickers from the guild cache, warnings) and parsing posted values.
//
// Pure apart from reading the discord.js guild cache. Every value goes through the
// escaping `html` template. No inline styles or scripts (CSP).
//
// Posted values: express.urlencoded({ extended: false }) gives strings, or arrays for
// repeated keys. `text()` keeps strings only, so an array never reaches a service.
// Invalid input throws an InputError (status 400, `userMessage` shown on the page).

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getDangerousPermissions, getRoleAssignmentProblem } from '../../utils/roleSafety.js';
import { html, path, raw, unsavedAttr } from './html.js';
import { currentText, textFor } from './language.js';

// Words: src/content/dashboard/<lang>/forms.json. Helpers with a ctx use its language (textFor);
// the parsing helpers and pickers have none and use the request's (currentText; English outside one).
const ft = () => currentText();

const SNOWFLAKE = /^\d{17,20}$/;

export class InputError extends Error {
    /** `field`: the form field it is about (its name), so the page can mark that field. */
    constructor(message, status = 400, field = null) {
        super(message);
        this.name = 'InputError';
        this.userMessage = message;
        this.status = status;
        this.field = field;
    }
}

/** Discord markdown in service messages (**bold**, `code`) → plain text for the page. */
export function plainText(message) {
    return String(message ?? '').replace(/\*\*|__|`/g, '').replace(/<#(\d+)>/g, '#$1').replace(/<@&(\d+)>/g, '@$1')
        .replace(/<@!?(\d+)>/g, '@$1')
        // Discord timestamps (<t:1700000000:R>) → "2023-11-14 22:13 UTC".
        .replace(/<t:(\d{1,12})(?::[a-zA-Z])?>/g, (match, seconds) => ft().fmtDateTime(new Date(Number(seconds) * 1000)));
}

// ── Parsing ───────────────────────────────────────────────────────────────

/** A posted string (trimmed, capped), '' when missing or not a string. */
/** A value from the address bar (search, filter): trimmed and cut to `max`; never refused. */
export function queryText(query, name, max) {
    const value = query?.[name];
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** \r\n and lone \r → \n: a browser sends textarea line breaks as \r\n, which must not count twice. */
const normalizeBreaks = (value) => value.replace(/\r\n?/g, '\n');

/** Refuses a value over `max` characters (the field is marked on the page); never cuts silently. */
function refuseTooLong(value, max, name) {
    if (value.length > max) throw new InputError(ft().t('forms.error.tooLong', { max: ft().fmtNumber(max), length: ft().fmtNumber(value.length) }), 400, name);
    return value;
}

export function text(form, name, max = 2000) {
    const value = form?.[name];
    if (typeof value !== 'string') return '';
    const trimmed = normalizeBreaks(value).trim();
    return refuseTooLong(trimmed, max, name);
}

/**
 * A repeated field (multi-select, several checkboxes): its string values, trimmed,
 * de-duplicated, at most `max` of them. A single value is a one-item list. A value longer than
 * `maxLength` or more than `max` values is refused with a clear message (never cut silently).
 */
export function list(form, name, { max = 25, maxLength = 25 } = {}) {
    const value = form?.[name];
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const out = [...new Set(values.filter((v) => typeof v === 'string').map((v) => refuseTooLong(v.trim(), maxLength, name)).filter(Boolean))];
    if (out.length > max) throw new InputError(ft().t('forms.error.tooMany', { max: ft().fmtNumber(max), count: ft().fmtNumber(out.length) }), 400, name);
    return out;
}

/** Several channel ids (multi-select), each checked like channelField. */
export function channelListField(guild, form, name, { kinds = ['text', 'category'], label = name, max = 25 } = {}) {
    return list(form, name, { max }).map((id, i) => channelField(guild, { [name]: id }, name, { kinds, optional: false, label: ft().t('forms.error.listItem', { label, number: i + 1 }) }));
}

/** A posted textarea, keeping inner line breaks (\r\n → \n). Over `max` characters is refused, never cut. */
export function multiline(form, name, max = 4000) {
    const value = form?.[name];
    return typeof value === 'string' ? refuseTooLong(normalizeBreaks(value).trim(), max, name) : '';
}

/** A checkbox: present with a value → true. */
export function checkbox(form, name) {
    const value = form?.[name];
    return typeof value === 'string' && value !== '' && value !== '0' && value !== 'false';
}

/** 'true' / 'false' (toggle buttons); anything else is an InputError. */
export function boolField(form, name, label = name) {
    const value = text(form, name, 10);
    if (value === 'true' || value === 'on') return true;
    if (value === 'false' || value === 'off') return false;
    throw new InputError(ft().t('forms.error.onOff', { label }), 400, name);
}

/** A whole number in [min, max]; '' → fallback (or an error when no fallback). */
export function intField(form, name, { min, max, label = name, fallback = undefined } = {}) {
    const raw = text(form, name, 20);
    if (raw === '' && fallback !== undefined) return fallback;
    if (!/^-?\d+$/.test(raw)) throw new InputError(ft().t('forms.error.wholeNumber', { label }), 400, name);
    const value = Number(raw);
    if (value < min || value > max) throw new InputError(ft().t('forms.error.between', { label, min: ft().fmtNumber(min), max: ft().fmtNumber(max) }), 400, name);
    return value;
}

/** A number in [min, max] with at most `decimals` decimals (a comma counts as the point). */
export function decimalField(form, name, { min, max, decimals = 1, label = name } = {}) {
    const raw = text(form, name, 20).replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(raw)) throw new InputError(ft().t('forms.error.number', { label }), 400, name);
    if ((raw.split('.')[1] || '').length > decimals) throw new InputError(ft().tp('forms.error.decimals', decimals, { label }), 400, name);
    const value = Number(raw);
    if (value < min || value > max) throw new InputError(ft().t('forms.error.between', { label, min: ft().fmtNumber(min), max: ft().fmtNumber(max) }), 400, name);
    return value;
}

/** One of `choices`; else an InputError. */
export function choiceField(form, name, choices, label = name) {
    const value = text(form, name, 100);
    if (!choices.includes(value)) throw new InputError(ft().t('forms.error.unknownChoice', { label }), 400, name);
    return value;
}

export function isSnowflake(value) {
    return typeof value === 'string' && SNOWFLAKE.test(value);
}

const CHANNEL_KIND_TYPES = {
    text: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    voice: [ChannelType.GuildVoice, ChannelType.GuildStageVoice],
    category: [ChannelType.GuildCategory],
    forum: [ChannelType.GuildForum],
};

function typesFor(kinds) {
    return kinds.flatMap((kind) => CHANNEL_KIND_TYPES[kind] || []);
}

const KINDS = new Set(['text', 'voice', 'category', 'forum']);
const kindLabel = (kind) => (KINDS.has(kind) ? ft().t(`forms.kind.${kind}`) : kind);

/**
 * A channel id from the form that exists in the guild and has one of `kinds`.
 * '' (or "none") → null when `optional`, else an InputError.
 */
// `current`: the stored value. Sent back unchanged while that channel no longer exists, it is kept
// (the picker shows it as missing), so a deleted channel never blocks saving the form's other fields.
export function channelField(guild, form, name, { kinds = ['text'], optional = true, label = name, current = null } = {}) {
    const raw = text(form, name, 25);
    if (raw === '' || raw === 'none') {
        if (optional) return null;
        throw new InputError(ft().t('forms.error.pickChannel', { label }), 400, name);
    }
    if (!isSnowflake(raw)) throw new InputError(ft().t('forms.error.notChannelId', { label }), 400, name);
    const channel = guild?.channels?.cache?.get(raw);
    if (!channel && current && raw === String(current)) return raw;
    if (!channel) throw new InputError(ft().t('forms.error.channelMissing', { label }), 400, name);
    if (!typesFor(kinds).includes(channel.type)) {
        throw new InputError(ft().t('forms.error.channelKind', { label, kinds: kinds.map(kindLabel).join(ft().t('forms.or')) }), 400, name);
    }
    return raw;
}

/** A role id from the form that exists in the guild (not @everyone). '' → null when optional. */
export function roleField(guild, form, name, { optional = true, label = name, allowManaged = false } = {}) {
    const raw = text(form, name, 25);
    if (raw === '' || raw === 'none') {
        if (optional) return null;
        throw new InputError(ft().t('forms.error.pickRole', { label }), 400, name);
    }
    if (!isSnowflake(raw)) throw new InputError(ft().t('forms.error.notRoleId', { label }), 400, name);
    const role = guild?.roles?.cache?.get(raw);
    if (!role) throw new InputError(ft().t('forms.error.roleMissing', { label }), 400, name);
    if (role.id === guild.id) throw new InputError(ft().t('forms.error.everyone', { label }), 400, name);
    if (role.managed && !allowManaged) throw new InputError(ft().t('forms.error.managed', { label, role: role.name }), 400, name);
    return raw;
}

/** A role the bot hands out automatically: the commands' roleSafety rule blocks unsafe roles. */
export function autoRoleField(guild, form, name, { optional = true, label = name } = {}) {
    const id = roleField(guild, form, name, { optional, label, allowManaged: true });
    if (!id) return null;
    const problem = getRoleAssignmentProblem(guild.roles.cache.get(id), guild.members?.me);
    if (problem) throw new InputError(ft().t('forms.error.problem', { label, problem: plainText(problem) }), 400, name);
    return id;
}

/** A Discord user id from a form: picked with "Find a member", pasted, or an @mention (<@id> / <@!id>). */
export function userIdField(form, name, label = name) {
    const raw = text(form, name, 40).replace(/^<@!?(\d{17,20})>$/, '$1');
    if (!isSnowflake(raw)) throw new InputError(ft().t('forms.error.userId', { label }), 400, name);
    return raw;
}

// ── Warnings (shown next to a field; they never block) ────────────────────

export const PERMS = {
    /** A plain-text post (no embed, no file). */
    text: ['ViewChannel', 'SendMessages'],
    post: ['ViewChannel', 'SendMessages', 'EmbedLinks'],
    postFiles: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles'],
    poll: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AddReactions', 'ReadMessageHistory'],
    nativePoll: ['ViewChannel', 'SendMessages', 'SendPolls'],
    read: ['ViewChannel', 'ReadMessageHistory'],
    manage: ['ViewChannel', 'ManageChannels'],
    category: ['ViewChannel', 'ManageChannels'],
    voice: ['ViewChannel', 'Connect', 'ManageChannels', 'MoveMembers'],
};

const PERM_NAMES = new Set(['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'ManageChannels', 'Connect',
    'MoveMembers', 'ManageMessages', 'ManageRoles', 'AddReactions', 'SendPolls', 'SendMessagesInThreads']);
const permLabel = (perm) => (PERM_NAMES.has(perm) ? ft().t(`forms.perm.${perm}`) : perm);

/**
 * The permissions of `perms` (names like 'SendMessages') the bot lacks in `channel`, or null
 * when they cannot be checked (no bot member in the cache). Pure apart from the cache.
 */
export function missingChannelPerms(guild, channel, perms = PERMS.post) {
    const me = guild?.members?.me;
    if (!channel || !me?.permissionsIn) return null;
    const granted = me.permissionsIn(channel);
    if (!granted?.has) return null;
    return perms.filter((perm) => PermissionFlagsBits[perm] !== undefined && !granted.has(PermissionFlagsBits[perm]));
}

/** Problems the bot has with a channel: missing, or permissions it lacks there. */
export function channelWarnings(guild, channelId, perms = PERMS.post) {
    if (!channelId) return [];
    const channel = guild?.channels?.cache?.get(channelId);
    if (!channel) return [ft().t('forms.warn.channelGone', { id: channelId })];
    const missing = missingChannelPerms(guild, channel, perms);
    if (missing === null) return [ft().t('forms.warn.cannotCheck')];
    return missing.length ? [ft().t('forms.warn.missingPerms', { perms: missing.map(permLabel).join(', '), channel: channel.name })] : [];
}

/** The page that lets Mewvo give itself missing permissions in one channel (permissionFixRoutes.js). */
export const FIX_PERMISSIONS_PATH = '/fix-permissions';

/**
 * A "Fix permissions" link for `channelId` and the permissions a feature needs there. The
 * page it opens shows what will change and asks to confirm; nothing changes on a GET.
 */
export function fixPermissionsLink(channelId, perms) {
    const need = (Array.isArray(perms) ? perms : []).filter((p) => PERM_NAMES.has(p)).join(',');
    if (!isSnowflake(String(channelId || '')) || !need) return '';
    const href = `${path(FIX_PERMISSIONS_PATH)}?channel=${encodeURIComponent(channelId)}&need=${encodeURIComponent(need)}`;
    return html`<a class="fix-link" href="${href}">${ft().t('forms.fixPerms')}</a>`;
}

/** Problems with a role: missing, @everyone, managed, not below my top role; staff permissions when auto-assigned. */
export function roleWarnings(guild, roleId, { autoAssign = false, assign = true } = {}) {
    if (!roleId) return [];
    const role = guild?.roles?.cache?.get(roleId);
    if (!role) return [ft().t('forms.warn.roleGone', { id: roleId })];
    const warnings = [];
    if (role.id === guild.id) warnings.push(ft().t('forms.warn.everyone'));
    if (role.managed) warnings.push(ft().t('forms.warn.managed', { role: role.name }));
    const top = guild.members?.me?.roles?.highest;
    if (assign && (!top || role.position >= top.position)) warnings.push(ft().t('forms.warn.notBelow', { role: role.name }));
    if (autoAssign) {
        const dangerous = getDangerousPermissions(role);
        if (dangerous.length) warnings.push(ft().t('forms.warn.staffPerms', { role: role.name, perms: dangerous.join(', ') }));
    }
    return warnings;
}

// ── Pickers ───────────────────────────────────────────────────────────────

const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }) || String(a.id).localeCompare(String(b.id));

/**
 * Channels of the kinds asked, grouped by category and sorted by name:
 * [{ group, channels: [{ id, name }] }]. Categories themselves are one group.
 */
export function channelGroups(guild, kinds = ['text']) {
    const types = typesFor(kinds);
    const all = [...(guild?.channels?.cache?.values?.() || [])];
    if (kinds.length === 1 && kinds[0] === 'category') {
        return [{ group: ft().t('forms.categories'), channels: all.filter((c) => types.includes(c.type)).sort(byName) }];
    }
    const groups = new Map();
    for (const channel of all) {
        if (!types.includes(channel.type)) continue;
        const parent = channel.parentId ? guild.channels.cache.get(channel.parentId) : null;
        const key = parent ? parent.id : '';
        if (!groups.has(key)) groups.set(key, { group: parent ? parent.name : ft().t('forms.noCategory'), position: parent ? parent.rawPosition ?? 0 : -1, channels: [] });
        groups.get(key).channels.push(channel);
    }
    return [...groups.values()]
        .sort((a, b) => (a.position === -1 ? -1 : b.position === -1 ? 1 : String(a.group).localeCompare(String(b.group), 'en', { sensitivity: 'base' })))
        .map((g) => ({ group: g.group, channels: g.channels.sort(byName) }));
}

/** Roles sorted by name, without @everyone (managed roles only when asked). */
export function roleList(guild, { includeManaged = false } = {}) {
    return [...(guild?.roles?.cache?.values?.() || [])]
        .filter((role) => role.id !== guild.id && (includeManaged || !role.managed))
        .sort(byName);
}

function selected(on) {
    return on ? raw(' selected') : '';
}

function warningList(warnings) {
    return warnings.length ? html`<span class="field-warn">${warnings.map((w, i) => html`${i ? '; ' : ''}${w}`)}</span>` : '';
}

/** Long lists get data-search: the static script adds a filter box above them (progressive enhancement). */
function selectAttrs(name, count, multiple) {
    return html`name="${name}"${multiple ? raw(` multiple size="${Math.min(8, Math.max(4, count))}"`) : ''}${count > 12 ? raw(' data-search') : ''}`;
}

/**
 * A labelled channel select. options: { label, kinds, perms, optional, help, noneLabel,
 * multiple, fixLink } — with multiple, `value` is an array and several can be chosen. fixLink false:
 * no Fix permissions link (the fix page only works in the main server).
 */
export function channelPicker(guild, name, value, { label, kinds = ['text'], perms = PERMS.post, optional = true, help = '', noneLabel = ft().t('forms.notSet'), multiple = false, fixLink = true } = {}) {
    const groups = channelGroups(guild, kinds);
    const values = multiple ? (Array.isArray(value) ? value : []) : [value].filter(Boolean);
    const missing = values.filter((id) => !guild?.channels?.cache?.get(id));
    const prefix = kinds.includes('category') && kinds.length === 1 ? '' : kinds.includes('text') ? '#' : '';
    const count = groups.reduce((n, g) => n + g.channels.length, 0);
    // Every channel where Mewvo lacks what this feature needs is marked in the list itself, so
    // the problem shows before saving (the option stays selectable; the services still refuse).
    let marked = 0;
    const optionOf = (c) => {
        const lacks = missingChannelPerms(guild, c, perms) || [];
        if (lacks.length) marked += 1;
        const text = lacks.length ? ft().t('forms.mark.option', { name: `${prefix}${c.name}`, perms: lacks.map(permLabel).join(', ') }) : `${prefix}${c.name}`;
        return html`<option value="${c.id}"${selected(values.includes(c.id))}>${text}</option>`;
    };
    const options = groups.map((g) => html`<optgroup label="${g.group}">${g.channels.map(optionOf)}</optgroup>`);
    // Per chosen channel: its warnings, and a Fix permissions link when only permissions are missing.
    const notes = values.map((id) => {
        const warnings = channelWarnings(guild, id, perms);
        if (!warnings.length) return '';
        const lacks = missingChannelPerms(guild, guild?.channels?.cache?.get(id), perms) || [];
        return html`<span class="field-warn">${warnings.map((w, i) => html`${i ? '; ' : ''}${w}`)}${lacks.length && fixLink ? html` ${fixPermissionsLink(id, lacks)}` : ''}</span>`;
    });
    return html`<label>${label}<select ${selectAttrs(name, count, multiple)}>
${optional && !multiple ? html`<option value=""${selected(!value)}>${noneLabel}</option>` : ''}${missing.map((id) => html`<option value="${id}" selected>${ft().t('forms.missing', { id })}</option>`)}
${options}
</select>${help ? html`<span class="hint">${help}</span>` : ''}${marked ? html`<span class="hint">${ft().t('forms.mark.hint')}</span>` : ''}${notes}</label>`;
}

/** A labelled role select. options: { label, optional, autoAssign, assign, help, multiple }. */
export function rolePicker(guild, name, value, { label, optional = true, autoAssign = false, assign = true, help = '', noneLabel = ft().t('forms.notSet'), includeManaged = false, multiple = false } = {}) {
    const roles = roleList(guild, { includeManaged });
    const values = multiple ? (Array.isArray(value) ? value : []) : [value].filter(Boolean);
    const missing = values.filter((id) => !guild?.roles?.cache?.get(id));
    return html`<label>${label}<select ${selectAttrs(name, roles.length, multiple)}>
${optional && !multiple ? html`<option value=""${selected(!value)}>${noneLabel}</option>` : ''}${missing.map((id) => html`<option value="${id}" selected>${ft().t('forms.missing', { id })}</option>`)}
${roles.map((r) => html`<option value="${r.id}"${selected(values.includes(r.id))}>@${r.name}</option>`)}
</select>${help ? html`<span class="hint">${help}</span>` : ''}${warningList(values.flatMap((id) => roleWarnings(guild, id, { autoAssign, assign })))}</label>`;
}

export function textInput(name, value, { label, max = 200, help = '', placeholder = '', type = 'text' } = {}) {
    return html`<label>${label}<input type="${type}" name="${name}" value="${value ?? ''}" maxlength="${max}"${placeholder ? html` placeholder="${placeholder}"` : ''}>${help ? html`<span class="hint">${help}</span>` : ''}</label>`;
}

export function numberInput(name, value, { label, min, max, help = '', step = 1 } = {}) {
    return html`<label>${label}<input type="number" name="${name}" value="${value ?? ''}" min="${min}" max="${max}" step="${step}">${help ? html`<span class="hint">${help}</span>` : ''}</label>`;
}

export function textArea(name, value, { label, max = 2000, rows = 4, help = '' } = {}) {
    return html`<label class="wide">${label}<textarea name="${name}" maxlength="${max}" rows="${rows}">${value ?? ''}</textarea>${help ? html`<span class="hint">${help}</span>` : ''}</label>`;
}

/**
 * An on/off setting inside a settings form: a real checkbox (posted as name=1 when on, like
 * checkboxInput) drawn as a switch, label left, switch right, full row. Confirm boxes and
 * lists of choices stay checkboxes.
 */
export function switchInput(name, checked, { label, help = '' } = {}) {
    return html`<label class="switch-row"><span class="switch-label">${label}${help ? html`<span class="hint">${help}</span>` : ''}</span><span class="switch-control"><input type="checkbox" class="switch-input" role="switch" name="${name}" value="1"${checked ? raw(' checked') : ''}><span class="switch-track" aria-hidden="true"></span><span class="switch-word" aria-hidden="true"><span class="w-on">${ft().t('forms.on')}</span><span class="w-off">${ft().t('forms.off')}</span></span></span></label>`;
}

export function checkboxInput(name, checked, { label, help = '' } = {}) {
    return html`<label class="check"><input type="checkbox" name="${name}" value="1"${checked ? raw(' checked') : ''}> ${label}${help ? html` <span class="hint">${help}</span>` : ''}</label>`;
}

export function selectInput(name, value, choices, { label, help = '' } = {}) {
    return html`<label>${label}<select name="${name}">${choices.map(([v, l]) => html`<option value="${v}"${selected(String(v) === String(value))}>${l}</option>`)}</select>${help ? html`<span class="hint">${help}</span>` : ''}</label>`;
}

// ── Forms ─────────────────────────────────────────────────────────────────

/**
 * A POST form to /dashboard/<module>/<action> with the session's CSRF token. When the
 * viewer cannot edit (edit switch off, or an Administrator-only action for an owner),
 * the fields are disabled and there is no submit button.
 * options: { submit, hidden: {name: value}, danger, inline, canEdit, className }
 */
export function postForm(ctx, module, action, fields, {
    submit = null, hidden = {}, danger = false, inline = false, canEdit = ctx.canEdit, className = '', confirm = '', secondary = false, multipart = false, reset: withReset = null,
} = {}) {
    const tr = textFor(ctx);
    const label = submit ?? tr.t('forms.save');
    const classes = [inline ? 'inline-form' : 'settings-form', className].filter(Boolean).join(' ');
    // data-confirm: the static script asks before submitting (destructive actions).
    // data-dirty: it warns before leaving the page with unsaved changes.
    // Every form warns before leaving with something typed; inline forms (add-a-row) stay compact (no Reset).
    // multipart: a file upload (only actions marked `upload` accept it, see routes.js moduleUploadBody).
    const attrs = html`${multipart ? raw(' enctype="multipart/form-data"') : ''}${confirm ? html` data-confirm="${confirm}"` : ''}${raw(' data-dirty')}`;
    const buttonClass = danger ? 'danger' : secondary ? 'secondary' : 'primary';
    // Settings forms (a "Save…" button) also get Reset: it puts back what was loaded (no request).
    // A translated button ("Speichern") cannot be recognised by its word: the default button is a
    // save button, and `reset: true` marks others (then the script also shows "Saving…" on it).
    const isSave = submit == null || /^save/i.test(String(submit)) || withReset === true;
    const reset = withReset === false ? false : !inline && !danger && isSave;
    const saveMark = isSave && tr.lang !== 'en' ? raw(' data-save') : '';
    return html`<form method="post" action="${path(`/${module}/${action}`)}" class="${classes}"${attrs}><input type="hidden" name="csrf" value="${ctx.csrf}">
${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
<fieldset${canEdit ? '' : raw(' disabled')}>${fields}${canEdit ? html`<div class="form-actions"${unsavedAttr(tr)}>${reset ? html`<button type="reset" class="secondary">${tr.t('forms.reset')}</button>` : ''}<button type="submit" class="${buttonClass}"${saveMark}>${label}</button></div>` : ''}</fieldset></form>`;
}

/**
 * An on/off switch form (value posted as enabled=true|false). Without JS it is a
 * button ("Turn on" / "Turn off"); the static script turns the row into a switch that
 * submits on click (with a confirm when turning off, if `confirmOff` is set).
 */
export function toggleForm(ctx, module, action, enabled, { label = textFor(ctx).t('forms.moduleLabel'), canEdit = ctx.canEdit, hidden = {}, confirmOff = '' } = {}) {
    const tr = textFor(ctx);
    const confirm = enabled && confirmOff ? html` data-confirm="${confirmOff}"` : '';
    return html`<form method="post" action="${path(`/${module}/${action}`)}" class="toggle-row" data-toggle${confirm}><input type="hidden" name="csrf" value="${ctx.csrf}">
${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<input type="hidden" name="enabled" value="${enabled ? 'false' : 'true'}">
<span class="toggle-label">${label}${canEdit ? html`<span class="hint">${tr.t('forms.savesRightAway')}</span>` : ''}</span>
<fieldset${canEdit ? '' : raw(' disabled')}>${canEdit ? html`<button type="submit" class="switch${enabled ? ' is-on' : ''}" role="switch" aria-checked="${enabled ? 'true' : 'false'}" aria-label="${tr.t(enabled ? 'forms.turnOffLabel' : 'forms.turnOnLabel', { label })}"><span class="switch-text">${tr.t(enabled ? 'forms.turnOff' : 'forms.turnOn')}</span></button>` : ''}</fieldset><span class="switch-word${enabled ? ' is-on' : ''}"${canEdit ? raw(' aria-hidden="true"') : ''}>${tr.t(enabled ? 'forms.on' : 'forms.off')}</span></form>`;
}

/**
 * A module's main switch (Modules page cards, module page header): the same POST as
 * toggleForm (enabled=true|false), compact. `back` ('modules' or a module key) is
 * where the save returns to instead of the form's own module page. Without edit rights it is the on/off pill only.
 */
export function moduleSwitch({ csrf, canEdit, module, action, enabled, label, back = '', hidden = {}, lang = null }) {
    if (!canEdit) return pill(enabled);
    const tr = textFor({ lang });
    return html`<form method="post" action="${path(`/${module}/${action}`)}" class="switch-form"><input type="hidden" name="csrf" value="${csrf}">
${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<input type="hidden" name="enabled" value="${enabled ? 'false' : 'true'}">${back ? html`<input type="hidden" name="back" value="${back}">` : ''}
<button type="submit" class="switch${enabled ? ' is-on' : ''}" role="switch" aria-checked="${enabled ? 'true' : 'false'}" aria-label="${tr.t(enabled ? 'forms.turnOffLabel' : 'forms.turnOnLabel', { label })}"><span class="switch-text">${tr.t(enabled ? 'forms.turnOff' : 'forms.turnOn')}</span></button><span class="switch-word${enabled ? ' is-on' : ''}" aria-hidden="true">${tr.t(enabled ? 'forms.on' : 'forms.off')}</span></form>`;
}

/** A status pill: green "on", grey "off" (or custom text / tone: on, off, warn, bad). */
export function pill(on, text = ft().t(on ? 'forms.pillOn' : 'forms.pillOff'), tone = on ? 'on' : 'off') {
    return html`<span class="state state-${tone}">${text}</span>`;
}

/**
 * A small one-button form (remove, end now, …). `confirm` asks first (with JS). Red (danger)
 * only for destructive actions, which always confirm; reversible ones (remove from a list,
 * turn off) are a neutral outline button and act at once.
 */
export function buttonForm(ctx, module, action, label, hidden = {}, { confirm = '', danger = Boolean(confirm), canEdit = ctx.canEdit } = {}) {
    return postForm(ctx, module, action, '', { submit: label, hidden, inline: true, danger, secondary: !danger, canEdit, confirm });
}

/** Channel name for display: "#name" or the id marked missing. */
export function channelName(guild, id) {
    if (!id) return html`<span class="muted">${ft().t('forms.notSet')}</span>`;
    const channel = guild?.channels?.cache?.get(id);
    return channel ? html`#${channel.name}` : html`<span class="warn">${ft().t('forms.missing', { id })}</span>`;
}

export function roleName(guild, id) {
    if (!id) return html`<span class="muted">${ft().t('forms.notSet')}</span>`;
    const role = guild?.roles?.cache?.get(id);
    return role ? html`@${role.name}` : html`<span class="warn">${ft().t('forms.missing', { id })}</span>`;
}
