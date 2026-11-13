import { adminOnlyActions } from './serverScope.js';
// logging.js — Logging: on/off, a channel per log category (audit, applications,
// reports), event toggles and the ignore lists. Writes go through loggingService
// (the functions /logging uses).
//
// Advanced logs (owner, 2026-11-13; services/logForum.js): per kind Normal (its text channel) or
// Advanced (a forum: one post per member, "<username> logs <id>"), including the mod log and the
// website/dashboard log. Choosing Advanced shows a short how-to (static script); a user can hide it
// for good ("Don't show again", tips.js) or just close it.
// Words: src/content/dashboard/<lang>/logging.json (event and category names stay as the bot names them).

import { EVENT_TYPES, LOG_DESTINATIONS } from '../../loggingService.js';
import { LOG_FORUM_KINDS } from '../../logForum.js';
import { html, path } from '../html.js';
import {
    InputError, PERMS, boolField, buttonForm, channelField, channelName, channelPicker, checkbox, checkboxInput,
    choiceField, postForm, roleName, selectInput, text, userIdField, roleList,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { memberField, pickedFromQuery } from '../memberSearch.js';
import { textFor } from '../language.js';
import { registryValue, section, table } from './common.js';

const DESTINATION_LABEL = Object.fromEntries(LOG_DESTINATIONS.map((d) => [d, `logging.channels.${d}`]));
const IGNORE_TYPES = { channel: 'channels', role: 'roles', user: 'users' };
const IGNORE_TYPE_LABEL = { channel: 'logging.ignore.typeChannel', role: 'logging.ignore.typeRole', user: 'logging.ignore.typeUser' };
const IGNORING = { channel: 'logging.action.ignoringChannel', role: 'logging.action.ignoringRole', user: 'logging.action.ignoringUser' };

/** The label of a log destination in the request's language (the destination key when unknown). */
const destinationLabel = (tr, d) => (DESTINATION_LABEL[d] ? tr.t(DESTINATION_LABEL[d]) : d);

/** What Mewvo needs in a log forum: see it, start posts and write in them, with embeds. */
const FORUM_PERMS = ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'ReadMessageHistory'];

/** A forum kind's label: the Logging channel label, or the mod log's own. */
const forumKindLabel = (tr, kind) => (kind === 'modlog' ? tr.t('logging.forums.modlog') : destinationLabel(tr, kind));

/** The Advanced logs card: Normal / Advanced and a forum per kind, plus the how-to box. */
function forumsSection(ctx, status, tipHidden) {
    const tr = textFor(ctx);
    const g = ctx.guild;
    const forums = status.forums || {};
    const modes = [['normal', tr.t('logging.forums.normal')], ['advanced', tr.t('logging.forums.advanced')]];
    const rows = LOG_FORUM_KINDS.map((kind) => html`<div class="grid">${selectInput(`mode:${kind}`, forums[kind] ? 'advanced' : 'normal', modes, { label: forumKindLabel(tr, kind) })}
${channelPicker(g, `forum:${kind}`, forums[kind] || null, { label: tr.t('logging.forums.forum'), kinds: ['forum'], perms: FORUM_PERMS, help: tr.t('logging.forums.forumHelp') })}</div>`);
    const form = postForm(ctx, 'logging', 'forums', html`${rows}`, { submit: tr.t('logging.forums.submit'), reset: true, className: 'log-forums' });
    // The how-to: open while a kind is Advanced, else hidden until one is picked (static script); never
    // rendered once this user hid it for good.
    const anyAdvanced = LOG_FORUM_KINDS.some((kind) => forums[kind]);
    const tip = tipHidden ? '' : html`<div class="notice tip" id="log-forum-tip" data-tip="logForum"${anyAdvanced ? '' : html` hidden`}>
<p><strong>${tr.t('logging.forums.tip.title')}</strong></p>
<ol>${['step1', 'step2', 'step3', 'step4', 'step5'].map((step) => html`<li>${tr.t(`logging.forums.tip.${step}`)}</li>`)}</ol>
<div class="tip-actions"><button type="button" class="secondary" data-tip-close>${tr.t('logging.forums.tip.close')}</button>
${buttonForm(ctx, 'logging', 'tip-hide', tr.t('logging.forums.tip.hide'), { tip: 'logForum' })}</div></div>`;
    return html`${tip}${form}`;
}

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

