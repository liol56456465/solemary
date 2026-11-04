// tickets.js — Tickets (categories, staff role, limits, logs, panel text), the modmail
// block list (view / block / unblock) and canned answers (list / add / remove). Writes go
// through ticketSettingsService, modmailService and cannedService, as the commands do.

import { CANNED_MAX_LENGTH, CANNED_NAME } from '../../cannedService.js';
import { html } from '../html.js';
import {
    InputError, PERMS, buttonForm, channelField, channelName, channelPicker, channelWarnings, checkbox, switchInput, intField,
    multiline, numberInput, postForm, roleField, rolePicker, text, textArea, textInput, userIdField,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, section, table, topic } from './common.js';

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
        const form = postForm(ctx, 'tickets', 'settings', html`<div class="grid">
${channelPicker(g, 'ticketCategoryId', t.ticketCategoryId, { label: 'Open tickets category', kinds: ['category'], perms: PERMS.category, help: 'A category is a folder of channels. New ticket channels are made in it.' })}
${channelPicker(g, 'ticketClosedCategoryId', t.ticketClosedCategoryId, { label: 'Closed tickets category', kinds: ['category'], perms: PERMS.category, help: 'Closed tickets are moved here.' })}
${rolePicker(g, 'ticketStaffRoleId', t.ticketStaffRoleId, { label: 'Ticket staff role', assign: false, help: 'Members with this role can see and answer every ticket.' })}
${numberInput('maxTicketsPerUser', t.maxTicketsPerUser ?? 3, { label: 'Open tickets per member', min: 1, max: 10, help: 'How many tickets one member can have open at once. From 1 to 10.' })}
${switchInput('dmOnClose', t.dmOnClose !== false, { label: 'Message the member when their ticket closes', help: 'Sent to them privately (a DM).' })}
${channelPicker(g, 'ticketLogsChannelId', t.ticketLogsChannelId, { label: 'Ticket log channel', perms: PERMS.post, help: 'Staff get a short line here when a ticket is opened, claimed, closed or deleted.' })}
${channelPicker(g, 'ticketTranscriptChannelId', t.ticketTranscriptChannelId, { label: 'Transcript channel', perms: PERMS.postFiles, help: 'A transcript is a file with every message from a ticket. Mewvo posts it here when the ticket closes.' })}
${textInput('ticketButtonLabel', t.ticketButtonLabel || 'Open ticket', { label: 'Button text', max: 80, help: 'The words on the button members press to open a ticket.' })}
${textArea('ticketPanelMessage', t.ticketPanelMessage || '', { label: 'Panel message', max: 2000, help: 'The text above the button. Tell members what tickets are for.' })}</div>`);
        const canPost = ctx.canEdit && ctx.canAct;
        const panel = t.ticketPanelChannelId
            ? html`<div class="panel-row"><p>Panel in ${channelName(g, t.ticketPanelChannelId)}${channelWarnings(g, t.ticketPanelChannelId, PERMS.post).map((w) => html` <span class="field-warn">${w}</span>`)}.</p>
${buttonForm(ctx, 'tickets', 'panel-publish', 'Update or re-post the panel', {}, { danger: false, canEdit: canPost })}</div>
<p class="muted">Saving the panel text below does not change the message already in Discord. Update the panel to show the new text.</p>`
            : html`<p class="warn">No ticket panel yet. Fill this in to post one.</p>${postForm(ctx, 'tickets', 'setup', html`<div class="grid">
