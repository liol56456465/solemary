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

export const MODAL_PREFIX = 'jtcset';
export const MODAL_TTL_MS = 10 * 60 * 1000;
export const TEMPLATE_MAX = 100;
export const LIMIT_MAX = 99;
export const BITRATE_MIN = 8;
export const BITRATE_MAX = 384;
const NO_PINGS = { parse: [] };

/** The three settings: select-menu value → modal kind. */
export const SETTING_KINDS = { name_template: 'name', user_limit: 'limit', bitrate: 'bitrate' };

const KINDS = {
    name: {
        title: 'Channel name template',
        label: 'New name template',
        description: 'Up to 100 characters. {username}, {display_name}, {user_tag} and {guild_name} are filled in.',
        style: TextInputStyle.Short, min: 1, max: TEMPLATE_MAX,
    },
    limit: {
        title: 'User limit',
        label: 'Members per temporary channel',
        description: `A whole number from 0 to ${LIMIT_MAX}. 0 means no limit.`,
        style: TextInputStyle.Short, min: 1, max: 2,
    },
    bitrate: {
        title: 'Bitrate',
        label: 'Audio quality in kbps',
        description: `A whole number from ${BITRATE_MIN} to ${BITRATE_MAX}. 64 is normal, 96 good, 128 high.`,
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

/** The modal for one setting of one trigger channel, prefilled with the current value. */
export function buildSettingsModal(kind, channelId, config, { now = Date.now() } = {}) {
    const spec = KINDS[kind];
    const input = new TextInputBuilder()
        .setCustomId('value')
        .setStyle(spec.style)
        .setRequired(true)
        .setMinLength(spec.min)
        .setMaxLength(spec.max);
    const value = currentValue(kind, config, channelId);
    if (value && value.length <= spec.max) input.setValue(value);
    const label = new LabelBuilder().setLabel(spec.label).setDescription(spec.description).setTextInputComponent(input);
    return new ModalBuilder().setCustomId(settingsModalId(kind, channelId, now)).setTitle(spec.title).addLabelComponents(label);
}

/**
 * The typed value → what is saved: { key, value, text } or { error }.
 * name: 1–100 characters, no line breaks; limit: 0–99; bitrate: 8–384 kbps (saved in bps).
 */
export function parseSettingValue(kind, raw) {
    const value = String(raw ?? '').trim();
    if (kind === 'name') {
        if (!value || value.length > TEMPLATE_MAX || /[\r\n]/.test(value)) return { error: `The name template must be 1 to ${TEMPLATE_MAX} characters on one line.` };
        return { key: 'nameTemplate', value, text: `Channel name template changed to \`${value.replace(/`/g, "'")}\`.` };
    }
    if (!/^\d{1,3}$/.test(value)) return { error: kind === 'limit' ? `The user limit must be a whole number from 0 to ${LIMIT_MAX}.` : `The bitrate must be a whole number from ${BITRATE_MIN} to ${BITRATE_MAX} kbps.` };
    const number = Number(value);
    if (kind === 'limit') {
        if (number > LIMIT_MAX) return { error: `The user limit must be a whole number from 0 to ${LIMIT_MAX}.` };
        return { key: 'userLimit', value: number, text: `User limit changed to ${number === 0 ? 'no limit' : `${number} members`}.` };
    }
    if (number < BITRATE_MIN || number > BITRATE_MAX) return { error: `The bitrate must be a whole number from ${BITRATE_MIN} to ${BITRATE_MAX} kbps.` };
    return { key: 'bitrate', value: number * 1000, text: `Bitrate changed to ${number} kbps.` };
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
    const answer = (content) => interaction.editReply({ content, allowedMentions: NO_PINGS });
    // Ack first: everything below may wait for the database.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!parsed || !interaction.guild) return answer('This form is not valid any more. Run /jointocreate config again.');
    if (parsed.expiresAt < now) return answer('This form expired. Run /jointocreate config again.');
    if (!canConfigure(interaction)) return answer(getAdminRequiredMessage());
    const result = parseSettingValue(parsed.kind, interaction.fields.getTextInputValue('value'));
    if (result.error) return answer(`${result.error} Nothing was changed.`);
    try {
        const saved = await mutate(client, interaction.guild.id, (config) => {
            if (!config.triggerChannels.includes(parsed.channelId)) return false;
            config.channelOptions = config.channelOptions || {};
            config.channelOptions[parsed.channelId] = { ...config.channelOptions[parsed.channelId], [result.key]: result.value };
            return true;
        });
        if (!saved) return answer(`<#${parsed.channelId}> is no longer a Join to Create channel. Nothing was changed.`);
    } catch (error) {
        logger.error('Join to Create settings modal: save failed', { guildId: interaction.guild.id, kind: parsed.kind, error: error.message });
        return answer('The database is not responding, so nothing was changed. Try again in a minute.');
    }
    return answer(`${result.text} New temporary channels of <#${parsed.channelId}> use it.`);
}
