// giveaways.js — Giveaways: active and ended giveaways; End now / Reroll
// (Administrators only) through services/giveawayService.js, the functions /gend
// and /greroll use. New giveaways are created in Discord (/gcreate).

import { html, formatDate } from '../html.js';
import { InputError, buttonForm, channelName, isSnowflake, text } from '../forms.js';
import { section, table } from './common.js';

const isEnded = (g) => g.ended === true || g.isEnded === true;

function messageIdField(form) {
    const id = text(form, 'messageId', 25);
    if (!isSnowflake(id)) throw new InputError('Unknown giveaway.');
    return id;
}

export default {
    key: 'giveaways',
    label: 'Giveaways',
    help: 'Start giveaways with /gcreate in Discord. Ending early and rerolling need Administrator in the main server.',

    async load(ctx) {
        const list = await ctx.services.getGuildGiveaways(ctx.client, ctx.guildId);
        return { giveaways: Array.isArray(list) ? list : [] };
    },

    render(ctx, { giveaways }) {
        const g = ctx.guild;
        const can = ctx.canEdit && ctx.canAct;
        const active = giveaways.filter((x) => !isEnded(x)).sort((a, b) => Number(a.endTime || 0) - Number(b.endTime || 0));
        const ended = giveaways.filter(isEnded).sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || ''))).slice(0, 25);
        const activeRows = active.map((x) => [x.prize || '—', channelName(g, x.channelId), formatDate(x.endTime || x.endsAt), (x.participants || []).length,
            buttonForm(ctx, 'giveaways', 'end', 'End now', { messageId: x.messageId }, { canEdit: can })]);
        const endedRows = ended.map((x) => [x.prize || '—', channelName(g, x.channelId), formatDate(x.endedAt), (x.winnerIds || []).map((id) => html`<code>${id}</code> `),
            buttonForm(ctx, 'giveaways', 'reroll', 'Reroll', { messageId: x.messageId }, { canEdit: can, danger: false })]);
        return html`${ctx.canAct ? '' : html`<p class="muted">Ending and rerolling need Administrator in the main server.</p>`}
${section('Active', table(['Prize', 'Channel', 'Ends', 'Entries', ''], activeRows, 'No active giveaways.'))}
${section('Ended (latest 25)', table(['Prize', 'Channel', 'Ended', 'Winners', ''], endedRows, 'No ended giveaways.'))}`;
    },

    actions: {
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
    },
};
