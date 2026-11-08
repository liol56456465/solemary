// joinToCreateService.js

import {
    getJoinToCreateConfig,
    saveJoinToCreateConfig,
    updateJoinToCreateConfig,
    getTemporaryChannelInfo,
    mutateJoinToCreateConfig
} from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../utils/errorHandler.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import { formatLogLine } from '../utils/logging/logEmbeds.js';
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { botText } from '../utils/botText.js';

/**
 * A refusal whose text lives in the bot catalog (jointocreate.service.*). userMessage is the
 * English text (the web dashboard shows it as before); a command answers in the user's language
 * with joinToCreateErrorText(error, tr).
 */
export class JtcError extends TitanBotError {
    constructor(message, type, key, context = {}, params = {}) {
        super(message, type, botText('en').t(key, params), context);
        this.i18n = { key, params };
    }
}

/** The text of a Join to Create error in `tr`'s language (its English userMessage otherwise). */
export function joinToCreateErrorText(error, tr, fallback = null) {
    if (error?.i18n && tr) return tr.t(error.i18n.key, error.i18n.params);
    return error?.userMessage || fallback;
}

const CHANNEL_NAME_MAX_LENGTH = 100;
const CHANNEL_VARIABLE_MAX_LENGTH = 32;
const CONTROL_AND_INVISIBLE_CHARS_REGEX = /[\x00-\x1F\x7F\u200B-\u200D\uFEFF]/g;
const ALLOWED_TEMPLATE_PLACEHOLDERS = new Set([
    '{username}',
    '{user_tag}',
    '{displayName}',
    '{display_name}',
    '{guildName}',
    '{guild_name}',
    '{channelName}',
    '{channel_name}'
]);

export function validateChannelNameTemplate(template) {
    if (!template || typeof template !== 'string') {
        throw new JtcError(
            'Invalid channel template: must be a non-empty string',
            ErrorTypes.VALIDATION,
            'jointocreate.service.templateText'
        );
    }

    const normalizedTemplate = template.normalize('NFKC').replace(CONTROL_AND_INVISIBLE_CHARS_REGEX, '').trim();

    if (normalizedTemplate.length > CHANNEL_NAME_MAX_LENGTH) {
        throw new JtcError(
            'Channel template exceeds maximum length',
            ErrorTypes.VALIDATION,
            'jointocreate.service.templateLength',
            {},
            { max: CHANNEL_NAME_MAX_LENGTH }
        );
    }

    if (/[@#:`]/.test(normalizedTemplate)) {
        throw new JtcError(
            'Channel template contains forbidden characters',
            ErrorTypes.VALIDATION,
            'jointocreate.service.templateChars'
        );
    }

    const placeholders = normalizedTemplate.match(/\{[^}]+\}/g) || [];
    for (const placeholder of placeholders) {
        if (!ALLOWED_TEMPLATE_PLACEHOLDERS.has(placeholder)) {
            throw new JtcError(
                'Channel template contains unknown placeholders',
                ErrorTypes.VALIDATION,
                'jointocreate.service.templatePlaceholder',
                {},
                { placeholder, allowed: Array.from(ALLOWED_TEMPLATE_PLACEHOLDERS).join(', ') }
            );
        }
    }

    return true;
}

export function validateBitrate(bitrate) {
    const bitrateNum = parseInt(bitrate);

    if (isNaN(bitrateNum)) {
        throw new JtcError(
            'Bitrate must be a valid number',
            ErrorTypes.VALIDATION,
            'jointocreate.service.bitrateNumber'
        );
    }

    if (bitrateNum < 8 || bitrateNum > 384) {
        throw new JtcError(
            'Bitrate out of valid range',
            ErrorTypes.VALIDATION,
            'jointocreate.service.bitrateRange'
        );
    }

    return true;
}

export function validateUserLimit(limit) {
    const limitNum = parseInt(limit);

    if (isNaN(limitNum)) {
        throw new JtcError(
            'User limit must be a valid number',
            ErrorTypes.VALIDATION,
            'jointocreate.service.limitNumber'
        );
    }

    if (limitNum < 0 || limitNum > 99) {
        throw new JtcError(
            'User limit out of valid range',
            ErrorTypes.VALIDATION,
            'jointocreate.service.limitRange'
        );
    }

    return true;
}

