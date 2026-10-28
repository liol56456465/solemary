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
import { html, path, raw } from './html.js';

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
        .replace(/<t:(\d{1,12})(?::[a-zA-Z])?>/g, (match, seconds) => `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
}

// ── Parsing ───────────────────────────────────────────────────────────────

/** A posted string (trimmed, capped), '' when missing or not a string. */
export function text(form, name, max = 2000) {
    const value = form?.[name];
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    // Never cut silently: a longer value is refused (the field is marked on the page).
    if (trimmed.length > max) throw new InputError(`Too long: at most ${max} characters (${trimmed.length} entered).`, 400, name);
    return trimmed;
}

/**
 * A repeated field (multi-select, several checkboxes): its string values, trimmed,
 * de-duplicated, at most `max` of them. A single value is a one-item list.
 */
export function list(form, name, { max = 25, maxLength = 25 } = {}) {
    const value = form?.[name];
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return [...new Set(values.filter((v) => typeof v === 'string').map((v) => v.trim().slice(0, maxLength)).filter(Boolean))].slice(0, max);
}

/** Several channel ids (multi-select), each checked like channelField. */
export function channelListField(guild, form, name, { kinds = ['text', 'category'], label = name, max = 25 } = {}) {
    return list(form, name, { max }).map((id, i) => channelField(guild, { [name]: id }, name, { kinds, optional: false, label: `${label} ${i + 1}` }));
}

/** A posted textarea, keeping inner line breaks (\r\n → \n). */
export function multiline(form, name, max = 4000) {
    const value = form?.[name];
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '';
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
    throw new InputError(`${label}: choose on or off.`, 400, name);
}

/** A whole number in [min, max]; '' → fallback (or an error when no fallback). */
export function intField(form, name, { min, max, label = name, fallback = undefined } = {}) {
    const raw = text(form, name, 20);
    if (raw === '' && fallback !== undefined) return fallback;
    if (!/^-?\d+$/.test(raw)) throw new InputError(`${label} must be a whole number.`, 400, name);
    const value = Number(raw);
    if (value < min || value > max) throw new InputError(`${label} must be between ${min} and ${max}.`, 400, name);
    return value;
}

/** One of `choices`; else an InputError. */
export function choiceField(form, name, choices, label = name) {
    const value = text(form, name, 100);
    if (!choices.includes(value)) throw new InputError(`${label}: unknown choice.`, 400, name);
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

const KIND_LABEL = { text: 'text channel', voice: 'voice channel', category: 'category', forum: 'forum' };

/**
 * A channel id from the form that exists in the guild and has one of `kinds`.
 * '' (or "none") → null when `optional`, else an InputError.
 */
export function channelField(guild, form, name, { kinds = ['text'], optional = true, label = name } = {}) {
    const raw = text(form, name, 25);
    if (raw === '' || raw === 'none') {
        if (optional) return null;
        throw new InputError(`${label}: pick a channel.`, 400, name);
    }
    if (!isSnowflake(raw)) throw new InputError(`${label}: not a channel ID.`, 400, name);
    const channel = guild?.channels?.cache?.get(raw);
    if (!channel) throw new InputError(`${label}: that channel is not in the server.`, 400, name);
    if (!typesFor(kinds).includes(channel.type)) {
        throw new InputError(`${label}: must be a ${kinds.map((k) => KIND_LABEL[k] || k).join(' or ')}.`, 400, name);
    }
    return raw;
}

/** A role id from the form that exists in the guild (not @everyone). '' → null when optional. */
export function roleField(guild, form, name, { optional = true, label = name, allowManaged = false } = {}) {
    const raw = text(form, name, 25);
    if (raw === '' || raw === 'none') {
        if (optional) return null;
        throw new InputError(`${label}: pick a role.`, 400, name);
    }
    if (!isSnowflake(raw)) throw new InputError(`${label}: not a role ID.`, 400, name);
    const role = guild?.roles?.cache?.get(raw);
    if (!role) throw new InputError(`${label}: that role is not in the server.`, 400, name);
    if (role.id === guild.id) throw new InputError(`${label}: @everyone cannot be used.`, 400, name);
    if (role.managed && !allowManaged) throw new InputError(`${label}: ${role.name} is managed by an integration or bot.`, 400, name);
    return raw;
}

/** A role the bot hands out automatically: the commands' roleSafety rule blocks unsafe roles. */
export function autoRoleField(guild, form, name, { optional = true, label = name } = {}) {
    const id = roleField(guild, form, name, { optional, label, allowManaged: true });
    if (!id) return null;
    const problem = getRoleAssignmentProblem(guild.roles.cache.get(id), guild.members?.me);
    if (problem) throw new InputError(`${label}: ${plainText(problem)}`, 400, name);
    return id;
}

/** A Discord user id typed in a form. */
export function userIdField(form, name, label = name) {
    const raw = text(form, name, 25);
    if (!isSnowflake(raw)) throw new InputError(`${label} must be a Discord user ID (17–20 digits).`, 400, name);
    return raw;
}

// ── Warnings (shown next to a field; they never block) ────────────────────

export const PERMS = {
    post: ['ViewChannel', 'SendMessages', 'EmbedLinks'],
    postFiles: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles'],
    read: ['ViewChannel', 'ReadMessageHistory'],
    manage: ['ViewChannel', 'ManageChannels'],
    category: ['ViewChannel', 'ManageChannels'],
    voice: ['ViewChannel', 'Connect', 'ManageChannels', 'MoveMembers'],
};

const PERM_LABEL = {
    ViewChannel: 'View Channel', SendMessages: 'Send Messages', EmbedLinks: 'Embed Links', AttachFiles: 'Attach Files',
    ReadMessageHistory: 'Read Message History', ManageChannels: 'Manage Channels', Connect: 'Connect',
    MoveMembers: 'Move Members', ManageMessages: 'Manage Messages', ManageRoles: 'Manage Roles',
};

/** Problems the bot has with a channel: missing, or permissions it lacks there. */
export function channelWarnings(guild, channelId, perms = PERMS.post) {
    if (!channelId) return [];
    const channel = guild?.channels?.cache?.get(channelId);
    if (!channel) return [`channel ${channelId} no longer exists`];
    const me = guild.members?.me;
    if (!me?.permissionsIn) return ['cannot check my permissions here'];
    const granted = me.permissionsIn(channel);
    const missing = perms.filter((perm) => !granted?.has?.(PermissionFlagsBits[perm]));
    return missing.length ? [`I am missing ${missing.map((p) => PERM_LABEL[p] || p).join(', ')} in #${channel.name}`] : [];
}

