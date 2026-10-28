// channels.js — Channel tools: purge messages, lock and unlock a channel. Replaces /purge,
// /lock and /unlock; the work is done by channelToolsService (same overwrite behaviour and
// log events as those commands). Everything here is Administrator-only. Purge deletes for
// good, so it needs a ticked confirm box (checked on the server) as well as the script's ask.

import { ChannelType } from 'discord.js';
import { PURGE_MAX, PURGE_MIN, TOOL_PERMS, lockedChannels } from '../../channelToolsService.js';
import { auditReason, REASON_MAX } from '../memberActions.js';
import { html } from '../html.js';
import {
    InputError, channelField, channelPicker, checkbox, checkboxInput, intField, isSnowflake, numberInput, postForm, text, textInput,
} from '../forms.js';
import { section, table } from './common.js';

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function channelOf(ctx, form, label) {
    const id = channelField(ctx.guild, form, 'channelId', { optional: false, label });
    return ctx.guild.channels.cache.get(id);
}

const moderatorOf = (ctx) => ({ id: ctx.actor.userId, tag: ctx.actor.username || ctx.actor.userId });

export default {
    key: 'channels',
    label: 'Channel tools',
    help: 'Delete recent messages in bulk, and lock or unlock a channel for @everyone (what /purge, /lock and /unlock did).',

    async load() {
        return {};
    },

    render(ctx) {
        const g = ctx.guild;
        const can = ctx.canEdit && ctx.canAct;
        const adminNote = ctx.canAct ? '' : ' These tools need Administrator in the main server.';
        const purge = postForm(ctx, 'channels', 'purge', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: 'Channel', perms: TOOL_PERMS.purge, optional: false })}
${numberInput('amount', 10, { label: 'Number of messages', min: PURGE_MIN, max: PURGE_MAX, help: `${PURGE_MIN}–${PURGE_MAX}, newest first.` })}
${textInput('userId', '', { label: 'Only from this user ID (optional)', max: 20, help: 'Searches the newest 100 messages.' })}
${textInput('reason', '', { label: 'Reason', max: REASON_MAX })}</div>
${checkboxInput('confirm', false, { label: 'I understand deleted messages cannot be restored (required)' })}`,
        { submit: 'Delete messages', danger: true, canEdit: can, confirm: 'Delete these messages for good?' });
        const lock = postForm(ctx, 'channels', 'lock', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: 'Channel', perms: TOOL_PERMS.lock, optional: false })}
${textInput('reason', '', { label: 'Reason', max: REASON_MAX })}</div>`, { submit: 'Lock channel', canEdit: can });
        const locked = g ? lockedChannels(g, TEXT_TYPES) : [];
        const rows = locked.map((c) => [html`#${c.name}`, c.parentId ? g.channels.cache.get(c.parentId)?.name || '' : html`<span class="muted">none</span>`,
            postForm(ctx, 'channels', 'unlock', textInput('reason', '', { label: '', max: REASON_MAX, placeholder: 'Reason (optional)' }),
                { inline: true, submit: 'Unlock', secondary: true, canEdit: can, hidden: { channelId: c.id } })]);
        return html`${section('Purge messages', purge, `Bulk-deletes recent messages. Discord does not bulk-delete messages older than 14 days; those are skipped.${adminNote}`)}
${section('Lock a channel', lock, `Denies Send Messages for @everyone in the channel. Unlock clears that again, so the channel follows its category.${adminNote}`)}
${section(`Locked channels (${locked.length})`, table(['Channel', 'Category', ''], rows, 'No channel is locked.'), 'Channels whose own @everyone permission denies Send Messages.')}`;
    },

    actions: {
        purge: {
            admin: true,
            async run(ctx, form) {
                const channel = channelOf(ctx, form, 'Channel');
                const amount = intField(form, 'amount', { min: PURGE_MIN, max: PURGE_MAX, label: 'Number of messages' });
                const fromUserId = text(form, 'userId', 25) || null;
                if (fromUserId && !isSnowflake(fromUserId)) throw new InputError('Only from this user: must be a Discord user ID (17–20 digits).', 400, 'userId');
                const reason = text(form, 'reason', REASON_MAX);
                if (!checkbox(form, 'confirm')) throw new InputError('Tick the box to confirm: deleted messages cannot be restored.', 400, 'confirm');
                const result = await ctx.services.purgeChannelMessages({
                    client: ctx.client, guild: ctx.guild, channel, amount, fromUserId, moderator: moderatorOf(ctx), reason: auditReason(ctx.actor.username, reason),
                });
                const warnings = result.skippedOld ? [`${result.skippedOld} message${result.skippedOld === 1 ? ' was' : 's were'} older than 14 days and skipped.`] : [];
                return {
                    changes: [{ key: `purge.${channel.id}`, old: null, new: { deleted: result.deleted, requested: amount, fromUserId, reason: reason || null } }],
                    message: `Deleted ${result.deleted} message${result.deleted === 1 ? '' : 's'} in #${channel.name}.`,
                    warnings,
                };
            },
        },
        lock: {
            admin: true,
            async run(ctx, form) {
                const channel = channelOf(ctx, form, 'Channel');
                const reason = text(form, 'reason', REASON_MAX);
                await ctx.services.lockChannel({ client: ctx.client, guild: ctx.guild, channel, moderator: moderatorOf(ctx), auditReason: auditReason(ctx.actor.username, reason) });
                return { changes: [{ key: `lock.${channel.id}`, old: false, new: true }], message: `#${channel.name} is locked.` };
            },
        },
        unlock: {
            admin: true,
            async run(ctx, form) {
                const channel = channelOf(ctx, form, 'Channel');
                const reason = text(form, 'reason', REASON_MAX);
                await ctx.services.unlockChannel({ client: ctx.client, guild: ctx.guild, channel, moderator: moderatorOf(ctx), auditReason: auditReason(ctx.actor.username, reason) });
                return { changes: [{ key: `lock.${channel.id}`, old: true, new: false }], message: `#${channel.name} is unlocked.` };
            },
        },
    },
};