export function formatChannelName(template, variables) {
    try {
        const safeTemplate = template.normalize('NFKC').replace(CONTROL_AND_INVISIBLE_CHARS_REGEX, '').trim();
        validateChannelNameTemplate(safeTemplate);

        if (!variables || typeof variables !== 'object') {
            throw new TitanBotError(
                'Invalid variables object for channel formatting',
                ErrorTypes.VALIDATION
            );
        }

        const sanitized = {};
        for (const [key, value] of Object.entries(variables)) {
            if (value === null || value === undefined) {
                sanitized[key] = 'Unknown';
            } else {
                
                sanitized[key] = String(value)
                    .normalize('NFKC')
                    .replace(CONTROL_AND_INVISIBLE_CHARS_REGEX, '')
                    .replace(/[@#:`\n\r\t]/g, '') 
                    .trim()
                    .substring(0, CHANNEL_VARIABLE_MAX_LENGTH);
            }
        }

        const replacements = {
            '{username}': sanitized.username || 'User',
            '{user_tag}': sanitized.userTag || 'User#0000',
            '{displayName}': sanitized.displayName || 'User',
            '{display_name}': sanitized.displayName || 'User',
            '{guildName}': sanitized.guildName || 'Server',
            '{guild_name}': sanitized.guildName || 'Server',
            '{channelName}': sanitized.channelName || 'Voice Channel',
            '{channel_name}': sanitized.channelName || 'Voice Channel',
        };

        let formatted = safeTemplate;
        for (const [placeholder, value] of Object.entries(replacements)) {
            formatted = formatted.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
        }

        formatted = formatted
            .normalize('NFKC')
            .replace(CONTROL_AND_INVISIBLE_CHARS_REGEX, '')
            .replace(/[@#:`\n\r\t]/g, '') 
            .replace(/\s+/g, ' ')
            .trim();

        if (formatted.length === 0) {
            formatted = 'Voice Channel';
        } else if (formatted.length > CHANNEL_NAME_MAX_LENGTH) {
            formatted = formatted.substring(0, CHANNEL_NAME_MAX_LENGTH);
        }

        logger.debug(`Formatted channel name: "${formatted}" from template "${template}"`);
        return formatted;

    } catch (error) {
        logger.error('Error formatting channel name:', error);
        throw error;
    }
}

export async function initializeJoinToCreate(client, guildId, channelId, options = {}) {
    try {
        if (!client || !client.db) {
            throw new JtcError(
                'Database service not available',
                ErrorTypes.DATABASE,
                'jointocreate.service.systemError'
            );
        }

        if (!guildId || !channelId) {
            throw new JtcError(
                'Missing required guild or channel ID',
                ErrorTypes.VALIDATION,
                'jointocreate.service.invalidIds'
            );
        }

        if (options.nameTemplate) {
            validateChannelNameTemplate(options.nameTemplate);
        }
        if (options.bitrate) {
            validateBitrate(options.bitrate / 1000); 
        }
        if (options.userLimit !== undefined) {
            validateUserLimit(options.userLimit);
        }

        const config = await getJoinToCreateConfig(client, guildId);

        if (config.triggerChannels.includes(channelId)) {
            throw new JtcError(
                'Channel already configured as Join to Create trigger',
                ErrorTypes.VALIDATION,
                'jointocreate.service.alreadyTrigger'
            );
        }

        if (Array.isArray(config.triggerChannels) && config.triggerChannels.length > 0) {
            throw new JtcError(
                'Guild already has a Join to Create trigger configured',
                ErrorTypes.VALIDATION,
                'jointocreate.service.alreadyConfigured',
                {
                    guildId,
                    existingTriggerChannelId: config.triggerChannels[0],
                    expected: true,
                    suppressErrorLog: true
                }
            );
        }

        config.triggerChannels.push(channelId);
        config.enabled = true;

        if (Object.keys(options).length > 0) {
            if (!config.channelOptions) {
                config.channelOptions = {};
            }
            config.channelOptions[channelId] = {
                nameTemplate: options.nameTemplate || config.channelNameTemplate,
                userLimit: options.userLimit !== undefined ? options.userLimit : config.userLimit,
                bitrate: options.bitrate || config.bitrate,
                categoryId: options.categoryId || null,
                createdAt: Date.now()
            };
        }

        const saveResult = await saveJoinToCreateConfig(client, guildId, config);
        if (!saveResult) {
            throw new JtcError(
                'Failed to save Join to Create configuration',
                ErrorTypes.DATABASE,
                'jointocreate.service.saveFailed'
            );
        }

        logger.info(`Initialized Join to Create for guild ${guildId} with trigger channel ${channelId}`);

        return config;

    } catch (error) {
        if (error instanceof TitanBotError) {
            throw error;
        }
        throw new JtcError(
            `Failed to initialize Join to Create: ${error.message}`,
            ErrorTypes.DATABASE,
            'jointocreate.service.setupFailed'
        );
    }
}

export async function updateChannelConfig(client, guildId, channelId, updates) {
    try {
        if (!client || !client.db) {
            throw new JtcError(
                'Database service not available',
                ErrorTypes.DATABASE,
                'jointocreate.service.dbUnavailable'
            );
        }

        if (updates.nameTemplate) {
            validateChannelNameTemplate(updates.nameTemplate);
        }
        if (updates.bitrate !== undefined) {
            validateBitrate(updates.bitrate / 1000);
        }
        if (updates.userLimit !== undefined) {
            validateUserLimit(updates.userLimit);
        }

        // Locked read-modify-write (the web dashboard edits the same config).
        let saved = null;
        const found = await mutateJoinToCreateConfig(client, guildId, (config) => {
            if (!config.triggerChannels.includes(channelId)) return false;
            if (!config.channelOptions) config.channelOptions = {};
            config.channelOptions[channelId] = {
                ...config.channelOptions[channelId],
                ...updates,
                updatedAt: Date.now()
            };
            saved = config.channelOptions[channelId];
            return true;
        });
        if (!found) {
            throw new JtcError(
                'Channel is not configured as a Join to Create trigger',
                ErrorTypes.VALIDATION,
                'jointocreate.service.notTrigger'
            );
        }

        logger.info(`Updated Join to Create config for channel ${channelId} in guild ${guildId}`, {
            updates: Object.keys(updates)
        });

        return saved;

    } catch (error) {
        if (error instanceof TitanBotError) {
            throw error;
        }
        throw new JtcError(
            `Failed to update channel config: ${error.message}`,
            ErrorTypes.DATABASE,
            'jointocreate.service.updateFailed'
        );
    }
}

export async function removeTriggerChannel(client, guildId, channelId) {
    try {
        if (!client || !client.db) {
            throw new JtcError(
                'Database service not available',
                ErrorTypes.DATABASE,
                'jointocreate.service.dbUnavailable'
            );
        }

        // Locked read-modify-write (the web dashboard edits the same config).
        const found = await mutateJoinToCreateConfig(client, guildId, (config) => {
            const index = config.triggerChannels.indexOf(channelId);
            if (index === -1) return false;
            config.triggerChannels.splice(index, 1);
            config.enabled = config.triggerChannels.length > 0;
            if (config.channelOptions && config.channelOptions[channelId]) {
                delete config.channelOptions[channelId];
            }
            if (config.temporaryChannels) {
                for (const [tempChannelId, tempInfo] of Object.entries(config.temporaryChannels)) {
                    if (tempInfo.triggerChannelId === channelId) {
                        delete config.temporaryChannels[tempChannelId];
                    }
                }
            }
            return true;
        });
        if (!found) {
            throw new JtcError(
                'Channel not found in Join to Create triggers',
                ErrorTypes.VALIDATION,
                'jointocreate.service.notConfigured'
            );
        }

        logger.info(`Removed Join to Create trigger channel ${channelId} from guild ${guildId}`);

        return true;

    } catch (error) {
        if (error instanceof TitanBotError) {
            throw error;
        }
        throw new JtcError(
            `Failed to remove trigger channel: ${error.message}`,
            ErrorTypes.DATABASE,
            'jointocreate.service.removeFailed'
        );
    }
}

export async function getConfiguration(client, guildId) {
    try {
        if (!client || !client.db) {
            throw new JtcError(
                'Database service not available',
                ErrorTypes.DATABASE,
                'jointocreate.service.dbUnavailable'
            );
        }

        return await getJoinToCreateConfig(client, guildId);

    } catch (error) {
        if (error instanceof TitanBotError) {
            throw error;
        }
        throw new JtcError(
            `Failed to retrieve configuration: ${error.message}`,
            ErrorTypes.DATABASE,
            'jointocreate.service.readFailed'
        );
    }
}

export async function isTriggerChannel(client, guildId, channelId) {
    try {
        const config = await getConfiguration(client, guildId);
        return config.triggerChannels.includes(channelId);
    } catch (error) {
        logger.error(`Error checking if channel is trigger: ${error.message}`);
        return false;
    }
}

export async function getChannelConfiguration(client, guildId, channelId) {
    try {
        const config = await getConfiguration(client, guildId);

        if (!config.triggerChannels || !Array.isArray(config.triggerChannels) || !config.triggerChannels.includes(channelId)) {
            throw new JtcError(
                'Channel is not a valid Join to Create trigger',
                ErrorTypes.VALIDATION,
                'jointocreate.service.notTrigger'
            );
        }

        return {
            ...config,
            channelConfig: config.channelOptions?.[channelId] || {}
        };

    } catch (error) {
        if (error instanceof TitanBotError) {
            throw error;
        }
        throw new JtcError(
            `Failed to get channel configuration: ${error.message}`,
            ErrorTypes.DATABASE,
            'jointocreate.service.channelReadFailed'
        );
    }
}

export async function logConfigurationChange(client, guildId, userId, action, details) {
    try {
        await logEvent({
            client,
            guildId,
            eventType: EVENT_TYPES.COUNTER_CONFIG,
            data: {
                title: 'Join to Create Updated',
                lines: [
                    formatLogLine('Action', action),
                    formatLogLine('Details', typeof details === 'string' ? details : JSON.stringify(details)),
                ],
                userId,
            },
        });
    } catch (error) {
        logger.warn(`Failed to log Join to Create configuration change: ${error.message}`);
    }
}

/**
 * Sets up Join to Create (shared by /jointocreate setup and the web dashboard): one
 * trigger per server (stale triggers whose channel is gone are cleaned up first), the
 * options validated BEFORE the "Join to Create" voice channel is created, then the
 * config saved and the change logged. bitrateKbps is in kbps. Resolves
 * { channel, config }. Throws TitanBotError (userMessage) when refused.
 */
export async function setupJoinToCreate(client, guild, {
    categoryId = null, nameTemplate = "{username}'s Room", userLimit = 0, bitrateKbps = 64, actorId = null,
} = {}) {
    const guildId = guild.id;
    const existing = await getConfiguration(client, guildId);
    if (Array.isArray(existing.triggerChannels) && existing.triggerChannels.length > 0) {
        const active = [];
        for (const id of existing.triggerChannels) {
            const channel = await guild.channels.fetch(id).catch(() => null);
            if (channel) active.push(channel);
            else {
                logger.info(`Cleaning up stale JTC trigger ${id} from guild ${guildId}`);
                await removeTriggerChannel(client, guildId, id);
            }
        }
        if (active.length > 0) {
            throw new JtcError(
                'Guild already has a Join to Create channel',
                ErrorTypes.VALIDATION,
                'jointocreate.service.alreadySetUp',
                { guildId, activeTriggerCount: active.length, expected: true, suppressErrorLog: true },
                { channel: String(active[0]) }
            );
        }
    }

    // Validate before creating the trigger channel so bad input doesn't leave an orphaned channel.
    validateChannelNameTemplate(nameTemplate);
    validateUserLimit(userLimit);
    validateBitrate(bitrateKbps);
    const category = categoryId ? guild.channels.cache.get(categoryId) : null;
    if (categoryId && (!category || category.type !== ChannelType.GuildCategory)) {
        throw new JtcError('Not a category', ErrorTypes.VALIDATION, 'jointocreate.service.notCategory', { expected: true });
    }

    const channel = await guild.channels.create({
        // Kept as the feature's name in every language (the dashboard tells admins this exact name).
        name: 'Join to Create',
        type: ChannelType.GuildVoice,
        parent: category?.id,
        userLimit: 0,
        bitrate: 64000,
        // The category's overwrites (no @everyone allows): a private category stays private.
        permissionOverwrites: buildJoinToCreateOverwrites(category, {
            guildId: guild.id,
            botId: guild.members?.me?.id ?? client?.user?.id ?? null,
            botPermissions: guild.members?.me ? category?.permissionsFor?.(guild.members.me)?.bitfield ?? null : null,
        }),
    });

    let config;
    try {
        config = await initializeJoinToCreate(client, guildId, channel.id, {
            nameTemplate,
            userLimit,
            bitrate: bitrateKbps * 1000,
            categoryId: category?.id,
        });
    } catch (error) {
        await channel.delete('Join to Create setup failed').catch(() => null);
        throw error;
    }

    await logConfigurationChange(client, guildId, actorId, 'Initialized Join to Create', {
        channelId: channel.id, nameTemplate, userLimit, bitrate: bitrateKbps,
    });
    logger.info(`Created Join to Create system in guild ${guildId}`);
    return { channel, config };
}

/**
 * Permission overwrites for a Join to Create channel (the trigger or a temporary room): a copy of
 * `source`'s overwrites (the category, else the trigger channel), so a private category stays
 * private. Allows on @everyone are dropped (an old trigger carried "@everyone: View + Connect",
 * which would open a private category); its denies are kept. The bot (`botId`) gets what it
 * needs to move members and delete the room; the owner (`ownerId`) gets theirs on top.
 * Bits the bot does not have in `source` are left out of the copy (see `botPermissions`).
 */
export function buildJoinToCreateOverwrites(source, { guildId, ownerId = null, botId = null, botPermissions = null } = {}) {
    const entries = new Map();
    const cache = source?.permissionOverwrites?.cache;
    // Discord refuses overwrites with bits the bot itself lacks there (50013): copy only those
    // bits (`botPermissions`: the bot's permissions in `source`; null or Administrator = all).
    const mask = botPermissions == null || (BigInt(botPermissions) & PermissionFlagsBits.Administrator)
        ? ~0n
        : BigInt(botPermissions);
    if (cache) {
        for (const ow of cache.values()) {
            const allow = ow.id === guildId ? 0n : BigInt(ow.allow?.bitfield ?? 0n) & mask;
            const deny = BigInt(ow.deny?.bitfield ?? 0n) & mask;
            if (!allow && !deny) continue;
            entries.set(ow.id, { id: ow.id, type: ow.type, allow, deny });
        }
    }
    const addOnTop = (id, bits) => {
        if (!id) return;
        const mask = bits.reduce((acc, bit) => acc | bit, 0n);
        const prev = entries.get(id) ?? { id, type: OverwriteType.Member, allow: 0n, deny: 0n };
        entries.set(id, { id, type: prev.type, allow: prev.allow | mask, deny: prev.deny & ~mask });
    };
    addOnTop(botId, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ManageChannels]);
    addOnTop(ownerId, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.PrioritySpeaker, PermissionFlagsBits.MoveMembers]);
    return [...entries.values()];
}

export default {
    validateChannelNameTemplate,
    validateBitrate,
    validateUserLimit,
    formatChannelName,
    initializeJoinToCreate,
    updateChannelConfig,
    removeTriggerChannel,
    getConfiguration,
    isTriggerChannel,
    getChannelConfiguration,
    logConfigurationChange,
    buildJoinToCreateOverwrites
};