/** Problems with a role: missing, @everyone, managed, not below my top role; staff permissions when auto-assigned. */
export function roleWarnings(guild, roleId, { autoAssign = false, assign = true } = {}) {
    if (!roleId) return [];
    const role = guild?.roles?.cache?.get(roleId);
    if (!role) return [`role ${roleId} no longer exists`];
    const warnings = [];
    if (role.id === guild.id) warnings.push('@everyone cannot be used');
    if (role.managed) warnings.push(`@${role.name} is managed by an integration or bot`);
    const top = guild.members?.me?.roles?.highest;
    if (assign && (!top || role.position >= top.position)) warnings.push(`@${role.name} is not below my highest role, so I cannot assign it`);
    if (autoAssign) {
        const dangerous = getDangerousPermissions(role);
        if (dangerous.length) warnings.push(`@${role.name} has staff permissions (${dangerous.join(', ')})`);
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
        return [{ group: 'Categories', channels: all.filter((c) => types.includes(c.type)).sort(byName) }];
    }
    const groups = new Map();
    for (const channel of all) {
        if (!types.includes(channel.type)) continue;
        const parent = channel.parentId ? guild.channels.cache.get(channel.parentId) : null;
        const key = parent ? parent.id : '';
        if (!groups.has(key)) groups.set(key, { group: parent ? parent.name : 'No category', position: parent ? parent.rawPosition ?? 0 : -1, channels: [] });
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
 * multiple } — with multiple, `value` is an array and several can be chosen.
 */
export function channelPicker(guild, name, value, { label, kinds = ['text'], perms = PERMS.post, optional = true, help = '', noneLabel = 'not set', multiple = false } = {}) {
    const groups = channelGroups(guild, kinds);
    const values = multiple ? (Array.isArray(value) ? value : []) : [value].filter(Boolean);
    const missing = values.filter((id) => !guild?.channels?.cache?.get(id));
    const prefix = kinds.includes('category') && kinds.length === 1 ? '' : kinds.includes('text') ? '#' : '';
    const count = groups.reduce((n, g) => n + g.channels.length, 0);
    return html`<label>${label}<select ${selectAttrs(name, count, multiple)}>
${optional && !multiple ? html`<option value=""${selected(!value)}>— ${noneLabel} —</option>` : ''}${missing.map((id) => html`<option value="${id}" selected>${id} (missing)</option>`)}
${groups.map((g) => html`<optgroup label="${g.group}">${g.channels.map((c) => html`<option value="${c.id}"${selected(values.includes(c.id))}>${prefix}${c.name}</option>`)}</optgroup>`)}
</select>${help ? html`<span class="hint">${help}</span>` : ''}${warningList(values.flatMap((id) => channelWarnings(guild, id, perms)))}</label>`;
}

/** A labelled role select. options: { label, optional, autoAssign, assign, help, multiple }. */
export function rolePicker(guild, name, value, { label, optional = true, autoAssign = false, assign = true, help = '', noneLabel = 'not set', includeManaged = false, multiple = false } = {}) {
    const roles = roleList(guild, { includeManaged });
    const values = multiple ? (Array.isArray(value) ? value : []) : [value].filter(Boolean);
    const missing = values.filter((id) => !guild?.roles?.cache?.get(id));
    return html`<label>${label}<select ${selectAttrs(name, roles.length, multiple)}>
${optional && !multiple ? html`<option value=""${selected(!value)}>— ${noneLabel} —</option>` : ''}${missing.map((id) => html`<option value="${id}" selected>${id} (missing)</option>`)}
${roles.map((r) => html`<option value="${r.id}"${selected(values.includes(r.id))}>@${r.name}</option>`)}
</select>${help ? html`<span class="hint">${help}</span>` : ''}${warningList(values.flatMap((id) => roleWarnings(guild, id, { autoAssign, assign })))}</label>`;
}

export function textInput(name, value, { label, max = 200, help = '', placeholder = '', type = 'text' } = {}) {
    return html`<label>${label}<input type="${type}" name="${name}" value="${value ?? ''}" maxlength="${max}"${placeholder ? html` placeholder="${placeholder}"` : ''}>${help ? html`<span class="hint">${help}</span>` : ''}</label>`;
}

export function numberInput(name, value, { label, min, max, help = '' } = {}) {
    return html`<label>${label}<input type="number" name="${name}" value="${value ?? ''}" min="${min}" max="${max}" step="1">${help ? html`<span class="hint">${help}</span>` : ''}</label>`;
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
    return html`<label class="switch-row"><span class="switch-label">${label}${help ? html`<span class="hint">${help}</span>` : ''}</span><span class="switch-control"><input type="checkbox" class="switch-input" role="switch" name="${name}" value="1"${checked ? raw(' checked') : ''}><span class="switch-track" aria-hidden="true"></span><span class="switch-word" aria-hidden="true"><span class="w-on">On</span><span class="w-off">Off</span></span></span></label>`;
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
    submit = 'Save changes', hidden = {}, danger = false, inline = false, canEdit = ctx.canEdit, className = '', confirm = '', secondary = false,
} = {}) {
    const classes = [inline ? 'inline-form' : 'settings-form', className].filter(Boolean).join(' ');
    // data-confirm: the static script asks before submitting (destructive actions).
    // data-dirty: it warns before leaving the page with unsaved changes.
    // Every form warns before leaving with something typed; inline forms (add-a-row) stay compact (no Reset).
    const attrs = html`${confirm ? html` data-confirm="${confirm}"` : ''}${raw(' data-dirty')}`;
    const buttonClass = danger ? 'danger' : secondary ? 'secondary' : 'primary';
    // Settings forms (a "Save…" button) also get Reset: it puts back what was loaded (no request).
    const reset = !inline && !danger && /^save/i.test(String(submit));
    return html`<form method="post" action="${path(`/${module}/${action}`)}" class="${classes}"${attrs}><input type="hidden" name="csrf" value="${ctx.csrf}">
${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
<fieldset${canEdit ? '' : raw(' disabled')}>${fields}${canEdit ? html`<div class="form-actions">${reset ? html`<button type="reset" class="secondary">Reset</button>` : ''}<button type="submit" class="${buttonClass}">${submit}</button></div>` : ''}</fieldset></form>`;
}

