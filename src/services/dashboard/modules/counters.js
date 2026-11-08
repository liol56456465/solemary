// counters.js — Server stats counters (list, change type, delete) and the counting
// game (channel, number system, reset, off). Writes go through serverstatsService
// (row-locked list) and countingGameService, the functions /serverstats and /count use.
// New counters: createServerCounter (the bot creates the channel; Administrators only).
// Words: src/content/dashboard/<lang>/counters.json (counter type and number system names come
// from the services and stay as they are).

import { COUNTER_TYPE_CONFIG, getCounterTypeLabel } from '../../serverstatsService.js';
import { getCountingSystemChoices, getCountingSystemLabel } from '../../countingGameService.js';
import { html } from '../html.js';
import { InputError, PERMS, buttonForm, channelField, channelName, channelPicker, choiceField, postForm, selectInput, text } from '../forms.js';
import { currentText, textFor } from '../language.js';
import { section, table } from './common.js';
import { managerActions } from './serverScope.js';

const TYPES = Object.keys(COUNTER_TYPE_CONFIG);

function counterIdField(form) {
    const id = text(form, 'counterId', 64);
    if (!id) throw new InputError(currentText().t('counters.action.unknown'));
    return id;
}

export default {
    key: 'counters',
    label: 'Counters',
    help: 'Counters are channels whose name shows a live number, like "Members: 1234". Mewvo updates them every 15 minutes. The counting game is a channel where members count up together, one number per message.',

    async load(ctx) {
        const [counters, counting] = await Promise.all([
            ctx.services.getServerCounters(ctx.client, ctx.guildId),
            ctx.services.getCountingGameConfig(ctx.client, ctx.guildId),
        ]);
        return { counters, counting };
    },

    render(ctx, { counters, counting }) {
        const tr = textFor(ctx);
        const g = ctx.guild;
        const rows = counters.map((c) => [html`<code>${c.id}</code>`, channelName(g, c.channelId),
            postForm(ctx, 'counters', 'counter-type', selectInput('type', c.type, TYPES.map((t) => [t, getCounterTypeLabel(t)]), { label: '' }), { inline: true, submit: tr.t('counters.list.change'), hidden: { counterId: c.id } }),
            buttonForm(ctx, 'counters', 'counter-delete', tr.t('counters.list.delete'), { counterId: c.id }, { confirm: tr.t('counters.list.deleteConfirm') })]);
        const systems = getCountingSystemChoices().map((c) => [c.value, c.name]);
        const details = counting.enabled
            ? html` ${tr.tx('counters.counting.details', { channel: channelName(g, counting.channelId), system: getCountingSystemLabel(counting.system), next: tr.fmtNumber(counting.nextNumber || 1), best: tr.fmtNumber(counting.bestStreak || 0) })}`
            : '';
        const countingBody = html`<p>${tr.t('counters.counting.label')} <span class="state ${counting.enabled ? 'state-on' : 'state-off'}">${tr.t(counting.enabled ? 'forms.pillOn' : 'forms.pillOff')}</span>
${details}</p>
${postForm(ctx, 'counters', 'counting-setup', html`<div class="grid">${channelPicker(g, 'channelId', counting.channelId || null, { label: tr.t('counters.counting.channel'), perms: [...PERMS.post, 'ReadMessageHistory'], optional: false, help: tr.t('counters.counting.channelHelp') })}
${selectInput('system', counting.system || 'decimal', systems, { label: tr.t('counters.counting.system'), help: tr.t('counters.counting.systemHelp') })}</div>`, { submit: counting.enabled ? tr.t('counters.counting.restart') : tr.t('forms.turnOn') })}
${counting.enabled ? html`${buttonForm(ctx, 'counters', 'counting-reset', tr.t('counters.counting.reset'), {}, { confirm: tr.t('counters.counting.resetConfirm') })} ${buttonForm(ctx, 'counters', 'counting-off', tr.t('forms.turnOff'))}` : ''}`;
        const free = TYPES.filter((t) => !counters.some((c) => c.type === t));
        const create = free.length
            ? postForm(ctx, 'counters', 'counter-create', html`<div class="grid">
${selectInput('type', free[0], free.map((t) => [t, getCounterTypeLabel(t)]), { label: tr.t('counters.create.counts') })}
${selectInput('channelType', 'voice', [['voice', tr.t('counters.create.voice')], ['text', tr.t('counters.create.text')]], { label: tr.t('counters.create.channelType'), help: tr.t('counters.create.channelTypeHelp') })}
${channelPicker(g, 'categoryId', null, { label: tr.t('counters.create.category'), kinds: ['category'], perms: PERMS.category, optional: false, help: tr.t('counters.create.categoryHelp') })}</div>`,
            { submit: tr.t('counters.create.submit'), canEdit: ctx.canEdit && ctx.canAct })
            : html`<p class="muted">${tr.t('counters.create.allUsed')}</p>`;
        // Keys: the English titles' slugs.
        return html`${section(tr.t('counters.list.title'), html`${table([tr.t('counters.list.id'), tr.t('counters.list.channel'), tr.t('counters.list.type'), ''], rows, tr.t('counters.list.empty'))}
<h3>${tr.t('counters.create.title')}</h3>${create}`, tr.t(ctx.canAct ? 'counters.list.help' : 'counters.list.helpNoAdmin'), { key: 'server-stats-counters' })}
${section(tr.t('counters.counting.title'), countingBody, tr.t('counters.counting.help'), { key: 'counting-game' })}`;
    },

    actions: managerActions(['counter-type', 'counter-delete', 'counting-setup', 'counting-reset', 'counting-off'], {
        'counter-create': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const type = choiceField(form, 'type', TYPES, tr.t('counters.action.countsLabel'));
                const channelType = choiceField(form, 'channelType', ['voice', 'text'], tr.t('counters.action.channelKindLabel'));
                const categoryId = channelField(ctx.guild, form, 'categoryId', { kinds: ['category'], optional: false, label: tr.t('counters.create.category') });
                const { counter, channel, renamed } = await ctx.services.createServerCounter(ctx.client, ctx.guild, {
                    type, channelType, category: ctx.guild.channels.cache.get(categoryId), actorTag: `${ctx.actor.username} (dashboard)`,
                });
                const result = { changes: [{ key: `counter.${counter.id}`, old: null, new: { type, channelId: channel.id } }], message: tr.t('counters.action.created', { channel: `#${channel.name}` }) };
                if (!renamed) result.warnings = [tr.t('counters.action.renameLater')];
                return result;
            },
        },
        async 'counter-type'(ctx, form) {
            const tr = textFor(ctx);
            const counterId = counterIdField(form);
            const type = choiceField(form, 'type', TYPES, tr.t('counters.list.type'));
            const { counter, oldType, renamed } = await ctx.services.changeCounterType(ctx.client, ctx.guild, counterId, type);
            const result = { changes: oldType === counter.type ? [] : [{ key: `counter.${counterId}.type`, old: oldType, new: counter.type }], message: tr.t('counters.action.updated') };
            if (!renamed) result.warnings = [tr.t('counters.action.renameFailed')];
            return result;
        },
        async 'counter-delete'(ctx, form) {
            const tr = textFor(ctx);
            const counterId = counterIdField(form);
            const { counter, channel, channelDeleted } = await ctx.services.removeServerCounter(ctx.client, ctx.guild, counterId);
            const result = { changes: [{ key: `counter.${counterId}`, old: { type: counter.type, channelId: counter.channelId }, new: null }], message: tr.t('counters.action.deleted') };
            if (channel && !channelDeleted) result.warnings = [tr.t('counters.action.deleteFailed')];
            return result;
        },
        async 'counting-setup'(ctx, form) {
            const tr = textFor(ctx);
            const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: tr.t('counters.counting.channel') });
            const system = choiceField(form, 'system', getCountingSystemChoices().map((c) => c.value), tr.t('counters.counting.system'));
            const before = await ctx.services.getCountingGameConfig(ctx.client, ctx.guildId);
            await ctx.services.activateCountingGame(ctx.client, ctx.guildId, channelId, system);
            return {
                changes: [{ key: 'counting', old: { enabled: before.enabled, channelId: before.channelId || null, system: before.system }, new: { enabled: true, channelId, system } }],
                message: tr.t('counters.action.started'),
            };
        },
        async 'counting-reset'(ctx) {
            const before = await ctx.services.getCountingGameConfig(ctx.client, ctx.guildId);
            await ctx.services.resetCountingGame(ctx.client, ctx.guildId, 1);
            return { changes: [{ key: 'counting.nextNumber', old: before.nextNumber || 1, new: 1 }], message: textFor(ctx).t('counters.action.reset') };
        },
        async 'counting-off'(ctx) {
            const before = await ctx.services.getCountingGameConfig(ctx.client, ctx.guildId);
            await ctx.services.disableCountingGame(ctx.client, ctx.guildId);
            return { changes: before.enabled ? [{ key: 'counting.enabled', old: true, new: false }] : [], message: textFor(ctx).t('counters.action.off') };
        },
    }),
};