${channelPicker(g, 'panelChannelId', null, { label: 'Post the panel in', perms: PERMS.post, optional: false, help: 'Pick a channel every member can see.' })}
${textInput('buttonLabel', 'Open ticket', { label: 'Button text', max: 80 })}
${channelPicker(g, 'categoryId', null, { label: 'Open tickets category', kinds: ['category'], perms: PERMS.category, noneLabel: 'a new "Tickets" category', help: 'A category is a folder of channels. New ticket channels are made in it.' })}
${channelPicker(g, 'closedCategoryId', null, { label: 'Closed tickets category', kinds: ['category'], perms: PERMS.category, help: 'Closed tickets are moved here.' })}
${rolePicker(g, 'staffRoleId', null, { label: 'Ticket staff role', assign: false, help: 'Members with this role can see and answer every ticket.' })}
${numberInput('maxTicketsPerUser', 3, { label: 'Open tickets per member', min: 1, max: 10, help: 'From 1 to 10.' })}
${switchInput('dmOnClose', true, { label: 'Message the member when their ticket closes' })}
${textArea('panelMessage', 'Need help from staff? Press the button below to open a private ticket.', { label: 'Panel message', max: 2000 })}</div>`, { submit: 'Set up and post the panel', canEdit: canPost })}`;
        const blockForm = postForm(ctx, 'tickets', 'block', html`<div class="grid">
${textInput('userId', '', { label: 'Member (user ID)', max: 25, help: 'The long number that identifies a member. In Discord, turn on Developer Mode, right-click the member and pick Copy User ID.' })}
${textInput('reason', '', { label: 'Reason (optional)', max: 200, help: 'Only staff see it, in the dashboard history.' })}</div>`, { submit: 'Block from modmail', canEdit: ctx.canEdit && ctx.canAct, confirm: 'Block this member from modmail?' })
        const blockedRows = blocked.map((id) => [html`<code>${id}</code>`, buttonForm(ctx, 'tickets', 'unblock', 'Unblock', { userId: id }, { danger: false })]);
        const cannedRows = Object.entries(canned).sort((a, b) => a[0].localeCompare(b[0])).map(([name, body]) => [
            html`<code>${name}</code>${ctx.services.isBuiltInCanned(name) ? html` <span class="muted">(built-in)</span>` : ''}`,
            body.length > 200 ? `${body.slice(0, 199)}…` : body,
            // Built-ins can be replaced (same name) but not deleted: no button that would only be refused.
            ctx.services.isBuiltInCanned(name) ? ''
                : buttonForm(ctx, 'tickets', 'canned-remove', 'Delete', { name }, { confirm: `Delete the saved answer "${name}"?` }),
        ]);
        const cannedAdd = postForm(ctx, 'tickets', 'canned-add', html`<div class="grid">
${textInput('name', '', { label: 'Name', max: 32, help: 'Staff type this name to post the answer. Small letters, numbers and - only, like refund-policy.' })}
${textArea('text', '', { label: 'Answer', max: CANNED_MAX_LENGTH, rows: 3, help: 'The text Mewvo posts.' })}</div>`, { submit: 'Save answer' });
        // v6: cards grouped by topic (common.js topic/section).
        return html`${topic('Tickets', 'The button members press to open a ticket, and where tickets go.', html`${section('Ticket panel', panel, `The message with the button members press.${ctx.canAct ? '' : ' To post the panel you need the Administrator permission in the main server.'}`, { size: 'full' })}
