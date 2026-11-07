// giveaways.js — Giveaways: start one, end now, reroll, delete (Administrators only)
// through services/giveawayService.js, the functions /giveaway create|end|reroll|delete use.
// "Pick a random member" is /tools randomuser (services/randomMemberService.js).

import { botConfig } from '../../../config/bot.js';
import { html, timeTag } from '../html.js';
import {
    InputError, PERMS, buttonForm, channelField, channelName, channelPicker, checkbox, intField, isSnowflake, numberInput, postForm, roleField,
    rolePicker, switchInput, text, textInput,
} from '../forms.js';
import { section, table } from './common.js';
import { textFor } from '../language.js';

// Words: src/content/dashboard/<lang>/giveaways.json (prizes and durations stay as typed).

const isEnded = (g) => g.ended === true || g.isEnded === true;
const MIN_WINNERS = botConfig.giveaways?.minimumWinners ?? 1;
const MAX_WINNERS = botConfig.giveaways?.maximumWinners ?? 10;

function messageIdField(form, tr) {
    const id = text(form, 'messageId', 25);
    if (!isSnowflake(id)) throw new InputError(tr.t('giveaways.error.unknown'));
    return id;
}

/** <time> with the UTC text; the static script shows it relative ("in 3 h"). */
function when(value) {
    if (!value) return '-';
    const date = new Date(Number.isFinite(Number(value)) ? Number(value) : value);
    if (Number.isNaN(date.getTime())) return '-';
    return timeTag(date);
}

export default {
    key: 'giveaways',
    label: 'Giveaways',
    help: 'Give away a prize to random members. Mewvo posts a giveaway message with a button, members press it to enter, and when time is up Mewvo picks the winners. Reroll picks new winners. Everything here needs the Administrator permission in this server.',

    async load(ctx) {
        const list = await ctx.services.getGuildGiveaways(ctx.client, ctx.guildId);
        return { giveaways: Array.isArray(list) ? list : [] };
    },

    render(ctx, { giveaways }) {
        const tr = textFor(ctx);
        const g = ctx.guild;
        const can = ctx.canEdit && ctx.canAct;
        const active = giveaways.filter((x) => !isEnded(x)).sort((a, b) => Number(a.endTime || 0) - Number(b.endTime || 0));
        const ended = giveaways.filter(isEnded).sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || ''))).slice(0, 25);
        const del = (x) => buttonForm(ctx, 'giveaways', 'delete', tr.t('giveaways.list.delete'), { messageId: x.messageId },
            { canEdit: can, confirm: tr.t('giveaways.list.deleteConfirm', { prize: x.prize || tr.t('giveaways.list.giveawayWord') }) });
        const activeRows = active.map((x) => [x.prize || '-', channelName(g, x.channelId), when(x.endTime || x.endsAt), tr.fmtNumber((x.participants || []).length), tr.fmtNumber(x.winnerCount ?? 1),
            html`<div class="row-actions">${buttonForm(ctx, 'giveaways', 'end', tr.t('giveaways.list.endNow'), { messageId: x.messageId }, { canEdit: can, danger: false, confirm: tr.t('giveaways.list.endConfirm') })}${del(x)}</div>`]);
        const endedRows = ended.map((x) => [x.prize || '-', channelName(g, x.channelId), when(x.endedAt), (x.winnerIds || []).map((id) => html`<code>${id}</code> `),
            html`<div class="row-actions">${buttonForm(ctx, 'giveaways', 'reroll', tr.t('giveaways.list.reroll'), { messageId: x.messageId }, { canEdit: can, danger: false })}${del(x)}</div>`]);
        const create = postForm(ctx, 'giveaways', 'create', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: tr.t('giveaways.create.channel'), perms: PERMS.post, optional: false, help: tr.t('giveaways.create.channelHelp') })}
${textInput('prize', '', { label: tr.t('giveaways.create.prize'), max: 256, help: tr.t('giveaways.create.prizeHelp') })}
${textInput('duration', '1d', { label: tr.t('giveaways.create.duration'), max: 10, placeholder: '30m, 12h, 3d', help: tr.t('giveaways.create.durationHelp') })}
${numberInput('winners', 1, { label: tr.t('giveaways.create.winners'), min: MIN_WINNERS, max: MAX_WINNERS, help: tr.t('giveaways.create.winnersHelp', { min: tr.fmtNumber(MIN_WINNERS), max: tr.fmtNumber(MAX_WINNERS) }) })}</div>`, { submit: tr.t('giveaways.create.submit'), canEdit: can });
        const random = postForm(ctx, 'giveaways', 'random-member', html`<div class="grid">
