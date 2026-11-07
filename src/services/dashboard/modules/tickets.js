// tickets.js — Tickets (categories, staff role, limits, logs, panel text), the modmail
// block list (view / block / unblock) and canned answers (list / add / remove). Writes go
// through ticketSettingsService, modmailService and cannedService, as the commands do.

import { CANNED_MAX_LENGTH, CANNED_NAME } from '../../cannedService.js';
import { html, path } from '../html.js';
import { memberField, pickedFromQuery } from '../memberSearch.js';
import {
    InputError, PERMS, buttonForm, channelField, channelName, channelPicker, channelWarnings, checkbox, switchInput, intField,
    multiline, numberInput, postForm, roleField, rolePicker, text, textArea, textInput, userIdField,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { changedOnly, section, table, topic } from './common.js';
import { textFor } from '../language.js';

// Words: src/content/dashboard/<lang>/tickets.json. The default button text and panel message
// ("Open ticket", "Need help from staff? …") are posted in Discord and stay as they are.

export default {
    key: 'tickets',
    label: 'Tickets & modmail',
    state: 'tickets',
    help: 'Tickets let members ask staff for help in a private channel. They press a button on the ticket panel (a message Mewvo posts) and get their own channel that only they and staff can see. Modmail is the same idea through a private message to Mewvo. You can also set this up with /ticket setup in Discord.',

    async load(ctx) {
        const [settings, config, canned] = await Promise.all([
            ctx.services.getTicketSettings(ctx.client, ctx.guildId),
            ctx.services.getGuildConfig(ctx.client, ctx.guildId),
            ctx.services.listCanned(ctx.guildId),
        ]);
        return { settings, blocked: Array.isArray(config.modmailBlocked) ? config.modmailBlocked : [], canned };
    },

    render(ctx, { settings: t, blocked, canned }) {
        const g = ctx.guild;
        const tr = textFor(ctx);
        const form = postForm(ctx, 'tickets', 'settings', html`<div class="grid">
${channelPicker(g, 'ticketCategoryId', t.ticketCategoryId, { label: tr.t('tickets.settings.openCategory'), kinds: ['category'], perms: PERMS.category, help: tr.t('tickets.settings.openCategoryHelp') })}
${channelPicker(g, 'ticketClosedCategoryId', t.ticketClosedCategoryId, { label: tr.t('tickets.settings.closedCategory'), kinds: ['category'], perms: PERMS.category, help: tr.t('tickets.settings.closedCategoryHelp') })}
${rolePicker(g, 'ticketStaffRoleId', t.ticketStaffRoleId, { label: tr.t('tickets.settings.staffRole'), assign: false, help: tr.t('tickets.settings.staffRoleHelp') })}
${numberInput('maxTicketsPerUser', t.maxTicketsPerUser ?? 3, { label: tr.t('tickets.settings.maxPerUser'), min: 1, max: 10, help: tr.t('tickets.settings.maxPerUserHelp') })}
${switchInput('dmOnClose', t.dmOnClose !== false, { label: tr.t('tickets.settings.dmOnClose'), help: tr.t('tickets.settings.dmOnCloseHelp') })}
${channelPicker(g, 'ticketLogsChannelId', t.ticketLogsChannelId, { label: tr.t('tickets.settings.logChannel'), perms: PERMS.post, help: tr.t('tickets.settings.logChannelHelp') })}
${channelPicker(g, 'ticketTranscriptChannelId', t.ticketTranscriptChannelId, { label: tr.t('tickets.settings.transcriptChannel'), perms: PERMS.postFiles, help: tr.t('tickets.settings.transcriptChannelHelp') })}
${textInput('ticketButtonLabel', t.ticketButtonLabel || 'Open ticket', { label: tr.t('tickets.settings.buttonText'), max: 80, help: tr.t('tickets.settings.buttonTextHelp') })}
${textArea('ticketPanelMessage', t.ticketPanelMessage || '', { label: tr.t('tickets.settings.panelMessage'), max: 2000, help: tr.t('tickets.settings.panelMessageHelp') })}</div>`);
        const canPost = ctx.canEdit && ctx.canAct;
        const panel = t.ticketPanelChannelId
            ? html`<div class="panel-row"><p>${tr.tx('tickets.panel.postedIn', { channel: channelName(g, t.ticketPanelChannelId), warnings: html`${channelWarnings(g, t.ticketPanelChannelId, PERMS.post).map((w) => html` <span class="field-warn">${w}</span>`)}` })}</p>
${buttonForm(ctx, 'tickets', 'panel-publish', tr.t('tickets.panel.republish'), {}, { danger: false, canEdit: canPost })}</div>
<p class="muted">${tr.tx('tickets.panel.textNote')}</p>`
            : html`<p class="warn">${tr.tx('tickets.panel.none')}</p>${postForm(ctx, 'tickets', 'setup', html`<div class="grid">
${channelPicker(g, 'panelChannelId', null, { label: tr.t('tickets.panel.postIn'), perms: PERMS.post, optional: false, help: tr.t('tickets.panel.postInHelp') })}
${textInput('buttonLabel', 'Open ticket', { label: tr.t('tickets.settings.buttonText'), max: 80 })}
${channelPicker(g, 'categoryId', null, { label: tr.t('tickets.settings.openCategory'), kinds: ['category'], perms: PERMS.category, noneLabel: tr.t('tickets.panel.newCategory'), help: tr.t('tickets.settings.openCategoryHelp') })}
${channelPicker(g, 'closedCategoryId', null, { label: tr.t('tickets.settings.closedCategory'), kinds: ['category'], perms: PERMS.category, help: tr.t('tickets.settings.closedCategoryHelp') })}
${rolePicker(g, 'staffRoleId', null, { label: tr.t('tickets.settings.staffRole'), assign: false, help: tr.t('tickets.settings.staffRoleHelp') })}
${numberInput('maxTicketsPerUser', 3, { label: tr.t('tickets.settings.maxPerUser'), min: 1, max: 10, help: tr.t('tickets.settings.maxRange') })}
${switchInput('dmOnClose', true, { label: tr.t('tickets.settings.dmOnClose') })}
${textArea('panelMessage', 'Need help from staff? Press the button below to open a private ticket.', { label: tr.t('tickets.settings.panelMessage'), max: 2000 })}</div>`, { submit: tr.t('tickets.panel.submit'), canEdit: canPost })}`;
        const blockForm = postForm(ctx, 'tickets', 'block', html`<div class="grid">
${memberField({ name: 'userId', label: tr.t('tickets.blocked.member'), value: pickedFromQuery(ctx.query, 'block_user'), required: true, pick: 'block_user', back: path('/tickets'), anchor: 'modmail-blocked-members', bans: true, guild: g })}
${textInput('reason', '', { label: tr.t('tickets.blocked.reason'), max: 200, help: tr.t('tickets.blocked.reasonHelp') })}</div>`, { submit: tr.t('tickets.blocked.submit'), canEdit: ctx.canEdit && ctx.canAct, confirm: tr.t('tickets.blocked.confirm') })
        const blockedRows = blocked.map((id) => [html`<code>${id}</code>`, buttonForm(ctx, 'tickets', 'unblock', tr.t('tickets.blocked.unblock'), { userId: id }, { danger: false })]);
        const cannedRows = Object.entries(canned).sort((a, b) => a[0].localeCompare(b[0])).map(([name, body]) => [
            html`<code>${name}</code>${ctx.services.isBuiltInCanned(name) ? html` <span class="muted">${tr.t('tickets.canned.builtIn')}</span>` : ''}`,
            body.length > 200 ? `${body.slice(0, 199)}…` : body,
            // Built-ins can be replaced (same name) but not deleted: no button that would only be refused.
            ctx.services.isBuiltInCanned(name) ? ''
                : buttonForm(ctx, 'tickets', 'canned-remove', tr.t('tickets.canned.delete'), { name }, { confirm: tr.t('tickets.canned.confirmDelete', { name }) }),
        ]);
        const cannedAdd = postForm(ctx, 'tickets', 'canned-add', html`<div class="grid">
${textInput('name', '', { label: tr.t('tickets.canned.name'), max: 32, help: tr.t('tickets.canned.nameHelp') })}
${textArea('text', '', { label: tr.t('tickets.canned.answer'), max: CANNED_MAX_LENGTH, rows: 3, help: tr.t('tickets.canned.answerHelp') })}</div>`, { submit: tr.t('tickets.canned.submit'), reset: true });
        // v6: cards grouped by topic (common.js topic/section).
        return html`${topic(tr.t('tickets.topic.tickets'), tr.t('tickets.topic.ticketsLine'), html`${section(tr.t('tickets.panel.title'), panel, tr.t(ctx.canAct ? 'tickets.panel.help' : 'tickets.panel.helpNoAdmin'), { key: 'ticket-panel', size: 'full' })}
${section(tr.t('tickets.settings.title'), form, tr.t('tickets.settings.help'), { key: 'ticket-settings', size: 'wide' })}`, { key: 'tickets' })}
${topic(tr.t('tickets.topic.modmail'), tr.t('tickets.topic.modmailLine'), html`${section(tr.t('tickets.blocked.title'), html`${table([tr.t('tickets.blocked.userId'), ''], blockedRows, tr.t('tickets.blocked.empty'))}<h3>${tr.t('tickets.blocked.heading')}</h3>${blockForm}`, tr.t('tickets.blocked.help'), { key: 'modmail-blocked-members', size: 'normal' })}
${section(tr.t('tickets.canned.title'), html`${table([tr.t('tickets.canned.name'), tr.t('tickets.canned.text'), ''], cannedRows)}${cannedAdd}`, tr.t('tickets.canned.help'), { key: 'canned-answers', size: 'normal' })}`, { key: 'modmail-and-saved-answers' })}`;
    },

    actions: {
        setup: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const tr = textFor(ctx);
                const panelChannelId = channelField(g, form, 'panelChannelId', { optional: false, label: tr.t('tickets.panel.postIn') });
                const { message, settings } = await ctx.services.setupTicketSystem(ctx.client, g, {
                    panelChannel: g.channels.cache.get(panelChannelId),
                    panelMessage: multiline(form, 'panelMessage', 2000),
                    buttonLabel: text(form, 'buttonLabel', 80),
                    categoryId: channelField(g, form, 'categoryId', { kinds: ['category'], label: tr.t('tickets.settings.openCategory') }),
                    closedCategoryId: channelField(g, form, 'closedCategoryId', { kinds: ['category'], label: tr.t('tickets.settings.closedCategory') }),
                    staffRoleId: roleField(g, form, 'staffRoleId', { label: tr.t('tickets.settings.staffRole') }),
                    maxTicketsPerUser: intField(form, 'maxTicketsPerUser', { min: 1, max: 10, label: tr.t('tickets.settings.maxPerUser') }),
                    dmOnClose: checkbox(form, 'dmOnClose'),
                });
                return {
                    changes: [{ key: 'ticketPanel', old: null, new: { channelId: panelChannelId, messageId: message?.id || null } },
                        ...Object.entries(settings || {}).filter(([k]) => k !== 'ticketPanelMessageId' && k !== 'ticketPanelChannelId').map(([key, value]) => ({ key, old: null, new: value }))],
                    message: tr.t('tickets.action.setUp'),
                };
            },
        },
        'panel-publish': {
            admin: true,
            async run(ctx) {
                const { action, message } = await ctx.services.publishTicketPanel(ctx.client, ctx.guild);
                return {
                    changes: [{ key: 'ticketPanel', old: null, new: action === 'posted' ? { posted: message?.id || true } : { updated: true } }],
                    message: textFor(ctx).t(action === 'posted' ? 'tickets.action.panelReposted' : 'tickets.action.panelUpdated'),
                };
            },
        },
        async settings(ctx, form) {
            const g = ctx.guild;
            const tr = textFor(ctx);
            const current = await ctx.services.getTicketSettings(ctx.client, ctx.guildId);
            const patch = changedOnly({
                ticketCategoryId: channelField(g, form, 'ticketCategoryId', { kinds: ['category'], label: tr.t('tickets.settings.openCategory') }),
                ticketClosedCategoryId: channelField(g, form, 'ticketClosedCategoryId', { kinds: ['category'], label: tr.t('tickets.settings.closedCategory') }),
                ticketStaffRoleId: roleField(g, form, 'ticketStaffRoleId', { label: tr.t('tickets.settings.staffRole') }),
                maxTicketsPerUser: intField(form, 'maxTicketsPerUser', { min: 1, max: 10, label: tr.t('tickets.settings.maxPerUser') }),
                dmOnClose: checkbox(form, 'dmOnClose'),
                ticketLogsChannelId: channelField(g, form, 'ticketLogsChannelId', { label: tr.t('tickets.settings.logChannel') }),
                ticketTranscriptChannelId: channelField(g, form, 'ticketTranscriptChannelId', { label: tr.t('tickets.settings.transcriptChannel') }),
                ticketButtonLabel: text(form, 'ticketButtonLabel', 80) || 'Open ticket',
                ticketPanelMessage: multiline(form, 'ticketPanelMessage', 2000) || current.ticketPanelMessage || 'Need help from staff? Press the button below to open a private ticket.',
            }, { ...current, dmOnClose: current.dmOnClose !== false, maxTicketsPerUser: current.maxTicketsPerUser ?? 3, ticketButtonLabel: current.ticketButtonLabel || 'Open ticket' });
            if (!Object.keys(patch).length) return { changes: [], message: tr.t('errors.nothingChanged') };

            const { before, after } = await ctx.services.updateTicketSettings(ctx.client, ctx.guildId, patch);
            return { changes: diffSnapshots(before, after, Object.keys(patch)), message: tr.t('tickets.action.settingsSaved') };
        },
        block: {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const userId = userIdField(form, 'userId', tr.t('tickets.blocked.userId'));
                const reason = text(form, 'reason', 200);
                const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
                const before = Array.isArray(config.modmailBlocked) ? config.modmailBlocked : [];
                if (before.includes(userId)) return { changes: [], message: tr.t('tickets.action.alreadyBlocked') };
                await ctx.services.setModmailBlocked(ctx.client, ctx.guildId, userId, true);
                const open = await ctx.services.findModmailChannel(ctx.guild, userId).catch(() => null);
                return {
                    changes: [{ key: 'modmailBlocked', old: before, new: [...before, userId] }, ...(reason ? [{ key: `modmailBlocked.${userId}.reason`, old: null, new: reason }] : [])],
                    message: open ? tr.t('tickets.action.blockedOpen', { user: userId, channel: open.name }) : tr.t('tickets.action.blocked', { user: userId }),
                };
            },
        },
        async unblock(ctx, form) {
            const tr = textFor(ctx);
            const userId = userIdField(form, 'userId', tr.t('tickets.blocked.userId'));
            const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
            const before = Array.isArray(config.modmailBlocked) ? config.modmailBlocked : [];
            if (!before.includes(userId)) return { changes: [], message: tr.t('tickets.action.notBlocked') };
            await ctx.services.setModmailBlocked(ctx.client, ctx.guildId, userId, false);
            return { changes: [{ key: 'modmailBlocked', old: before, new: before.filter((id) => id !== userId) }], message: tr.t('tickets.action.unblocked') };
        },
        async 'canned-add'(ctx, form) {
            const tr = textFor(ctx);
            const name = text(form, 'name', 40).toLowerCase();
            if (!CANNED_NAME.test(name)) throw new InputError(tr.t('tickets.canned.error.name'));
            const body = multiline(form, 'text', CANNED_MAX_LENGTH + 1);
            if (!body) throw new InputError(tr.t('tickets.canned.error.empty'));
            if (body.length > CANNED_MAX_LENGTH) throw new InputError(tr.t('tickets.canned.error.tooLong', { max: tr.fmtNumber(CANNED_MAX_LENGTH) }));
            const before = (await ctx.services.listCanned(ctx.guildId))[name] ?? null;
            await ctx.services.saveCanned(ctx.guildId, name, body);
            return { changes: before === body ? [] : [{ key: `canned.${name}`, old: before, new: body }], message: tr.t('tickets.canned.saved', { name }) };
        },
        async 'canned-remove'(ctx, form) {
            const tr = textFor(ctx);
            const name = text(form, 'name', 40).toLowerCase();
            if (!CANNED_NAME.test(name)) throw new InputError(tr.t('tickets.canned.error.unknown'));
            const before = (await ctx.services.listCanned(ctx.guildId))[name] ?? null;
            const removed = await ctx.services.removeCanned(ctx.guildId, name);
            if (!removed) {
                throw new InputError(tr.t(ctx.services.isBuiltInCanned(name) ? 'tickets.canned.error.builtIn' : 'tickets.canned.error.noSuch', { name }));
            }
            const after = (await ctx.services.listCanned(ctx.guildId))[name] ?? null;
            return { changes: [{ key: `canned.${name}`, old: before, new: after }], message: tr.t('tickets.canned.deleted', { name }) };

        },
    },
};
