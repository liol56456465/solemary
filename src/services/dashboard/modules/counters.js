// counters.js — Server stats counters (list, change type, delete) and the counting
// game (channel, number system, reset, off). Writes go through serverstatsService
// (row-locked list) and countingGameService, the functions /serverstats and /count use.
// New counters: createServerCounter (the bot creates the channel; Administrators only).

import { COUNTER_TYPE_CONFIG, getCounterTypeLabel } from '../../serverstatsService.js';
import { getCountingSystemChoices, getCountingSystemLabel } from '../../countingGameService.js';
import { html } from '../html.js';
import { InputError, PERMS, buttonForm, channelField, channelName, channelPicker, choiceField, postForm, selectInput, text } from '../forms.js';
import { section, table } from './common.js';

const TYPES = Object.keys(COUNTER_TYPE_CONFIG);

function counterIdField(form) {
    const id = text(form, 'counterId', 64);
    if (!id) throw new InputError('Unknown counter.');
    return id;
}

export default {
    key: 'counters',
    label: 'Counters',
    help: 'Channel-name counters (members, bots) updated every 15 minutes, and the counting game.',

    async load(ctx) {
        const [counters, counting] = await Promise.all([
            ctx.services.getServerCounters(ctx.client, ctx.guildId),
            ctx.services.getCountingGameConfig(ctx.client, ctx.guildId),
        ]);
        return { counters, counting };
    },

    render(ctx, { counters, counting }) {
        const g = ctx.guild;
        const rows = counters.map((c) => [html`<code>${c.id}</code>`, channelName(g, c.channelId),
            postForm(ctx, 'counters', 'counter-type', selectInput('type', c.type, TYPES.map((t) => [t, getCounterTypeLabel(t)]), { label: '' }), { inline: true, submit: 'Change', hidden: { counterId: c.id } }),
            buttonForm(ctx, 'counters', 'counter-delete', 'Delete (and its channel)', { counterId: c.id }, { confirm: 'Delete this counter and its channel?' })]);
        const systems = getCountingSystemChoices().map((c) => [c.value, c.name]);
        const countingBody = html`<p>Counting game: <span class="state ${counting.enabled ? 'state-on' : 'state-off'}">${counting.enabled ? 'on' : 'off'}</span>
${counting.enabled ? html` in ${channelName(g, counting.channelId)} · ${getCountingSystemLabel(counting.system)} · next number ${counting.nextNumber || 1} · best streak ${counting.bestStreak || 0}` : ''}</p>
${postForm(ctx, 'counters', 'counting-setup', html`<div class="grid">${channelPicker(g, 'channelId', counting.channelId || null, { label: 'Counting channel', perms: [...PERMS.post, 'ReadMessageHistory'], optional: false })}
${selectInput('system', counting.system || 'decimal', systems, { label: 'Number system' })}</div>`, { submit: counting.enabled ? 'Restart in this channel (resets the count)' : 'Turn on' })}
${counting.enabled ? html`${buttonForm(ctx, 'counters', 'counting-reset', 'Reset the count to 1', {}, { confirm: 'Reset the counting game to 1?' })} ${buttonForm(ctx, 'counters', 'counting-off', 'Turn off')}` : ''}`;
        const free = TYPES.filter((t) => !counters.some((c) => c.type === t));
        const create = free.length
            ? postForm(ctx, 'counters', 'counter-create', html`<div class="grid">
${selectInput('type', free[0], free.map((t) => [t, getCounterTypeLabel(t)]), { label: 'Counts' })}
${selectInput('channelType', 'voice', [['voice', 'Voice channel (read-only name)'], ['text', 'Text channel']], { label: 'Channel kind' })}
${channelPicker(g, 'categoryId', null, { label: 'In category', kinds: ['category'], perms: PERMS.category, optional: false })}</div>`,
            { submit: 'Create counter', canEdit: ctx.canEdit && ctx.canAct })
            : html`<p class="muted">Every counter type is in use (one counter per type).</p>`;
        return html`${section('Server stats counters', html`${table(['ID', 'Channel', 'Type', ''], rows, 'No counters yet.')}
<h3>New counter</h3>${create}`, `Same as /serverstats create: the bot creates the channel.${ctx.canAct ? '' : ' Creating channels needs Administrator in the main server.'}`)}
${section('Counting game', countingBody, 'Same as /count setup: (re)starting resets the count and the leaderboard.')}`;
    },

    actions: {
        'counter-create': {
            admin: true,
            async run(ctx, form) {
                const type = choiceField(form, 'type', TYPES, 'Counts');
                const channelType = choiceField(form, 'channelType', ['voice', 'text'], 'Channel kind');
                const categoryId = channelField(ctx.guild, form, 'categoryId', { kinds: ['category'], optional: false, label: 'Category' });
                const { counter, channel, renamed } = await ctx.services.createServerCounter(ctx.client, ctx.guild, {
                    type, channelType, category: ctx.guild.channels.cache.get(categoryId), actorTag: `${ctx.actor.username} (dashboard)`,
                });
                const result = { changes: [{ key: `counter.${counter.id}`, old: null, new: { type, channelId: channel.id } }], message: `Counter created: #${channel.name}.` };
                if (!renamed) result.warnings = ['The channel name updates on the next scheduled run.'];
                return result;
            },
        },
        async 'counter-type'(ctx, form) {
            const counterId = counterIdField(form);
            const type = choiceField(form, 'type', TYPES, 'Type');
            const { counter, oldType, renamed } = await ctx.services.changeCounterType(ctx.client, ctx.guild, counterId, type);
            const result = { changes: oldType === counter.type ? [] : [{ key: `counter.${counterId}.type`, old: oldType, new: counter.type }], message: 'Counter updated.' };
            if (!renamed) result.warnings = ['The channel could not be renamed now; it updates on the next scheduled run.'];
            return result;
        },
        async 'counter-delete'(ctx, form) {
            const counterId = counterIdField(form);
            const { counter, channel, channelDeleted } = await ctx.services.removeServerCounter(ctx.client, ctx.guild, counterId);
            const result = { changes: [{ key: `counter.${counterId}`, old: { type: counter.type, channelId: counter.channelId }, new: null }], message: 'Counter deleted.' };
            if (channel && !channelDeleted) result.warnings = ['The counter channel could not be deleted (permissions?).'];
            return result;
        },
        async 'counting-setup'(ctx, form) {
            const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: 'Counting channel' });
            const system = choiceField(form, 'system', getCountingSystemChoices().map((c) => c.value), 'Number system');
            const before = await ctx.services.getCountingGameConfig(ctx.client, ctx.guildId);
            await ctx.services.activateCountingGame(ctx.client, ctx.guildId, channelId, system);
            return {
                changes: [{ key: 'counting', old: { enabled: before.enabled, channelId: before.channelId || null, system: before.system }, new: { enabled: true, channelId, system } }],
                message: 'Counting game started at 1.',
            };
        },
        async 'counting-reset'(ctx) {
            const before = await ctx.services.getCountingGameConfig(ctx.client, ctx.guildId);
            await ctx.services.resetCountingGame(ctx.client, ctx.guildId, 1);
            return { changes: [{ key: 'counting.nextNumber', old: before.nextNumber || 1, new: 1 }], message: 'The count starts again at 1.' };
        },
        async 'counting-off'(ctx) {
            const before = await ctx.services.getCountingGameConfig(ctx.client, ctx.guildId);
            await ctx.services.disableCountingGame(ctx.client, ctx.guildId);
            return { changes: before.enabled ? [{ key: 'counting.enabled', old: true, new: false }] : [], message: 'Counting game is off.' };
        },
    },
};