${section('Ticket settings', form, 'Categories, the staff role, logs and the panel text.', { size: 'wide' })}`)}
${topic('Modmail and saved answers', 'Who may not message staff, and answers staff post often.', html`${section('Modmail blocked members', html`${table(['User ID', ''], blockedRows, 'Nobody is blocked from modmail.')}<h3>Block a member</h3>${blockForm}`, 'Blocked members cannot start a modmail chat with staff. A chat that is already open stays until staff close it. You can also do this with /modmail block in Discord.', { size: 'normal' })}
${section('Canned answers', html`${table(['Name', 'Text', ''], cannedRows)}${cannedAdd}`, 'Saved answers for questions staff get often. Staff post one in a ticket with /canned send. The built-in answers cannot be deleted, but you can change their text by saving an answer with the same name.', { size: 'normal' })}`)}`;
    },

    actions: {
        setup: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const panelChannelId = channelField(g, form, 'panelChannelId', { optional: false, label: 'Post the panel in' });
                const { message, settings } = await ctx.services.setupTicketSystem(ctx.client, g, {
                    panelChannel: g.channels.cache.get(panelChannelId),
                    panelMessage: multiline(form, 'panelMessage', 2000),
                    buttonLabel: text(form, 'buttonLabel', 80),
                    categoryId: channelField(g, form, 'categoryId', { kinds: ['category'], label: 'Open tickets category' }),
                    closedCategoryId: channelField(g, form, 'closedCategoryId', { kinds: ['category'], label: 'Closed tickets category' }),
                    staffRoleId: roleField(g, form, 'staffRoleId', { label: 'Ticket staff role' }),
                    maxTicketsPerUser: intField(form, 'maxTicketsPerUser', { min: 1, max: 10, label: 'Open tickets per member' }),
                    dmOnClose: checkbox(form, 'dmOnClose'),
                });
                return {
                    changes: [{ key: 'ticketPanel', old: null, new: { channelId: panelChannelId, messageId: message?.id || null } },
                        ...Object.entries(settings || {}).filter(([k]) => k !== 'ticketPanelMessageId' && k !== 'ticketPanelChannelId').map(([key, value]) => ({ key, old: null, new: value }))],
                    message: 'Ticket system set up: the panel is posted.',
                };
            },
        },
        'panel-publish': {
            admin: true,
            async run(ctx) {
                const { action, message } = await ctx.services.publishTicketPanel(ctx.client, ctx.guild);
                return {
                    changes: [{ key: 'ticketPanel', old: null, new: action === 'posted' ? { posted: message?.id || true } : { updated: true } }],
                    message: action === 'posted' ? 'The panel was missing: a new one is posted.' : 'The live panel now shows the saved text.',
                };
            },
        },
        async settings(ctx, form) {
            const g = ctx.guild;
            const current = await ctx.services.getTicketSettings(ctx.client, ctx.guildId);
            const patch = changedOnly({
                ticketCategoryId: channelField(g, form, 'ticketCategoryId', { kinds: ['category'], label: 'Open tickets category' }),
                ticketClosedCategoryId: channelField(g, form, 'ticketClosedCategoryId', { kinds: ['category'], label: 'Closed tickets category' }),
                ticketStaffRoleId: roleField(g, form, 'ticketStaffRoleId', { label: 'Ticket staff role' }),
                maxTicketsPerUser: intField(form, 'maxTicketsPerUser', { min: 1, max: 10, label: 'Open tickets per member' }),
                dmOnClose: checkbox(form, 'dmOnClose'),
                ticketLogsChannelId: channelField(g, form, 'ticketLogsChannelId', { label: 'Ticket log channel' }),
                ticketTranscriptChannelId: channelField(g, form, 'ticketTranscriptChannelId', { label: 'Transcript channel' }),
                ticketButtonLabel: text(form, 'ticketButtonLabel', 80) || 'Open ticket',
                ticketPanelMessage: multiline(form, 'ticketPanelMessage', 2000) || current.ticketPanelMessage || 'Need help from staff? Press the button below to open a private ticket.',
            }, { ...current, dmOnClose: current.dmOnClose !== false, maxTicketsPerUser: current.maxTicketsPerUser ?? 3, ticketButtonLabel: current.ticketButtonLabel || 'Open ticket' });
            if (!Object.keys(patch).length) return NOTHING;
            const { before, after } = await ctx.services.updateTicketSettings(ctx.client, ctx.guildId, patch);
            return { changes: diffSnapshots(before, after, Object.keys(patch)), message: 'Ticket settings saved.' };
        },
        block: {
            admin: true,
            async run(ctx, form) {
                const userId = userIdField(form, 'userId', 'User ID');
                const reason = text(form, 'reason', 200);
                const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
                const before = Array.isArray(config.modmailBlocked) ? config.modmailBlocked : [];
                if (before.includes(userId)) return { changes: [], message: 'That member is already blocked from modmail.' };
                await ctx.services.setModmailBlocked(ctx.client, ctx.guildId, userId, true);
                const open = await ctx.services.findModmailChannel(ctx.guild, userId).catch(() => null);
                return {
                    changes: [{ key: 'modmailBlocked', old: before, new: [...before, userId] }, ...(reason ? [{ key: `modmailBlocked.${userId}.reason`, old: null, new: reason }] : [])],
                    message: `${userId} can no longer use modmail.${open ? ` Their open conversation #${open.name} stays until you close it.` : ''}`,
                };
            },
        },
        async unblock(ctx, form) {
            const userId = userIdField(form, 'userId', 'User ID');
            const config = await ctx.services.getGuildConfig(ctx.client, ctx.guildId);
            const before = Array.isArray(config.modmailBlocked) ? config.modmailBlocked : [];
            if (!before.includes(userId)) return { changes: [], message: 'That member was not blocked.' };
            await ctx.services.setModmailBlocked(ctx.client, ctx.guildId, userId, false);
            return { changes: [{ key: 'modmailBlocked', old: before, new: before.filter((id) => id !== userId) }], message: 'Unblocked from modmail.' };
        },
        async 'canned-add'(ctx, form) {
            const name = text(form, 'name', 40).toLowerCase();
            if (!CANNED_NAME.test(name)) throw new InputError('Names can only use small letters, numbers and -, up to 32 characters.');
            const body = multiline(form, 'text', CANNED_MAX_LENGTH + 1);
            if (!body) throw new InputError('The answer cannot be empty.');
            if (body.length > CANNED_MAX_LENGTH) throw new InputError(`Answers are limited to ${CANNED_MAX_LENGTH} characters.`);
            const before = (await ctx.services.listCanned(ctx.guildId))[name] ?? null;
            await ctx.services.saveCanned(ctx.guildId, name, body);
            return { changes: before === body ? [] : [{ key: `canned.${name}`, old: before, new: body }], message: `Saved "${name}".` };
        },
        async 'canned-remove'(ctx, form) {
            const name = text(form, 'name', 40).toLowerCase();
            if (!CANNED_NAME.test(name)) throw new InputError('Unknown answer.');
            const before = (await ctx.services.listCanned(ctx.guildId))[name] ?? null;
            const removed = await ctx.services.removeCanned(ctx.guildId, name);
            if (!removed) {
                throw new InputError(ctx.services.isBuiltInCanned(name) ? `"${name}" is built in and cannot be deleted. To change its text, save an answer with the same name.` : `There is no saved answer called "${name}".`);
            }
            const after = (await ctx.services.listCanned(ctx.guildId))[name] ?? null;
            return { changes: [{ key: `canned.${name}`, old: before, new: after }], message: `Deleted "${name}".` };
        },
    },
};
