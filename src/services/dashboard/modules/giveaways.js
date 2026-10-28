// giveaways.js — Giveaways: start one, end now, reroll, delete (Administrators only)
// through services/giveawayService.js, the functions /giveaway create|end|reroll|delete use.
// "Pick a random member" is /tools randomuser (services/randomMemberService.js).

import { botConfig } from '../../../config/bot.js';
import { html, formatDate } from '../html.js';
import {
    InputError, PERMS, buttonForm, channelField, channelName, channelPicker, checkbox, intField, isSnowflake, numberInput, postForm, roleField,
    rolePicker, switchInput, text, textInput,
} from '../forms.js';
import { section, table } from './common.js';

const isEnded = (g) => g.ended === true || g.isEnded === true;
const MIN_WINNERS = botConfig.giveaways?.minimumWinners ?? 1;
const MAX_WINNERS = botConfig.giveaways?.maximumWinners ?? 10;

function messageIdField(form) {
    const id = text(form, 'messageId', 25);
    if (!isSnowflake(id)) throw new InputError('Unknown giveaway.');
    return id;
}

/** <time> with the UTC text; the static script shows it relative ("in 3 h"). */
function when(value) {
    if (!value) return '—';
    const date = new Date(Number.isFinite(Number(value)) ? Number(value) : value);
    if (Number.isNaN(date.getTime())) return '—';
    return html`<time datetime="${date.toISOString()}" data-relative>${formatDate(date)}</time>`;
}

export default {
    key: 'giveaways',
    label: 'Giveaways',
    help: 'Start, end, reroll and delete giveaways. Members enter with the button under the giveaway message. Everything here needs Administrator in the main server.',

    async load(ctx) {
        const list = await ctx.services.getGuildGiveaways(ctx.client, ctx.guildId);
        return { giveaways: Array.isArray(list) ? list : [] };
    },

    render(ctx, { giveaways }) {
        const g = ctx.guild;
        const can = ctx.canEdit && ctx.canAct;
        const active = giveaways.filter((x) => !isEnded(x)).sort((a, b) => Number(a.endTime || 0) - Number(b.endTime || 0));
        const ended = giveaways.filter(isEnded).sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || ''))).slice(0, 25);
        const del = (x) => buttonForm(ctx, 'giveaways', 'delete', 'Delete', { messageId: x.messageId }, { canEdit: can, confirm: `Delete the "${x.prize || 'giveaway'}" giveaway and its message?` });
        const activeRows = active.map((x) => [x.prize || '—', channelName(g, x.channelId), when(x.endTime || x.endsAt), (x.participants || []).length, x.winnerCount ?? 1,
            html`<div class="row-actions">${buttonForm(ctx, 'giveaways', 'end', 'End now', { messageId: x.messageId }, { canEdit: can, danger: false, confirm: 'End this giveaway now and pick the winners?' })}${del(x)}</div>`]);
        const endedRows = ended.map((x) => [x.prize || '—', channelName(g, x.channelId), when(x.endedAt), (x.winnerIds || []).map((id) => html`<code>${id}</code> `),
            html`<div class="row-actions">${buttonForm(ctx, 'giveaways', 'reroll', 'Reroll', { messageId: x.messageId }, { canEdit: can, danger: false })}${del(x)}</div>`]);
        const create = postForm(ctx, 'giveaways', 'create', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: 'Channel', perms: PERMS.post, optional: false })}
${textInput('prize', '', { label: 'Prize', max: 256 })}
${textInput('duration', '1d', { label: 'Duration', max: 10, placeholder: '30m, 12h, 3d', help: 'A number and s, m, h or d (10 s to 30 days).' })}
${numberInput('winners', 1, { label: `Winners (${MIN_WINNERS}–${MAX_WINNERS})`, min: MIN_WINNERS, max: MAX_WINNERS })}</div>`, { submit: 'Start giveaway', canEdit: can });
        const random = postForm(ctx, 'giveaways', 'random-member', html`<div class="grid">
${rolePicker(g, 'roleId', null, { label: 'Only members with this role', assign: false, includeManaged: true, noneLabel: 'anyone' })}
${switchInput('includeBots', false, { label: 'Include bots' })}
${switchInput('onlineOnly', false, { label: 'Only online members' })}</div>`, { submit: 'Pick a member', canEdit: can });
        return html`${ctx.canAct ? '' : html`<p class="muted">Giveaways need Administrator in the main server.</p>`}