/**
 * An on/off switch form (value posted as enabled=true|false). Without JS it is a
 * button ("Turn on" / "Turn off"); the static script turns the row into a switch that
 * submits on click (with a confirm when turning off, if `confirmOff` is set).
 */
export function toggleForm(ctx, module, action, enabled, { label = 'Module', canEdit = ctx.canEdit, hidden = {}, confirmOff = '' } = {}) {
    const confirm = enabled && confirmOff ? html` data-confirm="${confirmOff}"` : '';
    return html`<form method="post" action="${path(`/${module}/${action}`)}" class="toggle-row" data-toggle${confirm}><input type="hidden" name="csrf" value="${ctx.csrf}">
${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<input type="hidden" name="enabled" value="${enabled ? 'false' : 'true'}">
<span class="toggle-label">${label}${canEdit ? html`<span class="hint">Saves right away.</span>` : ''}</span>
<fieldset${canEdit ? '' : raw(' disabled')}>${canEdit ? html`<button type="submit" class="switch${enabled ? ' is-on' : ''}" role="switch" aria-checked="${enabled ? 'true' : 'false'}" aria-label="${label}: turn ${enabled ? 'off' : 'on'}"><span class="switch-text">${enabled ? 'Turn off' : 'Turn on'}</span></button>` : ''}</fieldset><span class="switch-word${enabled ? ' is-on' : ''}"${canEdit ? raw(' aria-hidden="true"') : ''}>${enabled ? 'On' : 'Off'}</span></form>`;
}