${rolePicker(g, 'roleId', null, { label: tr.t('giveaways.random.role'), assign: false, includeManaged: true, noneLabel: tr.t('giveaways.random.anyone') })}
${switchInput('includeBots', false, { label: tr.t('giveaways.random.bots'), help: tr.t('giveaways.random.botsHelp') })}
${switchInput('onlineOnly', false, { label: tr.t('giveaways.random.online'), help: tr.t('giveaways.random.onlineHelp') })}</div>`, { submit: tr.t('giveaways.random.submit'), canEdit: can });
        // Card keys: the English titles' slugs (stable ids in every language).
        return html`${ctx.canAct ? '' : html`<p class="muted">${tr.t('giveaways.needsAdmin')}</p>`}
${section(tr.t('giveaways.create.title'), create, tr.t('giveaways.create.help'), { key: 'start-a-giveaway', open: active.length === 0 })}
${section(tr.t('giveaways.active.title'), table([tr.t('giveaways.list.prize'), tr.t('giveaways.list.channel'), tr.t('giveaways.list.ends'), tr.t('giveaways.list.entries'), tr.t('giveaways.list.winners'), ''], activeRows, tr.t('giveaways.active.empty')), '', { key: 'active' })}
${section(tr.t('giveaways.random.title'), random, tr.t('giveaways.random.help'), { key: 'pick-a-random-member', open: false })}
${section(tr.t('giveaways.ended.title'), table([tr.t('giveaways.list.prize'), tr.t('giveaways.list.channel'), tr.t('giveaways.list.ended'), tr.t('giveaways.list.winners'), ''], endedRows, tr.t('giveaways.ended.empty')), '', { key: 'ended-latest-25', open: false })}`;
    },

    actions: {
        'random-member': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const roleId = roleField(ctx.guild, form, 'roleId', { label: tr.t('giveaways.random.roleLabel'), allowManaged: true });
                const filters = { roleId, includeBots: checkbox(form, 'includeBots'), onlineOnly: checkbox(form, 'onlineOnly') };
                const { member, poolSize } = await ctx.services.pickRandomMember(ctx.guild, filters);
                const name = member.user?.username || member.displayName || member.id;
                return {
                    changes: [{ key: 'randomMember', old: null, new: { userId: member.id, username: name, from: poolSize, ...filters } }],
                    message: tr.tp('giveaways.action.picked', poolSize, { name, id: member.id }),
                };
            },
        },
        create: {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: tr.t('giveaways.create.channel') });
                const duration = text(form, 'duration', 10);
                const winnerCount = intField(form, 'winners', { min: MIN_WINNERS, max: MAX_WINNERS, label: tr.t('giveaways.create.winners') });
                const { giveaway } = await ctx.services.createGiveaway(ctx.client, ctx.guild, {
                    channel: ctx.guild.channels.cache.get(channelId), duration, winnerCount, prize: text(form, 'prize', 300), hostId: ctx.actor.userId,
                });
                return {
                    changes: [{ key: `giveaway.${giveaway.messageId}`, old: null, new: { prize: giveaway.prize, channelId, winners: winnerCount, ends: new Date(giveaway.endTime).toISOString() } }],
                    message: tr.t('giveaways.action.started', { prize: giveaway.prize, duration }),
                };
            },
        },
        end: {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const messageId = messageIdField(form, tr);
                const result = await ctx.services.endGiveawayNow(ctx.client, ctx.guildId, messageId, ctx.actor.userId);
                return {
                    changes: [{ key: `giveaway.${messageId}`, old: { ended: false }, new: { ended: true, winners: result.winners } }],
                    message: tr.t('giveaways.action.ended', { winners: tr.fmtNumber(result.winners.length), entries: tr.fmtNumber(result.participantCount) }),
                };
            },
        },
        reroll: {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const messageId = messageIdField(form, tr);
                const before = (await ctx.services.getGuildGiveaways(ctx.client, ctx.guildId)).find((x) => x.messageId === messageId);
                const result = await ctx.services.rerollGiveaway(ctx.client, ctx.guildId, messageId, ctx.actor.userId);
                const rerolled = tr.t('giveaways.action.rerolled', { winners: tr.fmtNumber(result.winners.length) });
                return {
                    changes: [{ key: `giveaway.${messageId}.winners`, old: before?.winnerIds || [], new: result.winners }],
                    message: `${rerolled}${result.channelId ? '' : ` ${tr.t('giveaways.action.channelGone')}`}`,
                };
            },
        },
        delete: {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const messageId = messageIdField(form, tr);
                const { giveaway, deletedMessage } = await ctx.services.deleteGiveawayNow(ctx.client, ctx.guild, messageId, ctx.actor.userId);
                return {
                    changes: [{ key: `giveaway.${messageId}`, old: { prize: giveaway.prize, channelId: giveaway.channelId }, new: null }],
                    message: tr.t(deletedMessage ? 'giveaways.action.deletedWithMessage' : 'giveaways.action.deletedMessageGone', { prize: giveaway.prize }),
                };
            },
        },
    },
};