/** "Nothing changed." in the request's language. */
function nothing(ctx) {
    return { changes: [], message: textFor(ctx).t('errors.nothingChanged') };
}

export default {
    key: 'logging',
    label: 'Logging',
    state: 'logging',
    help: 'Mewvo writes down what happens in the server in a log channel: deleted and edited messages, members joining and leaving, role changes and more. Staff can look back later. You can also change these with /logging in Discord. The list of punishments (the mod log) is set on Enforcement & appeals.',

    async load(ctx) {
        const status = await ctx.services.getLoggingStatus(ctx.client, ctx.guildId);
        // Only decides whether a how-to box is shown: a read error shows it (harmless).
        const tipHidden = typeof ctx.services.isTipHidden === 'function'
            ? await ctx.services.isTipHidden(ctx.actor?.userId, 'logForum').catch(() => false)
            : false;
        return { status, modLogChannelId: registryValue(ctx, 'modLogChannelId'), tipHidden };
    },

    render(ctx, { status, modLogChannelId, tipHidden = false }) {
        const tr = textFor(ctx);
        const g = ctx.guild;
        const events = status.enabledEvents || {};
        const channels = postForm(ctx, 'logging', 'channels', html`<div class="grid">
${LOG_DESTINATIONS.map((d) => channelPicker(g, d, status.channels?.[d] || null, { label: destinationLabel(tr, d), perms: PERMS.post }))}</div>`,
        { submit: tr.t('logging.channels.submit'), reset: true });
        // One collapsible group per category (closed by default; the browser remembers which were open).
        const toggles = postForm(ctx, 'logging', 'events', html`${eventCategories().map(([category, types]) => {
            const on = types.filter((type) => events[type] !== false).length;
            const whole = events[`${category}.*`] !== false;
            return html`<details class="sub" data-key="log-${category}"><summary>${category} <span class="muted">${whole ? tr.t('logging.events.count', { on: tr.fmtNumber(on), total: tr.fmtNumber(types.length) }) : tr.t('logging.events.categoryOff')}</span></summary>
<fieldset class="events">${checkboxInput(categoryField(category), whole, { label: tr.t('logging.events.whole', { category }) })}
${types.map((type) => checkboxInput(fieldName(type), events[type] !== false, { label: type.split('.')[1] }))}</fieldset></details>`;
        })}`, { submit: tr.t('logging.events.submit'), reset: true });
        const ignore = status.ignore || { channels: [], roles: [], users: [] };
        const remove = tr.t('logging.ignore.remove');
        const ignoreRows = [
            ...ignore.channels.map((id) => [tr.t(IGNORE_TYPE_LABEL.channel), channelName(g, id), buttonForm(ctx, 'logging', 'ignore-remove', remove, { type: 'channel', id })]),
            ...ignore.roles.map((id) => [tr.t(IGNORE_TYPE_LABEL.role), roleName(g, id), buttonForm(ctx, 'logging', 'ignore-remove', remove, { type: 'role', id })]),
            ...ignore.users.map((id) => [tr.t(IGNORE_TYPE_LABEL.user), html`<code>${id}</code>`, buttonForm(ctx, 'logging', 'ignore-remove', remove, { type: 'user', id })]),
        ];
        const add = tr.t('logging.ignore.add');
        const ignoreForms = html`${table([tr.t('logging.ignore.type'), tr.t('logging.ignore.ignored'), ''], ignoreRows, tr.t('logging.ignore.empty'))}
<div class="grid">${postForm(ctx, 'logging', 'ignore-add', html`<input type="hidden" name="type" value="channel">${channelPicker(g, 'id', null, { label: tr.t('logging.ignore.channel'), kinds: ['text', 'voice', 'category', 'forum'], perms: [], optional: false })}`, { submit: add, inline: true, canEdit: ctx.canEdit && ctx.canAct })}
${postForm(ctx, 'logging', 'ignore-add', html`<input type="hidden" name="type" value="role"><label>${tr.t('logging.ignore.role')}<select name="id">${roleList(g, { includeManaged: true }).map((r) => html`<option value="${r.id}">@${r.name}</option>`)}</select></label>`, { submit: add, inline: true, canEdit: ctx.canEdit && ctx.canAct })}
${postForm(ctx, 'logging', 'ignore-add', html`<input type="hidden" name="type" value="user">${memberField({ name: 'id', label: tr.t('logging.ignore.member'), value: pickedFromQuery(ctx.query, 'ignore_user'), required: true, pick: 'ignore_user', back: path('/logging'), anchor: 'ignore-lists', guild: g })}`, { submit: add, inline: true, canEdit: ctx.canEdit && ctx.canAct })}</div>`;
        // The on/off switch is in the page header (pages.js moduleSettingsPage). Keys: the English titles' slugs.
        const modLog = tr.tx('logging.modLog.text', {
            channel: channelName(g, modLogChannelId),
            change: html`<a href="${path('/enforcement')}">${tr.t('logging.modLog.change')}</a>`,
            tickets: html`<a href="${path('/tickets')}">${tr.t('logging.modLog.tickets')}</a>`,
        });
        return html`${section(tr.t('logging.modLog.title'), html`<p class="muted">${modLog}</p>`, '', { key: 'mod-log' })}
${section(tr.t('logging.channels.title'), channels, tr.t('logging.channels.help'), { key: 'channels' })}
${section(tr.t('logging.forums.title'), forumsSection(ctx, status, tipHidden), tr.t('logging.forums.help'), { key: 'advanced-logs', size: 'full' })}
${section(tr.t('logging.events.title'), toggles, tr.t('logging.events.help'), { key: 'events', size: 'full' })}
${section(tr.t('logging.ignore.title'), ignoreForms, tr.t('logging.ignore.help'), { key: 'ignore-lists', size: 'full' })}`;
    },

    // Safety module: every action needs Administrator (serverScope.js adminOnlyActions).
    actions: adminOnlyActions({
        async enabled(ctx, form) {
            const tr = textFor(ctx);
            const enabled = boolField(form, 'enabled', tr.t('logging.action.label'));
            const before = await ctx.services.getLoggingStatus(ctx.client, ctx.guildId);
            failIfFalse(await ctx.services.setLoggingEnabled(ctx.client, ctx.guildId, enabled));
            const changes = diffSnapshots({ enabled: before.enabled }, { enabled }, null, 'logging.');
            return { changes, message: tr.t(enabled ? 'logging.action.on' : 'logging.action.off') };
        },
        // One locked write per form (loggingService setLogChannels / updateEventLogging): the save
        // is all or nothing, and the audit rows are the changes made against the locked values.
        async channels(ctx, form) {
            const tr = textFor(ctx);
            const wanted = {};
            for (const destination of LOG_DESTINATIONS) {
                if (form?.[destination] === undefined) continue; // absent from the form: unchanged
                wanted[destination] = channelField(ctx.guild, form, destination, { label: destinationLabel(tr, destination) });
            }
            if (!Object.keys(wanted).length) return nothing(ctx);
            const saved = await ctx.services.setLogChannels(ctx.client, ctx.guildId, wanted);
            if (!saved.length) return nothing(ctx);
            return { changes: saved.map((c) => ({ key: `logging.channels.${c.destination}`, old: c.old, new: c.new })), message: tr.t('logging.action.channelsSaved') };
        },
        // Advanced logs: one locked write (loggingService setLogForums); Advanced needs a forum channel.
        async forums(ctx, form) {
            const tr = textFor(ctx);
            const wanted = {};
            for (const kind of LOG_FORUM_KINDS) {
                if (form?.[`mode:${kind}`] === undefined) continue; // absent from the form: unchanged
                const label = forumKindLabel(tr, kind);
                const mode = choiceField(form, `mode:${kind}`, ['normal', 'advanced'], label);
                wanted[kind] = mode === 'advanced'
                    ? channelField(ctx.guild, form, `forum:${kind}`, { kinds: ['forum'], optional: false, label: `${label}: ${tr.t('logging.forums.forum')}` })
                    : null;
            }
            if (!Object.keys(wanted).length) return nothing(ctx);
            const saved = await ctx.services.setLogForums(ctx.client, ctx.guildId, wanted);
            if (!saved.length) return nothing(ctx);
            return { changes: saved.map((c) => ({ key: `logging.forums.${c.kind}`, old: c.old, new: c.new })), message: tr.t('logging.forums.saved') };
        },
        // "Don't show again" on the how-to box: this user only; not a server setting (no audit row).
        async 'tip-hide'(ctx, form) {
            const tr = textFor(ctx);
            choiceField(form, 'tip', ['logForum'], tr.t('logging.forums.tip.title'));
            await ctx.services.hideTip(ctx.actor.userId, 'logForum');
            return { changes: [], message: tr.t('logging.forums.tip.hidden') };
        },
        async events(ctx, form) {
            const changes = [];
            await ctx.services.updateEventLogging(ctx.client, ctx.guildId, (events) => {
                const steps = [];
                changes.length = 0;
                for (const [category, types] of eventCategories()) {
                    const wildcard = `${category}.*`;
                    const wanted = checkbox(form, categoryField(category));
                    if ((events[wildcard] !== false) !== wanted) {
                        steps.push({ types: [wildcard], enabled: wanted });
                        changes.push({ key: `logging.events.${wildcard}`, old: !wanted, new: wanted });
                        continue; // the category toggle sets every event in it
                    }
                    const on = [];
                    const off = [];
                    for (const type of types) {
                        const want = checkbox(form, fieldName(type));
                        if ((events[type] !== false) !== want) (want ? on : off).push(type);
                    }
                    if (on.length) steps.push({ types: on, enabled: true });
                    if (off.length) steps.push({ types: off, enabled: false });
                    for (const type of on) changes.push({ key: `logging.events.${type}`, old: false, new: true });
                    for (const type of off) changes.push({ key: `logging.events.${type}`, old: true, new: false });
                }
                return steps;
            });
            if (!changes.length) return nothing(ctx);
            return { changes, message: textFor(ctx).t('logging.action.eventsSaved') };
        },
        // Administrator only: hiding a channel, role or member from the logs is a safety setting (a manager must not hide their own actions).
        'ignore-add': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const type = choiceField(form, 'type', Object.keys(IGNORE_TYPES), tr.t('logging.ignore.type'));
                let id;
                if (type === 'channel') id = channelField(ctx.guild, form, 'id', { kinds: ['text', 'voice', 'category', 'forum'], optional: false, label: tr.t('logging.action.channelLabel') });
                else if (type === 'role') {
                    id = text(form, 'id', 25);
                    if (!ctx.guild?.roles?.cache?.get(id)) throw new InputError(tr.t('logging.action.roleMissing'));
                } else id = userIdField(form, 'id', tr.t('logging.action.userIdLabel'));
                const before = await ctx.services.getLoggingStatus(ctx.client, ctx.guildId);
                const list = before.ignore?.[IGNORE_TYPES[type]] || [];
                if (list.includes(id)) return { changes: [], message: tr.t('logging.action.already') };
                failIfFalse(await ctx.services.updateIgnoreList(ctx.client, ctx.guildId, { action: 'add', type, id }));
                return { changes: [{ key: `logging.ignore.${IGNORE_TYPES[type]}`, old: list, new: [...list, id] }], message: tr.t(IGNORING[type]) };
            },
        },
        async 'ignore-remove'(ctx, form) {
            const tr = textFor(ctx);
            const type = choiceField(form, 'type', Object.keys(IGNORE_TYPES), tr.t('logging.ignore.type'));
            const id = text(form, 'id', 25);
            if (!/^\d{17,20}$/.test(id)) throw new InputError(tr.t('logging.action.badId'));
            const before = await ctx.services.getLoggingStatus(ctx.client, ctx.guildId);
            const list = before.ignore?.[IGNORE_TYPES[type]] || [];
            if (!list.includes(id)) return { changes: [], message: tr.t('logging.action.notListed') };
            failIfFalse(await ctx.services.updateIgnoreList(ctx.client, ctx.guildId, { action: 'remove', type, id }));
            return { changes: [{ key: `logging.ignore.${IGNORE_TYPES[type]}`, old: list, new: list.filter((x) => x !== id) }], message: tr.t('logging.action.removed') };
        },
    }),
};
