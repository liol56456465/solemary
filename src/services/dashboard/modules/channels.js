// channels.js — Channel tools: purge messages, lock and unlock a channel. Replaces /purge,
// /lock and /unlock; the work is done by channelToolsService (same overwrite behaviour and
// log events as those commands). Everything here is Administrator-only. Purge deletes for
// good, so the first submit shows a confirm page; only its one-time token deletes (routes.js).

import { ChannelType } from 'discord.js';
import { PURGE_MAX, PURGE_MIN, TOOL_PERMS, lockedChannels, missingBotPerms } from '../../channelToolsService.js';
import { auditReason, REASON_MAX } from '../memberActions.js';
import { html, path } from '../html.js';
import { memberField, parseUserRef, pickedFromQuery } from '../memberSearch.js';
import {
    InputError, channelField, channelPicker, intField, isSnowflake, numberInput, postForm, text, textInput,
} from '../forms.js';
import { section, table } from './common.js';
import { textFor } from '../language.js';

// Words: src/content/dashboard/<lang>/channels.json.

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function channelOf(ctx, form, label) {
    const id = channelField(ctx.guild, form, 'channelId', { optional: false, label });
    return ctx.guild.channels.cache.get(id);
}

/** The purge form, checked: { channel, amount, fromUserId, reason }. */
function purgeForm(ctx, form) {
    const tr = textFor(ctx);
    const channel = channelOf(ctx, form, tr.t('channels.field.channel'));
    const amount = intField(form, 'amount', { min: PURGE_MIN, max: PURGE_MAX, label: tr.t('channels.purge.amount') });
    const typed = text(form, 'userId', 40);
    const fromUserId = typed ? parseUserRef(typed) : null;
    if (typed && !fromUserId) throw new InputError(tr.t('channels.purge.badUser'), 400, 'userId');
    return { channel, amount, fromUserId, reason: text(form, 'reason', REASON_MAX) };
}

const moderatorOf = (ctx) => ({ id: ctx.actor.userId, tag: ctx.actor.username || ctx.actor.userId });

export default {
    key: 'channels',
    label: 'Channel tools',
    help: 'Clean up a channel by deleting many recent messages at once, or lock a channel so members cannot write in it for a while, for example during a spam wave.',

    async load() {
        return {};
    },

    render(ctx) {
        const g = ctx.guild;
        const tr = textFor(ctx);
        const can = ctx.canEdit && ctx.canAct;
        const adminNote = ctx.canAct ? '' : tr.t('channels.adminNote');
        const purge = postForm(ctx, 'channels', 'purge', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: tr.t('channels.field.channel'), perms: TOOL_PERMS.purge, optional: false })}