/**
 * A module's main switch (Modules page cards, module page header): the same POST as
 * toggleForm (enabled=true|false), compact. `back` ('modules' or a module key) is
 * where the save returns to instead of the form's own module page. Without edit rights it is the on/off pill only.
 */
export function moduleSwitch({ csrf, canEdit, module, action, enabled, label, back = '', hidden = {} }) {
    if (!canEdit) return pill(enabled);
    return html`<form method="post" action="${path(`/${module}/${action}`)}" class="switch-form"><input type="hidden" name="csrf" value="${csrf}">
${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<input type="hidden" name="enabled" value="${enabled ? 'false' : 'true'}">${back ? html`<input type="hidden" name="back" value="${back}">` : ''}
<button type="submit" class="switch${enabled ? ' is-on' : ''}" role="switch" aria-checked="${enabled ? 'true' : 'false'}" aria-label="${label}: turn ${enabled ? 'off' : 'on'}"><span class="switch-text">${enabled ? 'Turn off' : 'Turn on'}</span></button><span class="switch-word${enabled ? ' is-on' : ''}" aria-hidden="true">${enabled ? 'On' : 'Off'}</span></form>`;
}

/** A status pill: green "on", grey "off" (or custom text / tone: on, off, warn, bad). */
export function pill(on, text = on ? 'on' : 'off', tone = on ? 'on' : 'off') {
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
    if (!id) return html`<span class="muted">not set</span>`;
    const channel = guild?.channels?.cache?.get(id);
    return channel ? html`#${channel.name}` : html`<span class="warn">${id} (missing)</span>`;
}

export function roleName(guild, id) {
    if (!id) return html`<span class="muted">not set</span>`;
    const role = guild?.roles?.cache?.get(id);
    return role ? html`@${role.name}` : html`<span class="warn">${id} (missing)</span>`;
}
