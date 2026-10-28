// joinToCreate.js — Join to create: per trigger channel, the name template, user
// limit and bitrate of the temporary voice channels; remove a trigger. Writes go
// through joinToCreateService (validators + row-locked config), as /jointocreate does.
// New triggers: setupJoinToCreate (creates the voice channel; Administrators only).

import { html } from '../html.js';
import { InputError, PERMS, buttonForm, channelField, channelName, channelPicker, channelWarnings, intField, isSnowflake, numberInput, postForm, text, textInput } from '../forms.js';
import { section, table } from './common.js';

function triggerField(form) {
    const id = text(form, 'channelId', 25);
    if (!isSnowflake(id)) throw new InputError('Unknown trigger channel.');
    return id;
}

export default {
    key: 'join-to-create',
    label: 'Join to create',
    state: 'joinToCreate',
    help: 'Joining a trigger voice channel creates a temporary voice channel for the member. Name placeholders: {username}, {displayName}, {guildName}, {channelName}.',

    async load(ctx) {
        return { config: await ctx.services.getJoinToCreateConfiguration(ctx.client, ctx.guildId) };
    },

    render(ctx, { config }) {
        const g = ctx.guild;
        const triggers = config.triggerChannels || [];
        const options = config.channelOptions || {};
        const rows = triggers.map((id) => {
            const o = options[id] || {};
            const warnings = channelWarnings(g, id, PERMS.voice);
            return [html`${channelName(g, id)}${warnings.map((w) => html`<br><span class="field-warn">${w}</span>`)}`,
                postForm(ctx, 'join-to-create', 'trigger', html`<div class="grid">
${textInput('nameTemplate', o.nameTemplate || config.channelNameTemplate || "{username}'s Room", { label: 'Name template', max: 100 })}
${numberInput('userLimit', o.userLimit ?? config.userLimit ?? 0, { label: 'User limit (0 = none)', min: 0, max: 99 })}
${numberInput('bitrateKbps', Math.round((o.bitrate ?? config.bitrate ?? 64000) / 1000), { label: 'Bitrate (kbps)', min: 8, max: 384 })}</div>`, { hidden: { channelId: id } }),
                buttonForm(ctx, 'join-to-create', 'trigger-remove', 'Remove trigger', { channelId: id }, { confirm: 'Stop using this channel as a trigger? The channel itself is kept.' })];
        });
        const add = triggers.length
            ? html`<p class="muted">One trigger per server: remove the current one to create a new one.</p>`
            : postForm(ctx, 'join-to-create', 'trigger-add', html`<div class="grid">
${channelPicker(g, 'categoryId', null, { label: 'Category', kinds: ['category'], perms: PERMS.category, noneLabel: 'no category' })}
${textInput('nameTemplate', "{username}'s Room", { label: 'Name template', max: 100 })}
${numberInput('userLimit', 0, { label: 'User limit (0 = none)', min: 0, max: 99 })}
${numberInput('bitrateKbps', 64, { label: 'Bitrate (kbps)', min: 8, max: 384 })}</div>`, { submit: 'Create trigger channel', canEdit: ctx.canEdit && ctx.canAct });
        return html`${section('Status', html`<p>Join to create is <span class="state ${config.enabled ? 'state-on' : 'state-off'}">${config.enabled ? 'on' : 'off'}</span> (on while at least one trigger exists).</p>`)}
${section('Triggers', table(['Trigger channel', 'Temporary channels', ''], rows, 'No triggers yet.'))}
${section('New trigger', add, `Same as /jointocreate setup: the bot creates a "Join to Create" voice channel.${ctx.canAct ? '' : ' Needs Administrator in the main server.'}`, { open: triggers.length === 0 })}`;
    },

    actions: {
        'trigger-add': {
            admin: true,
            async run(ctx, form) {
                const categoryId = channelField(ctx.guild, form, 'categoryId', { kinds: ['category'], label: 'Category' });
                const nameTemplate = text(form, 'nameTemplate', 100);
                if (!nameTemplate) throw new InputError('Name template cannot be empty.');
                const userLimit = intField(form, 'userLimit', { min: 0, max: 99, label: 'User limit' });
                const bitrateKbps = intField(form, 'bitrateKbps', { min: 8, max: 384, label: 'Bitrate' });
                const { channel } = await ctx.services.setupJoinToCreate(ctx.client, ctx.guild, { categoryId, nameTemplate, userLimit, bitrateKbps, actorId: ctx.actor.userId });
                return {
                    changes: [{ key: `trigger.${channel.id}`, old: null, new: { nameTemplate, userLimit, bitrate: bitrateKbps * 1000, categoryId } }],
                    message: `Trigger channel "${channel.name}" created.`,
                };
            },
        },
        async trigger(ctx, form) {
            const channelId = triggerField(form);
            const nameTemplate = text(form, 'nameTemplate', 100);
            if (!nameTemplate) throw new InputError('Name template cannot be empty.');
            const userLimit = intField(form, 'userLimit', { min: 0, max: 99, label: 'User limit' });
            const bitrate = intField(form, 'bitrateKbps', { min: 8, max: 384, label: 'Bitrate' }) * 1000;
            const config = await ctx.services.getJoinToCreateConfiguration(ctx.client, ctx.guildId);
            const old = config.channelOptions?.[channelId] || {};
            const updates = {};
            if (nameTemplate !== (old.nameTemplate || config.channelNameTemplate)) updates.nameTemplate = nameTemplate;
            if (userLimit !== (old.userLimit ?? config.userLimit ?? 0)) updates.userLimit = userLimit;
            if (bitrate !== (old.bitrate ?? config.bitrate ?? 64000)) updates.bitrate = bitrate;
            if (!Object.keys(updates).length) return { changes: [], message: 'Nothing changed.' };
            await ctx.services.updateChannelConfig(ctx.client, ctx.guildId, channelId, updates);
            return {
                changes: Object.entries(updates).map(([key, value]) => ({ key: `trigger.${channelId}.${key}`, old: old[key] ?? null, new: value })),
                message: 'Trigger settings saved.',
            };
        },
        async 'trigger-remove'(ctx, form) {
            const channelId = triggerField(form);
            await ctx.services.removeTriggerChannel(ctx.client, ctx.guildId, channelId);
            return {
                changes: [{ key: `trigger.${channelId}`, old: 'trigger', new: null }],
                message: 'Trigger removed (the voice channel itself is kept).',
            };
        },
    },
};
