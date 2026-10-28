// logging.js — Logging: on/off, a channel per log category (audit, applications,
// reports), event toggles and the ignore lists. Writes go through loggingService
// (the functions /logging uses).

import { EVENT_TYPES, LOG_DESTINATIONS } from '../../loggingService.js';
import { html, path } from '../html.js';
import {
    InputError, PERMS, boolField, buttonForm, channelField, channelName, channelPicker, checkbox, checkboxInput,
    choiceField, postForm, roleName, text, toggleForm, userIdField, roleList,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, registryValue, section, table } from './common.js';

const DESTINATION_LABEL = { audit: 'Audit log (everything else)', applications: 'Applications', reports: 'Reports' };
const IGNORE_TYPES = { channel: 'channels', role: 'roles', user: 'users' };

/** Event types (strings) grouped by their category prefix. */
export function eventCategories() {
    const groups = new Map();
    for (const value of Object.values(EVENT_TYPES)) {
        if (typeof value !== 'string' || !value.includes('.')) continue;
        const category = value.split('.')[0];
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(value);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const fieldName = (type) => `ev:${type}`;
const categoryField = (category) => `cat:${category}`;

function failIfFalse(ok) {
    if (ok === false) throw new Error('The logging service could not save the change');
}

export default {
    key: 'logging',
    label: 'Logging',
    state: 'logging',
    help: 'Server event logs (messages, members, roles, moderation, …). Same settings as /logging. The mod log (one line per enforcement action) is set on Enforcement & appeals.',

    async load(ctx) {
        const status = await ctx.services.getLoggingStatus(ctx.client, ctx.guildId);
        return { status, modLogChannelId: registryValue(ctx, 'modLogChannelId') };
    },

    render(ctx, { status, modLogChannelId }) {
        const g = ctx.guild;
        const events = status.enabledEvents || {};
        const channels = postForm(ctx, 'logging', 'channels', html`<div class="grid">
${LOG_DESTINATIONS.map((d) => channelPicker(g, d, status.channels?.[d] || null, { label: DESTINATION_LABEL[d] || d, perms: PERMS.post }))}</div>`,
        { submit: 'Save channels' });
        // One collapsible group per category (closed by default; the browser remembers which were open).
        const toggles = postForm(ctx, 'logging', 'events', html`${eventCategories().map(([category, types]) => {
            const on = types.filter((type) => events[type] !== false).length;
            const whole = events[`${category}.*`] !== false;
            return html`<details class="sub" data-key="log-${category}"><summary>${category} <span class="muted">${whole ? `${on}/${types.length} events on` : 'category off'}</span></summary>
<fieldset class="events">${checkboxInput(categoryField(category), whole, { label: `${category} (whole category)` })}
${types.map((type) => checkboxInput(fieldName(type), events[type] !== false, { label: type.split('.')[1] }))}</fieldset></details>`;
        })}`, { submit: 'Save events' });
        const ignore = status.ignore || { channels: [], roles: [], users: [] };
        const ignoreRows = [
            ...ignore.channels.map((id) => ['channel', channelName(g, id), buttonForm(ctx, 'logging', 'ignore-remove', 'Remove', { type: 'channel', id })]),
            ...ignore.roles.map((id) => ['role', roleName(g, id), buttonForm(ctx, 'logging', 'ignore-remove', 'Remove', { type: 'role', id })]),
            ...ignore.users.map((id) => ['user', html`<code>${id}</code>`, buttonForm(ctx, 'logging', 'ignore-remove', 'Remove', { type: 'user', id })]),
        ];
        const ignoreForms = html`${table(['Type', 'Ignored', ''], ignoreRows, 'Nothing is ignored.')}
<div class="grid">${postForm(ctx, 'logging', 'ignore-add', html`<input type="hidden" name="type" value="channel">${channelPicker(g, 'id', null, { label: 'Ignore channel', kinds: ['text', 'voice', 'category', 'forum'], perms: [], optional: false })}`, { submit: 'Add', inline: true })}
${postForm(ctx, 'logging', 'ignore-add', html`<input type="hidden" name="type" value="role"><label>Ignore role<select name="id">${roleList(g, { includeManaged: true }).map((r) => html`<option value="${r.id}">@${r.name}</option>`)}</select></label>`, { submit: 'Add', inline: true })}
${postForm(ctx, 'logging', 'ignore-add', html`<input type="hidden" name="type" value="user"><label>Ignore user ID<input name="id" inputmode="numeric" maxlength="20"></label>`, { submit: 'Add', inline: true })}</div>`;
        return html`${section('Status', html`${toggleForm(ctx, 'logging', 'enabled', status.enabled, { label: 'Logging' })}
<p class="muted">Mod log channel: ${channelName(g, modLogChannelId)} — <a href="${path('/enforcement')}">change on Enforcement &amp; appeals</a>. Ticket logs are set on <a href="${path('/tickets')}">Tickets</a>.</p>`)}
${section('Channels', channels, 'Setting a channel turns logging on (as /logging does).')}
${section('Events', toggles, 'Unticking a whole category turns every event in it off.')}
${section('Ignore lists', ignoreForms, 'Events from these channels (and their threads), roles or users are not logged.')}`;
    },

    actions: {
        async enabled(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Logging');
            const before = await ctx.services.getLoggingStatus(ctx.client, ctx.guildId);
            failIfFalse(await ctx.services.setLoggingEnabled(ctx.client, ctx.guildId, enabled));
            const changes = diffSnapshots({ enabled: before.enabled }, { enabled }, null, 'logging.');
            return { changes, message: `Logging is now ${enabled ? 'on' : 'off'}.` };
        },
        async channels(ctx, form) {
            const before = await ctx.services.getLoggingStatus(ctx.client, ctx.guildId);
            const changes = [];
            for (const destination of LOG_DESTINATIONS) {
                const value = channelField(ctx.guild, form, destination, { label: DESTINATION_LABEL[destination] });
                const old = before.channels?.[destination] || null;
                if (value === old) continue;
                failIfFalse(await ctx.services.setLogChannel(ctx.client, ctx.guildId, destination, value));
                changes.push({ key: `logging.channels.${destination}`, old, new: value });
            }
            if (!changes.length) return NOTHING;
            return { changes, message: 'Log channels saved.' };
        },
        async events(ctx, form) {
            const before = await ctx.services.getLoggingStatus(ctx.client, ctx.guildId);
            const events = before.enabledEvents || {};
            const changes = [];
            for (const [category, types] of eventCategories()) {
                const wildcard = `${category}.*`;
                const wanted = checkbox(form, categoryField(category));
                if ((events[wildcard] !== false) !== wanted) {
                    failIfFalse(await ctx.services.toggleEventLogging(ctx.client, ctx.guildId, [wildcard], wanted));
                    changes.push({ key: `logging.events.${wildcard}`, old: !wanted, new: wanted });
                    continue; // the category toggle sets every event in it
                }
                const on = [];
                const off = [];
                for (const type of types) {
                    const want = checkbox(form, fieldName(type));
                    if ((events[type] !== false) !== want) (want ? on : off).push(type);
                }
                if (on.length) failIfFalse(await ctx.services.toggleEventLogging(ctx.client, ctx.guildId, on, true));
                if (off.length) failIfFalse(await ctx.services.toggleEventLogging(ctx.client, ctx.guildId, off, false));
                for (const type of on) changes.push({ key: `logging.events.${type}`, old: false, new: true });
                for (const type of off) changes.push({ key: `logging.events.${type}`, old: true, new: false });
            }
            if (!changes.length) return NOTHING;
            return { changes, message: 'Event logging saved.' };
        },
        async 'ignore-add'(ctx, form) {
            const type = choiceField(form, 'type', Object.keys(IGNORE_TYPES), 'Type');
            let id;
            if (type === 'channel') id = channelField(ctx.guild, form, 'id', { kinds: ['text', 'voice', 'category', 'forum'], optional: false, label: 'Channel' });
            else if (type === 'role') {
                id = text(form, 'id', 25);
                if (!ctx.guild?.roles?.cache?.get(id)) throw new InputError('Role: that role is not in the server.');
            } else id = userIdField(form, 'id', 'User ID');
            const before = await ctx.services.getLoggingStatus(ctx.client, ctx.guildId);
            const list = before.ignore?.[IGNORE_TYPES[type]] || [];
            if (list.includes(id)) return { changes: [], message: 'Already ignored.' };
            failIfFalse(await ctx.services.updateIgnoreList(ctx.client, ctx.guildId, { action: 'add', type, id }));
            return { changes: [{ key: `logging.ignore.${IGNORE_TYPES[type]}`, old: list, new: [...list, id] }], message: `Ignoring that ${type} in the logs.` };
        },
        async 'ignore-remove'(ctx, form) {
            const type = choiceField(form, 'type', Object.keys(IGNORE_TYPES), 'Type');
            const id = text(form, 'id', 25);
            if (!/^\d{17,20}$/.test(id)) throw new InputError('Not an ID.');
            const before = await ctx.services.getLoggingStatus(ctx.client, ctx.guildId);
            const list = before.ignore?.[IGNORE_TYPES[type]] || [];
            if (!list.includes(id)) return { changes: [], message: 'It was not on the list.' };
            failIfFalse(await ctx.services.updateIgnoreList(ctx.client, ctx.guildId, { action: 'remove', type, id }));
            return { changes: [{ key: `logging.ignore.${IGNORE_TYPES[type]}`, old: list, new: list.filter((x) => x !== id) }], message: 'Removed from the ignore list.' };
        },
    },
};