${section('Start a giveaway', create, 'Same as /giveaway create: the bot posts the giveaway message in the channel.', { open: active.length === 0 })}
${section('Active', table(['Prize', 'Channel', 'Ends', 'Entries', 'Winners', ''], activeRows, 'No active giveaways.'))}
${section('Pick a random member', random, 'Same as /tools randomuser. The pick is shown at the top of this page and kept in the audit log; nothing is posted in Discord.', { open: false })}
${section('Ended (latest 25)', table(['Prize', 'Channel', 'Ended', 'Winners', ''], endedRows, 'No ended giveaways.'), '', { open: false })}`;
    },

    actions: {
        'random-member': {
            admin: true,
            async run(ctx, form) {
                const roleId = roleField(ctx.guild, form, 'roleId', { label: 'Role', allowManaged: true });
                const filters = { roleId, includeBots: checkbox(form, 'includeBots'), onlineOnly: checkbox(form, 'onlineOnly') };
                const { member, poolSize } = await ctx.services.pickRandomMember(ctx.guild, filters);
                const name = member.user?.username || member.displayName || member.id;
                return {
                    changes: [{ key: 'randomMember', old: null, new: { userId: member.id, username: name, from: poolSize, ...filters } }],
                    message: `Picked @${name} (${member.id}) from ${poolSize} matching member${poolSize === 1 ? '' : 's'}.`,
                };
            },
        },
        create: {
            admin: true,
            async run(ctx, form) {
                const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: 'Channel' });
                const duration = text(form, 'duration', 10);
                const winnerCount = intField(form, 'winners', { min: MIN_WINNERS, max: MAX_WINNERS, label: 'Winners' });
                const { giveaway } = await ctx.services.createGiveaway(ctx.client, ctx.guild, {
                    channel: ctx.guild.channels.cache.get(channelId), duration, winnerCount, prize: text(form, 'prize', 300), hostId: ctx.actor.userId,
                });
                return {
                    changes: [{ key: `giveaway.${giveaway.messageId}`, old: null, new: { prize: giveaway.prize, channelId, winners: winnerCount, ends: new Date(giveaway.endTime).toISOString() } }],
                    message: `Giveaway for "${giveaway.prize}" started; it ends in ${duration}.`,
                };
            },
        },
        end: {
            admin: true,
            async run(ctx, form) {
                const messageId = messageIdField(form);
                const result = await ctx.services.endGiveawayNow(ctx.client, ctx.guildId, messageId, ctx.actor.userId);
                return {
                    changes: [{ key: `giveaway.${messageId}`, old: { ended: false }, new: { ended: true, winners: result.winners } }],
                    message: `Giveaway ended: ${result.winners.length} winner(s) from ${result.participantCount} entries.`,
                };
            },
        },
        reroll: {
            admin: true,
            async run(ctx, form) {
                const messageId = messageIdField(form);
                const before = (await ctx.services.getGuildGiveaways(ctx.client, ctx.guildId)).find((x) => x.messageId === messageId);
                const result = await ctx.services.rerollGiveaway(ctx.client, ctx.guildId, messageId, ctx.actor.userId);
                return {
                    changes: [{ key: `giveaway.${messageId}.winners`, old: before?.winnerIds || [], new: result.winners }],
                    message: `Rerolled: ${result.winners.length} new winner(s).${result.channelId ? '' : ' The channel is gone, so nothing was announced.'}`,
                };
            },
        },
        delete: {
            admin: true,
            async run(ctx, form) {
                const messageId = messageIdField(form);
                const { giveaway, deletedMessage } = await ctx.services.deleteGiveawayNow(ctx.client, ctx.guild, messageId, ctx.actor.userId);
                return {
                    changes: [{ key: `giveaway.${messageId}`, old: { prize: giveaway.prize, channelId: giveaway.channelId }, new: null }],
                    message: `Giveaway "${giveaway.prize}" deleted${deletedMessage ? ' with its message' : ' (its message was already gone)'}.`,
                };
            },
        },
    },
};