${numberInput('amount', 10, { label: tr.t('channels.purge.amount'), min: PURGE_MIN, max: PURGE_MAX, help: tr.t('channels.purge.amountHelp', { min: tr.fmtNumber(PURGE_MIN), max: tr.fmtNumber(PURGE_MAX) }) })}
${memberField({ name: 'userId', label: tr.t('channels.purge.fromUser'), value: pickedFromQuery(ctx.query, 'purge_user'), pick: 'purge_user', back: path('/channels'), anchor: 'purge-messages', bans: true, guild: g, help: tr.t('channels.purge.fromUserHelp') })}
${textInput('reason', '', { label: tr.t('channels.field.reason'), max: REASON_MAX, help: tr.t('channels.field.reasonHelp') })}</div>
<p class="muted">${tr.tx('channels.purge.nothingYet')}</p>`,
        { submit: tr.t('channels.purge.submit'), danger: true, canEdit: can });
        const lock = postForm(ctx, 'channels', 'lock', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: tr.t('channels.field.channel'), perms: TOOL_PERMS.lock, optional: false })}
${textInput('reason', '', { label: tr.t('channels.field.reason'), max: REASON_MAX, help: tr.t('channels.field.reasonHelp') })}</div>`, { submit: tr.t('channels.lock.submit'), canEdit: can });
        const locked = g ? lockedChannels(g, TEXT_TYPES) : [];
        const rows = locked.map((c) => [html`#${c.name}`, c.parentId ? g.channels.cache.get(c.parentId)?.name || '' : html`<span class="muted">${tr.t('channels.locked.noCategory')}</span>`,
            postForm(ctx, 'channels', 'unlock', textInput('reason', '', { label: '', max: REASON_MAX, placeholder: tr.t('channels.locked.reasonPlaceholder') }),
                { inline: true, submit: tr.t('channels.locked.unlock'), secondary: true, canEdit: can, hidden: { channelId: c.id } })]);
        // Explicit keys: the card ids stay the English slugs in every language.
        return html`${section(tr.t('channels.purge.title'), purge, `${tr.t('channels.purge.help')}${adminNote}`, { key: 'purge-messages' })}
${section(tr.t('channels.lock.title'), lock, `${tr.t('channels.lock.help')}${adminNote}`, { key: 'lock-a-channel' })}
${section(tr.t('channels.locked.title', { count: tr.fmtNumber(locked.length) }), table([tr.t('channels.field.channel'), tr.t('channels.locked.category'), ''], rows, tr.t('channels.locked.empty')), tr.t('channels.locked.help'), { key: `locked-channels-${locked.length}` })}`;
    },

    actions: {
        purge: {
            admin: true,
            async confirm(ctx, form) {
                const tr = textFor(ctx);
                const { channel, amount, fromUserId, reason } = purgeForm(ctx, form);
                const missing = missingBotPerms(ctx.guild, channel, TOOL_PERMS.purge);
                if (missing.length) throw new InputError(tr.t('channels.purge.missingPerms', { perms: missing.join(', '), channel: channel.name }));
                const who = fromUserId ? (ctx.guild.members?.cache?.get(fromUserId)?.user?.username || fromUserId) : null;
                return {
                    heading: tr.t('channels.confirm.heading', { channel: channel.name }),
                    rows: [
                        { label: tr.t('channels.field.channel'), value: `#${channel.name}` },
                        { label: tr.t('channels.confirm.messages'), value: fromUserId ? tr.tp('channels.confirm.fromUser', amount, { who }) : tr.tp('channels.confirm.newest', amount) },
                        { label: tr.t('channels.field.reason'), value: reason || '-' },
                        { label: tr.t('channels.confirm.effect'), value: tr.t('channels.confirm.effectText') },
                    ],
                    submit: tr.t('channels.confirm.submit'),
                };
            },
            async run(ctx, form) {
                const { channel, amount, fromUserId, reason } = purgeForm(ctx, form);
                const result = await ctx.services.purgeChannelMessages({
                    client: ctx.client, guild: ctx.guild, channel, amount, fromUserId, moderator: moderatorOf(ctx), reason: auditReason(ctx.actor.username, reason),
                });
                const tr = textFor(ctx);
                const warnings = result.skippedOld ? [tr.tp('channels.action.skippedOld', result.skippedOld)] : [];
                return {
                    changes: [{ key: `purge.${channel.id}`, old: null, new: { deleted: result.deleted, requested: amount, fromUserId, reason: reason || null } }],
                    message: tr.tp('channels.action.deleted', result.deleted, { channel: channel.name }),
                    warnings,
                };
            },
        },
        lock: {
            admin: true,
            async run(ctx, form) {
                const channel = channelOf(ctx, form, textFor(ctx).t('channels.field.channel'));
                const reason = text(form, 'reason', REASON_MAX);
                await ctx.services.lockChannel({ client: ctx.client, guild: ctx.guild, channel, moderator: moderatorOf(ctx), auditReason: auditReason(ctx.actor.username, reason) });
                return { changes: [{ key: `lock.${channel.id}`, old: false, new: true }], message: textFor(ctx).t('channels.action.locked', { channel: channel.name }) };
            },
        },
        unlock: {
            admin: true,
            async run(ctx, form) {
                const channel = channelOf(ctx, form, textFor(ctx).t('channels.field.channel'));
                const reason = text(form, 'reason', REASON_MAX);
                await ctx.services.unlockChannel({ client: ctx.client, guild: ctx.guild, channel, moderator: moderatorOf(ctx), auditReason: auditReason(ctx.actor.username, reason) });
                return { changes: [{ key: `lock.${channel.id}`, old: true, new: false }], message: textFor(ctx).t('channels.action.unlocked', { channel: channel.name }) };
            },
        },
    },
};
