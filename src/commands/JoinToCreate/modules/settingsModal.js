// settingsModal.js — /jointocreate config: change a trigger channel's name template, user
// limit or bitrate in a Discord modal (it used to wait for the next chat message).
//
// The modal is stateless: its custom ID carries what to change, the trigger channel and when
// the form expires (`jtcset:<kind>:<channelId>:<expiresAt base 36>`), so a submit is handled by
// the registered modal handler (interactions/modals/joinToCreate) even after a restart.
// On submit: ack first (deferReply, within 3 s), refuse an expired form, re-check Administrator
// (or OWNER_IDS), validate the field, then one locked read-modify-write of the config.

import {
    LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { hasOwnerPower } from '../../../utils/ownerPower.js';
import { getAdminRequiredMessage, hasAdministrator } from '../../../utils/commandGate.js';
import { mutateJoinToCreateConfig } from '../../../utils/database.js';
import { logger } from '../../../utils/logger.js';
import { botText, textForInteraction } from '../../../utils/botText.js';

export const MODAL_PREFIX = 'jtcset';
export const MODAL_TTL_MS = 10 * 60 * 1000;
export const TEMPLATE_MAX = 100;
export const LIMIT_MAX = 99;
export const BITRATE_MIN = 8;
export const BITRATE_MAX = 384;
const NO_PINGS = { parse: [] };

/** The three settings: select-menu value → modal kind. */
export const SETTING_KINDS = { name_template: 'name', user_limit: 'limit', bitrate: 'bitrate' };

// Texts: jointocreate.form.<kind>.* in the bot catalog (the admin's Discord language).
const KINDS = {
    name: {
        title: (tr) => tr.t('jointocreate.form.name.title'),
        label: (tr) => tr.t('jointocreate.form.name.label'),
        description: (tr) => tr.t('jointocreate.form.name.hint', {
            username: '{username}', display_name: '{display_name}', user_tag: '{user_tag}', guild_name: '{guild_name}',
        }),
        style: TextInputStyle.Short, min: 1, max: TEMPLATE_MAX,
    },
    limit: {
        title: (tr) => tr.t('jointocreate.form.limit.title'),
        label: (tr) => tr.t('jointocreate.form.limit.label'),
        description: (tr) => tr.t('jointocreate.form.limit.hint', { max: LIMIT_MAX }),
        style: TextInputStyle.Short, min: 1, max: 2,
    },
    bitrate: {
        title: (tr) => tr.t('jointocreate.form.bitrate.title'),
        label: (tr) => tr.t('jointocreate.form.bitrate.label'),
        description: (tr) => tr.t('jointocreate.form.bitrate.hint', { min: BITRATE_MIN, max: BITRATE_MAX }),
        style: TextInputStyle.Short, min: 1, max: 3,
    },
};

/** The custom ID of a settings modal (expires `ttlMs` from `now`). */
export function settingsModalId(kind, channelId, now = Date.now(), ttlMs = MODAL_TTL_MS) {
    return `${MODAL_PREFIX}:${kind}:${channelId}:${(now + ttlMs).toString(36)}`;
}

/** customId → { kind, channelId, expiresAt } or null when it is not one of ours. */
export function parseSettingsModalId(customId) {
    const [prefix, kind, channelId, expires] = String(customId || '').split(':');
    if (prefix !== MODAL_PREFIX || !Object.hasOwn(KINDS, kind) || !/^\d{17,20}$/.test(channelId || '') || !/^[0-9a-z]{1,12}$/.test(expires || '')) return null;
    return { kind, channelId, expiresAt: Number.parseInt(expires, 36) };
}

/** The current value shown in the field (so the admin edits it instead of retyping). */
function currentValue(kind, config, channelId) {
    const options = config?.channelOptions?.[channelId] || {};
    if (kind === 'name') return String(options.nameTemplate || config?.channelNameTemplate || '').slice(0, TEMPLATE_MAX);
    if (kind === 'limit') return String(options.userLimit ?? config?.userLimit ?? 0);
    const bitrate = options.bitrate || config?.bitrate || 64000;
    return String(Math.round(bitrate / 1000));
}

/** The modal for one setting of one trigger channel, prefilled with the current value. lang: the admin's. */
export function buildSettingsModal(kind, channelId, config, { now = Date.now(), lang = 'en' } = {}) {
    const spec = KINDS[kind];
    const tr = botText(lang);
    const input = new TextInputBuilder()
        .setCustomId('value')
        .setStyle(spec.style)
        .setRequired(true)
        .setMinLength(spec.min)
        .setMaxLength(spec.max);
    const value = currentValue(kind, config, channelId);
    if (value && value.length <= spec.max) input.setValue(value);
    const label = new LabelBuilder().setLabel(spec.label(tr)).setDescription(spec.description(tr)).setTextInputComponent(input);
    return new ModalBuilder().setCustomId(settingsModalId(kind, channelId, now)).setTitle(spec.title(tr)).addLabelComponents(label);
}

/**
 * The typed value → what is saved: { key, value, text } or { error }.
 * name: 1–100 characters, no line breaks; limit: 0–99; bitrate: 8–384 kbps (saved in bps).
 */
export function parseSettingValue(kind, raw, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const value = String(raw ?? '').trim();
    const limitError = () => tr.t('jointocreate.form.limit.error', { max: LIMIT_MAX });
    const bitrateError = () => tr.t('jointocreate.form.bitrate.error', { min: BITRATE_MIN, max: BITRATE_MAX });
    if (kind === 'name') {
        if (!value || value.length > TEMPLATE_MAX || /[\r\n]/.test(value)) return { error: tr.t('jointocreate.form.name.error', { max: TEMPLATE_MAX }) };
        return { key: 'nameTemplate', value, text: tr.t('jointocreate.form.name.changed', { template: value.replace(/`/g, "'") }) };
    }
    if (!/^\d{1,3}$/.test(value)) return { error: kind === 'limit' ? limitError() : bitrateError() };
    const number = Number(value);
    if (kind === 'limit') {
        if (number > LIMIT_MAX) return { error: limitError() };
        return { key: 'userLimit', value: number, text: number === 0 ? tr.t('jointocreate.form.limit.changedNone') : tr.tp('jointocreate.form.limit.changed', number) };
    }
    if (number < BITRATE_MIN || number > BITRATE_MAX) return { error: bitrateError() };
    return { key: 'bitrate', value: number * 1000, text: tr.t('jointocreate.form.bitrate.changed', { kbps: number }) };
}

/** May this user still change Join to Create? Administrator (or the server owner), or OWNER_IDS. */
export function canConfigure(interaction) {
    return hasOwnerPower(interaction.user?.id, interaction.guildId)
        || hasAdministrator({ guild: interaction.guild, userId: interaction.user?.id, permissions: interaction.memberPermissions });
}

/**
 * The modal submit (registered as the `jtcset` modal handler). `deps` are injectable for tests:
 * { mutate, now }.
 */
export async function handleSettingsModalSubmit(interaction, client, { mutate = mutateJoinToCreateConfig, now = Date.now() } = {}) {
    const parsed = parseSettingsModalId(interaction.customId);
    const tr = textForInteraction(interaction);
    const answer = (content) => interaction.editReply({ content, allowedMentions: NO_PINGS });
    // Ack first: everything below may wait for the database.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!parsed || !interaction.guild) return answer(tr.t('jointocreate.form.invalid'));
    if (parsed.expiresAt < now) return answer(tr.t('jointocreate.form.expired'));
    if (!canConfigure(interaction)) return answer(getAdminRequiredMessage(interaction.guildId, { lang: tr.lang }));
    const result = parseSettingValue(parsed.kind, interaction.fields.getTextInputValue('value'), { lang: tr.lang });
    if (result.error) return answer(tr.t('jointocreate.form.notChanged', { error: result.error }));
    try {
        const saved = await mutate(client, interaction.guild.id, (config) => {
            if (!config.triggerChannels.includes(parsed.channelId)) return false;
            config.channelOptions = config.channelOptions || {};
            config.channelOptions[parsed.channelId] = { ...config.channelOptions[parsed.channelId], [result.key]: result.value };
            return true;
        });
        if (!saved) return answer(tr.t('jointocreate.form.noLongerTrigger', { channelId: parsed.channelId }));
    } catch (error) {
        logger.error('Join to Create settings modal: save failed', { guildId: interaction.guild.id, kind: parsed.kind, error: error.message });
        return answer(tr.t('jointocreate.form.database'));
    }
    return answer(tr.t('jointocreate.form.saved', { text: result.text, channelId: parsed.channelId }));
}
