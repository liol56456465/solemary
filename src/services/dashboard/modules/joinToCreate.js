// joinToCreate.js — Join to create: per trigger channel, the name template, user
// limit and bitrate of the temporary voice channels; remove a trigger. Writes go
// through joinToCreateService (validators + row-locked config), as /jointocreate does.
// New triggers: setupJoinToCreate (creates the voice channel; Administrators only).

import { html } from '../html.js';
import { InputError, PERMS, buttonForm, channelField, channelName, channelPicker, channelWarnings, intField, isSnowflake, numberInput, postForm, text, textInput } from '../forms.js';
import { section, table } from './common.js';
import { textFor } from '../language.js';
import { managerActions } from './serverScope.js';

// Words: src/content/dashboard/<lang>/joinToCreate.json. The default channel name ("{username}'s Room")
// is a value saved for Discord and stays as it is.

// The {tokens} of a channel name template, shown literally in the help text.
const NAME_TOKENS = { username: '{username}', displayName: '{displayName}', guildName: '{guildName}', channelName: '{channelName}' };

function triggerField(ctx, form) {
    const id = text(form, 'channelId', 25);
    if (!isSnowflake(id)) throw new InputError(textFor(ctx).t('joinToCreate.error.unknownTrigger'));
    return id;
}

export default {
    key: 'join-to-create',
    label: 'Join to create',
    state: 'joinToCreate',
    help: 'Members get their own voice channel when they need one. When someone joins the trigger channel, Mewvo makes a new voice channel for them and moves them into it. The channel is deleted again once it is empty.',

    async load(ctx) {
        return { config: await ctx.services.getJoinToCreateConfiguration(ctx.client, ctx.guildId) };
    },

    render(ctx, { config }) {
        const g = ctx.guild;
        const tr = textFor(ctx);
        const NAME_HELP = tr.t('joinToCreate.fields.nameHelp', NAME_TOKENS);
        const BITRATE_HELP = tr.t('joinToCreate.fields.bitrateHelp');
        const triggers = config.triggerChannels || [];
        const options = config.channelOptions || {};
        const rows = triggers.map((id) => {
            const o = options[id] || {};
            const warnings = channelWarnings(g, id, PERMS.voice);
            return [html`${channelName(g, id)}${warnings.map((w) => html`<br><span class="field-warn">${w}</span>`)}`,
                postForm(ctx, 'join-to-create', 'trigger', html`<div class="grid">
${textInput('nameTemplate', o.nameTemplate || config.channelNameTemplate || "{username}'s Room", { label: tr.t('joinToCreate.fields.name'), max: 100, help: NAME_HELP })}
${numberInput('userLimit', o.userLimit ?? config.userLimit ?? 0, { label: tr.t('joinToCreate.fields.userLimit'), min: 0, max: 99, help: tr.t('joinToCreate.fields.userLimitHelp') })}
${numberInput('bitrateKbps', Math.round((o.bitrate ?? config.bitrate ?? 64000) / 1000), { label: tr.t('joinToCreate.fields.bitrate'), min: 8, max: 384, help: BITRATE_HELP })}</div>`, { hidden: { channelId: id } }),
                buttonForm(ctx, 'join-to-create', 'trigger-remove', tr.t('joinToCreate.triggers.remove'), { channelId: id }, { confirm: tr.t('joinToCreate.triggers.removeConfirm') })];
        });
        const add = triggers.length
            ? html`<p class="muted">${tr.tx('joinToCreate.add.oneOnly')}</p>`
            : postForm(ctx, 'join-to-create', 'trigger-add', html`<div class="grid">
${channelPicker(g, 'categoryId', null, { label: tr.t('joinToCreate.fields.category'), kinds: ['category'], perms: PERMS.category, noneLabel: tr.t('joinToCreate.fields.categoryNone'), help: tr.t('joinToCreate.fields.categoryHelp') })}
${textInput('nameTemplate', "{username}'s Room", { label: tr.t('joinToCreate.fields.name'), max: 100, help: NAME_HELP })}
${numberInput('userLimit', 0, { label: tr.t('joinToCreate.fields.userLimit'), min: 0, max: 99, help: tr.t('joinToCreate.fields.userLimitHelp') })}
${numberInput('bitrateKbps', 64, { label: tr.t('joinToCreate.fields.bitrate'), min: 8, max: 384, help: BITRATE_HELP })}</div>`, { submit: tr.t('joinToCreate.add.submit'), canEdit: ctx.canEdit && ctx.canAct });
        return html`${section(tr.t('joinToCreate.status.title'), html`<p>${tr.tx('joinToCreate.status.text', { state: html`<span class="state ${config.enabled ? 'state-on' : 'state-off'}">${tr.t(config.enabled ? 'forms.pillOn' : 'forms.pillOff')}</span>` })}</p>`, '', { key: 'status' })}
${section(tr.t('joinToCreate.triggers.title'), table([tr.t('joinToCreate.triggers.channel'), tr.t('joinToCreate.triggers.temporary'), ''], rows, tr.t('joinToCreate.triggers.empty')), '', { key: 'triggers' })}
${section(tr.t('joinToCreate.add.title'), add, tr.t(ctx.canAct ? 'joinToCreate.add.help' : 'joinToCreate.add.helpNoAdmin'), { key: 'new-trigger', open: triggers.length === 0 })}`;
    },

    actions: managerActions(['trigger', 'trigger-remove'], {
        'trigger-add': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const categoryId = channelField(ctx.guild, form, 'categoryId', { kinds: ['category'], label: tr.t('joinToCreate.fields.category') });
                const nameTemplate = text(form, 'nameTemplate', 100);
                if (!nameTemplate) throw new InputError(tr.t('joinToCreate.error.nameEmpty'));
                const userLimit = intField(form, 'userLimit', { min: 0, max: 99, label: tr.t('joinToCreate.fields.userLimit') });
                const bitrateKbps = intField(form, 'bitrateKbps', { min: 8, max: 384, label: tr.t('joinToCreate.fields.bitrateShort') });
                const { channel } = await ctx.services.setupJoinToCreate(ctx.client, ctx.guild, { categoryId, nameTemplate, userLimit, bitrateKbps, actorId: ctx.actor.userId });
                return {
                    changes: [{ key: `trigger.${channel.id}`, old: null, new: { nameTemplate, userLimit, bitrate: bitrateKbps * 1000, categoryId } }],
                    message: tr.t('joinToCreate.action.created', { name: channel.name }),
                };
            },
        },
        async trigger(ctx, form) {
            const tr = textFor(ctx);
            const channelId = triggerField(ctx, form);
            const nameTemplate = text(form, 'nameTemplate', 100);
            if (!nameTemplate) throw new InputError(tr.t('joinToCreate.error.nameEmpty'));
            const userLimit = intField(form, 'userLimit', { min: 0, max: 99, label: tr.t('joinToCreate.fields.userLimit') });
            const bitrate = intField(form, 'bitrateKbps', { min: 8, max: 384, label: tr.t('joinToCreate.fields.bitrateShort') }) * 1000;
            const config = await ctx.services.getJoinToCreateConfiguration(ctx.client, ctx.guildId);
            const old = config.channelOptions?.[channelId] || {};
            const updates = {};
            if (nameTemplate !== (old.nameTemplate || config.channelNameTemplate)) updates.nameTemplate = nameTemplate;
            if (userLimit !== (old.userLimit ?? config.userLimit ?? 0)) updates.userLimit = userLimit;
            if (bitrate !== (old.bitrate ?? config.bitrate ?? 64000)) updates.bitrate = bitrate;
            if (!Object.keys(updates).length) return { changes: [], message: tr.t('errors.nothingChanged') };
            await ctx.services.updateChannelConfig(ctx.client, ctx.guildId, channelId, updates);
            return {
                changes: Object.entries(updates).map(([key, value]) => ({ key: `trigger.${channelId}.${key}`, old: old[key] ?? null, new: value })),
                message: tr.t('joinToCreate.action.saved'),
            };
        },
        async 'trigger-remove'(ctx, form) {
            const channelId = triggerField(ctx, form);
            await ctx.services.removeTriggerChannel(ctx.client, ctx.guildId, channelId);
            return {
                changes: [{ key: `trigger.${channelId}`, old: 'trigger', new: null }],
                message: textFor(ctx).t('joinToCreate.action.removed'),

            };
        },
    }),
};
