// reactionRoleService.js

import { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { getReactionRoleKey, getReactionRolesPrefix } from '../utils/database/keys.js';
import { getDangerousPermissions, hasDangerousPermissions } from '../utils/roleSafety.js';

// Re-exported for reactroles.js, which imports it from here.
export { hasDangerousPermissions };

const MAX_ROLES_PER_MESSAGE = 25;


function validateGuildId(guildId) {
    if (!guildId || typeof guildId !== 'string' || !/^\d{17,19}$/.test(guildId)) {
        throw createError(
            `Invalid guild ID: ${guildId}`,
            ErrorTypes.VALIDATION,
            'Invalid server ID provided.',
            { guildId }
        );
    }
}

function validateMessageId(messageId) {
    if (!messageId || typeof messageId !== 'string' || !/^\d{17,19}$/.test(messageId)) {
        throw createError(
            `Invalid message ID: ${messageId}`,
            ErrorTypes.VALIDATION,
            'Invalid message ID provided.',
            { messageId }
        );
    }
}

function validateRoleId(roleId) {
    if (!roleId || typeof roleId !== 'string' || !/^\d{17,19}$/.test(roleId)) {
        throw createError(
            `Invalid role ID: ${roleId}`,
            ErrorTypes.VALIDATION,
            'Invalid role ID provided.',
            { roleId }
        );
    }
}

async function validateRoleSafety(client, guildId, roleId) {
    const guild = client.guilds?.cache?.get(guildId) || await client.guilds?.fetch?.(guildId).catch(() => null);
    if (!guild) {
        throw createError(
            `Guild not found for role validation: ${guildId}`,
            ErrorTypes.VALIDATION,
            'Server not found while validating reaction roles.',
            { guildId, roleId }
        );
    }

    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
        throw createError(
            `Role not found: ${roleId}`,
            ErrorTypes.VALIDATION,
            'One or more selected roles no longer exist.',
            { guildId, roleId }
        );
    }

    if (hasDangerousPermissions(role)) {
        throw createError(
            `Dangerous role permission detected: ${roleId}`,
            ErrorTypes.PERMISSION,
            'For security reasons, high-privilege roles cannot be assigned through reaction roles.',
            { guildId, roleId, roleName: role.name, dangerousPermissions: getDangerousPermissions(role) }
        );
    }

    const botHighestRole = guild.members.me?.roles?.highest;
    if (!botHighestRole || role.position >= botHighestRole.position) {
        throw createError(
            `Role above bot hierarchy: ${roleId}`,
            ErrorTypes.PERMISSION,
            'I cannot assign this role because it is equal to or above my highest role.',
            { guildId, roleId, rolePosition: role.position, botRolePosition: botHighestRole?.position }
        );
    }
}

export async function getReactionRoleMessage(client, guildId, messageId) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);
        
        const key = getReactionRoleKey(guildId, messageId);
        const data = await client.db.get(key);
        return data || null;
    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }
        logger.error(`Error getting reaction role message ${messageId} in guild ${guildId}:`, error);
        throw createError(
            `Database error retrieving reaction role message`,
            ErrorTypes.DATABASE,
            'Failed to retrieve reaction role data. Please try again.',
            { guildId, messageId, originalError: error.message }
        );
    }
}

export async function createReactionRoleMessage(client, guildId, channelId, messageId, roleIds) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);
        
        if (!channelId || typeof channelId !== 'string' || !/^\d{17,19}$/.test(channelId)) {
            throw createError(
                `Invalid channel ID: ${channelId}`,
                ErrorTypes.VALIDATION,
                'Invalid channel ID provided.',
                { channelId }
            );
        }
        
        if (!Array.isArray(roleIds) || roleIds.length === 0) {
            throw createError(
                'No roles provided',
                ErrorTypes.VALIDATION,
                'You must provide at least one role.',
                { roleIds }
            );
        }
        
        if (roleIds.length > MAX_ROLES_PER_MESSAGE) {
            throw createError(
                `Too many roles: ${roleIds.length}`,
                ErrorTypes.VALIDATION,
                `You can only add up to ${MAX_ROLES_PER_MESSAGE} roles per reaction role message.`,
                { roleIds, limit: MAX_ROLES_PER_MESSAGE }
            );
        }

        for (const roleId of roleIds) {
            validateRoleId(roleId);
            await validateRoleSafety(client, guildId, roleId);
        }
        
        const reactionRoleData = {
            guildId,
            channelId,
            messageId,
            roles: roleIds,
            createdAt: new Date().toISOString()
        };
        
        const key = getReactionRoleKey(guildId, messageId);
        await client.db.set(key, reactionRoleData);
        
        logger.info(`Created reaction role message ${messageId} in guild ${guildId} with ${roleIds.length} roles`);
        return reactionRoleData;
    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }
        logger.error(`Error creating reaction role message in guild ${guildId}:`, error);
        throw createError(
            `Database error creating reaction role message`,
            ErrorTypes.DATABASE,
            'Failed to save reaction role data. Please try again.',
            { guildId, messageId, originalError: error.message }
        );
    }
}

export async function addReactionRole(client, guildId, messageId, emoji, roleId) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);
        validateRoleId(roleId);
        await validateRoleSafety(client, guildId, roleId);
        
        const key = getReactionRoleKey(guildId, messageId);
        const data = await getReactionRoleMessage(client, guildId, messageId) || {
            messageId,
            guildId,
            channelId: '',
            roles: {}
        };

        data.roles[emoji] = roleId;
        
        await client.db.set(key, data);
        logger.info(`Added reaction role for emoji ${emoji} to message ${messageId} in guild ${guildId}`);
        return true;
    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }
        logger.error(`Error adding reaction role in guild ${guildId}:`, error);
        throw createError(
            `Database error adding reaction role`,
            ErrorTypes.DATABASE,
            'Failed to add reaction role. Please try again.',
            { guildId, messageId, originalError: error.message }
        );
    }
}

export async function deleteReactionRoleMessage(client, guildId, messageId) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);
        
        const key = getReactionRoleKey(guildId, messageId);
        const data = await getReactionRoleMessage(client, guildId, messageId);
        
        if (!data) {
            
            logger.debug(`Reaction role message ${messageId} does not exist in guild ${guildId}, nothing to delete`);
            return true;
        }
        
        await client.db.delete(key);
        logger.info(`Deleted reaction role message ${messageId} in guild ${guildId}`);
        return true;
    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }
        logger.error(`Error deleting reaction role message in guild ${guildId}:`, error);
        throw createError(
            `Database error deleting reaction role message`,
            ErrorTypes.DATABASE,
            'Failed to delete reaction role message. Please try again.',
            { guildId, messageId, originalError: error.message }
        );
    }
}

export async function removeReactionRole(client, guildId, messageId, emoji) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);
        
        const key = getReactionRoleKey(guildId, messageId);
        const data = await getReactionRoleMessage(client, guildId, messageId);
        
        if (!data || !data.roles[emoji]) {
            return false;
        }

        delete data.roles[emoji];

        if (Object.keys(data.roles).length === 0) {
            await client.db.delete(key);
            logger.info(`Removed last reaction role from message ${messageId}, deleted message data`);
        } else {
            await client.db.set(key, data);
            logger.info(`Removed reaction role for emoji ${emoji} from message ${messageId}`);
        }
        
        return true;
    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }
        logger.error(`Error removing reaction role in guild ${guildId}:`, error);
        throw createError(
            `Database error removing reaction role`,
            ErrorTypes.DATABASE,
            'Failed to remove reaction role. Please try again.',
            { guildId, messageId, originalError: error.message }
        );
    }
}

export async function getAllReactionRoleMessages(client, guildId) {
    try {
        validateGuildId(guildId);
        
        const prefix = getReactionRolesPrefix(guildId);
        
        let keys;
        try {
            keys = await client.db.list(prefix);
            
            if (keys && typeof keys === 'object') {
                if (Array.isArray(keys)) {
                    
                } else if (keys.value && Array.isArray(keys.value)) {
                    keys = keys.value;
                } else {
                    const allKeys = await client.db.list();
                    
                    if (Array.isArray(allKeys)) {
                        keys = allKeys.filter(key => key.startsWith(prefix));
                    } else if (allKeys.value && Array.isArray(allKeys.value)) {
                        keys = allKeys.value.filter(key => key.startsWith(prefix));
                    } else {
                        return [];
                    }
                }
            } else {
                return [];
            }
        } catch (listError) {
            logger.error(`Error listing reaction role keys for guild ${guildId}:`, listError);
            throw createError(
                'Database error listing reaction roles',
                ErrorTypes.DATABASE,
                'Failed to retrieve reaction role list. Please try again.',
                { guildId, originalError: listError.message }
            );
        }
        
        if (!keys || keys.length === 0) {
            return [];
        }

        const messages = [];
        
        for (const key of keys) {
            try {
                const data = await client.db.get(key);
                
                if (data) {
                    let actualData;
                    if (data && data.ok && data.value) {
                        actualData = data.value;
                    } else if (data && data.value) {
                        actualData = data.value;
                    } else {
                        actualData = data;
                    }
                    
                    if (actualData && actualData.messageId && actualData.channelId) {
                        messages.push(actualData);
                    } else if (actualData) {
                        logger.warn(`Skipping malformed reaction role data for guild ${guildId}:`, actualData);
                    }
                }
            } catch (dataError) {
                logger.warn(`Error getting data for reaction role key ${key}:`, dataError);
                
            }
        }

        return messages;
    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }
        logger.error(`Error getting all reaction role messages for guild ${guildId}:`, error);
        throw createError(
            'Database error retrieving reaction roles',
            ErrorTypes.DATABASE,
            'Failed to retrieve reaction role messages. Please try again.',
            { guildId, originalError: error.message }
        );
    }
}

export async function setReactionRoleChannel(client, guildId, messageId, channelId) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);
        
        if (!channelId || typeof channelId !== 'string' || !/^\d{17,19}$/.test(channelId)) {
            throw createError(
                `Invalid channel ID: ${channelId}`,
                ErrorTypes.VALIDATION,
                'Invalid channel ID provided.',
                { channelId }
            );
        }
        
        const key = getReactionRoleKey(guildId, messageId);
        const data = await getReactionRoleMessage(client, guildId, messageId) || {
            messageId,
            guildId,
            channelId: '',
            roles: {}
        };

        data.channelId = channelId;
        await client.db.set(key, data);
        logger.info(`Set channel ${channelId} for reaction role message ${messageId}`);
        return true;
    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }
        logger.error(`Error setting channel for reaction role message ${messageId}:`, error);
        throw createError(
            `Database error setting reaction role channel`,
            ErrorTypes.DATABASE,
            'Failed to update reaction role channel. Please try again.',
            { guildId, messageId, channelId, originalError: error.message }
        );
    }
}

export async function reconcileReactionRoleMessages(client, guildId = null) {
    const summary = {
        scannedGuilds: 0,
        scannedMessages: 0,
        removedMessages: 0,
        errors: 0
    };

    try {
        const targetGuildIds = guildId
            ? [guildId]
            : Array.from(client.guilds.cache.keys());

        for (const targetGuildId of targetGuildIds) {
            summary.scannedGuilds += 1;

            let reactionRoleMessages = [];
            try {
                reactionRoleMessages = await getAllReactionRoleMessages(client, targetGuildId);
            } catch (error) {
                summary.errors += 1;
                logger.warn(`Failed to fetch reaction role messages for reconciliation in guild ${targetGuildId}:`, error);
                continue;
            }

            if (!reactionRoleMessages.length) {
                continue;
            }

            const guild = client.guilds.cache.get(targetGuildId) || await client.guilds.fetch(targetGuildId).catch(() => null);
            if (!guild) {
                for (const reactionRoleMessage of reactionRoleMessages) {
                    summary.scannedMessages += 1;
                    await client.db.delete(getReactionRoleKey(targetGuildId, reactionRoleMessage.messageId));
                    summary.removedMessages += 1;
                }
                logger.info(`Removed ${reactionRoleMessages.length} stale reaction role message(s) for unavailable guild ${targetGuildId}`);
                continue;
            }

            for (const reactionRoleMessage of reactionRoleMessages) {
                summary.scannedMessages += 1;

                try {
                    const channel = guild.channels.cache.get(reactionRoleMessage.channelId)
                        || await guild.channels.fetch(reactionRoleMessage.channelId).catch(() => null);

                    if (!channel || !channel.isTextBased?.()) {
                        await client.db.delete(getReactionRoleKey(targetGuildId, reactionRoleMessage.messageId));
                        summary.removedMessages += 1;
                        continue;
                    }

                    const message = await channel.messages.fetch(reactionRoleMessage.messageId).catch(() => null);
                    if (!message) {
                        await client.db.delete(getReactionRoleKey(targetGuildId, reactionRoleMessage.messageId));
                        summary.removedMessages += 1;
                    }
                } catch (messageCheckError) {
                    summary.errors += 1;
                    logger.warn(
                        `Failed to validate reaction role message ${reactionRoleMessage.messageId} during reconciliation:`,
                        messageCheckError
                    );
                }
            }
        }

        logger.info(
            `Reaction role reconciliation complete: scanned ${summary.scannedMessages} message(s) across ${summary.scannedGuilds} guild(s), removed ${summary.removedMessages}, errors ${summary.errors}`
        );

        return summary;
    } catch (error) {
        logger.error('Unexpected error during reaction role reconciliation:', error);
        summary.errors += 1;
        return summary;
    }
}

// ── Panel editing ─────────────────────────────────────────────────────────────
// Shared by /reactroles dashboard and the web dashboard. Panel data changes are
// locked read-modify-writes (client.db.update on the panel's key), so concurrent
// edits can't drop each other's roles.

/** { type, message } for the first reason the role can't go on the panel, or null. */
function panelRoleCheck(guild, role, panel) {
    const roles = Array.isArray(panel?.roles) ? panel.roles : [];
    if (roles.length >= MAX_ROLES_PER_MESSAGE) {
        return { type: ErrorTypes.VALIDATION, message: `This panel already has the maximum of ${MAX_ROLES_PER_MESSAGE} roles.` };
    }
    if (!role) return null;
    if (roles.includes(role.id)) {
        return { type: ErrorTypes.VALIDATION, message: `${role} is already in this panel.` };
    }
    if (role.id === guild?.id) {
        return { type: ErrorTypes.VALIDATION, message: 'You cannot use @everyone.' };
    }
    if (role.managed) {
        return { type: ErrorTypes.VALIDATION, message: 'Managed/bot roles cannot be used.' };
    }
    if (hasDangerousPermissions(role)) {
        return { type: ErrorTypes.PERMISSION, message: 'That role has sensitive permissions (Administrator, Manage Server, etc.) and cannot be used.' };
    }
    const botHighest = guild?.members?.me?.roles?.highest;
    if (!botHighest || role.position >= botHighest.position) {
        return { type: ErrorTypes.PERMISSION, message: 'That role is above my highest role in the hierarchy. Move my role above it first.' };
    }
    return null;
}

/**
 * Why `role` can't be added to `panel` (a user-facing sentence), or null when it
 * can. With role = null only the panel itself is checked (the 25-role limit).
 */
export function getPanelRoleProblem(guild, role, panel) {
    return panelRoleCheck(guild, role, panel)?.message ?? null;
}

function panelNotFound(guildId, messageId) {
    return createError(
        `Reaction role panel not found: ${messageId}`,
        ErrorTypes.VALIDATION,
        'That reaction role panel no longer exists.',
        { guildId, messageId, expected: true },
    );
}

async function resolveGuild(client, guildId) {
    const guild = client.guilds?.cache?.get(guildId) || await client.guilds?.fetch?.(guildId).catch(() => null);
    if (!guild) {
        throw createError(`Guild not found: ${guildId}`, ErrorTypes.VALIDATION, 'Server not found.', { guildId, expected: true });
    }
    return guild;
}

async function fetchPanelMessage(guild, panel) {
    try {
        const channel = guild.channels.cache.get(panel.channelId);
        if (!channel) return { channel: null, message: null };
        const message = await channel.messages.fetch(panel.messageId).catch(() => null);
        return { channel, message };
    } catch {
        return { channel: null, message: null };
    }
}

/** Rewrites the live panel message's role list and select menu from panel.roles. Never throws. */
export async function rebuildLivePanelMessage(guild, panel) {
    try {
        const channel = guild.channels.cache.get(panel.channelId);
        if (!channel) return;
        const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
        if (!msg || !msg.embeds[0]) return;

        const roleObjects = panel.roles
            .map(id => guild.roles.cache.get(id))
            .filter(Boolean);

        if (roleObjects.length === 0) return;

        const currentEmbed = msg.embeds[0];
        const updatedEmbed = EmbedBuilder.from(currentEmbed);
        const fields = currentEmbed.fields.map(f => ({ name: f.name, value: f.value, inline: f.inline }));
        const roleFieldIdx = fields.findIndex(f => f.name === 'Available Roles');
        const newRoleValue = roleObjects.map(r => `• ${r}`).join('\n');
        if (roleFieldIdx !== -1) {
            fields[roleFieldIdx] = { name: 'Available Roles', value: newRoleValue, inline: false };
        } else {
            fields.push({ name: 'Available Roles', value: newRoleValue, inline: false });
        }
        updatedEmbed.setFields(fields);

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('reaction_roles')
                .setPlaceholder('Select your roles')
                .setMinValues(0)
                .setMaxValues(roleObjects.length)
                .addOptions(
                    roleObjects.map(r => ({
                        label: r.name.substring(0, 100),
                        description: `Add/remove the ${r.name} role`.substring(0, 100),
                        value: r.id,
                        emoji: '🎭',
                    })),
                ),
        );

        await msg.edit({ embeds: [updatedEmbed], components: [selectRow] });
    } catch (error) {
        logger.warn('Could not rebuild live reaction role panel:', error.message);
    }
}

/**
 * Adds a role to a panel (checked with getPanelRoleProblem against the panel as
 * stored, under the lock) and rebuilds the live message. Resolves { panel }.
 * Throws a TitanBotError with a userMessage when refused or the panel is gone.
 */
export async function addPanelRole(client, guildId, messageId, roleId) {
    validateGuildId(guildId);
    validateMessageId(messageId);
    validateRoleId(roleId);
    const guild = await resolveGuild(client, guildId);
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
        throw createError(`Role not found: ${roleId}`, ErrorTypes.VALIDATION, 'That role no longer exists.', { guildId, roleId, expected: true });
    }

    const panel = await client.db.update(getReactionRoleKey(guildId, messageId), (current) => {
        if (!current || !Array.isArray(current.roles)) throw panelNotFound(guildId, messageId);
        const problem = panelRoleCheck(guild, role, current);
        if (problem) {
            throw createError(`Reaction role refused: ${problem.message}`, problem.type, problem.message, { guildId, messageId, roleId, expected: true });
        }
        return { ...current, roles: [...current.roles, roleId] };
    }, null);

    await rebuildLivePanelMessage(guild, panel);
    logger.info(`Added role ${roleId} to reaction role panel ${messageId} in guild ${guildId}`);
    return { panel };
}

/**
 * Removes a role from a panel and rebuilds the live message. When it was the last
 * role, the panel message and its data are deleted. Resolves { panel, deletedPanel }.
 * Throws a TitanBotError (userMessage) when the panel is gone.
 */
export async function removePanelRole(client, guildId, messageId, roleId) {
    validateGuildId(guildId);
    validateMessageId(messageId);
    validateRoleId(roleId);
    const guild = await resolveGuild(client, guildId);

    const panel = await client.db.update(getReactionRoleKey(guildId, messageId), (current) => {
        if (!current || !Array.isArray(current.roles)) throw panelNotFound(guildId, messageId);
        return { ...current, roles: current.roles.filter(id => id !== roleId) };
    }, null);

    if (panel.roles.length === 0) {
        const { message } = await fetchPanelMessage(guild, panel);
        if (message) await message.delete().catch(() => {});
        await deleteReactionRoleMessage(client, guildId, messageId);
        return { panel, deletedPanel: true };
    }

    await rebuildLivePanelMessage(guild, panel);
    return { panel, deletedPanel: false };
}

/**
 * Deletes a panel: its Discord message (when found), its data, and logs a
 * REACTION_ROLE_DELETE event. Resolves { deleted, panel, title }; deleted is false
 * (and panel null) when there was no such panel.
 */
export async function deletePanel(client, guildId, messageId, { actorId = null, actorTag = null } = {}) {
    validateGuildId(guildId);
    validateMessageId(messageId);
    const panel = await getReactionRoleMessage(client, guildId, messageId);
    if (!panel) return { deleted: false, panel: null, title: null };

    const guild = await resolveGuild(client, guildId);
    const { channel, message } = await fetchPanelMessage(guild, panel);
    const title = message?.embeds?.[0]?.title ?? 'this panel';

    if (message) await message.delete().catch(() => {});
    await deleteReactionRoleMessage(client, guildId, messageId);

    try {
        await logEvent({
            client,
            guildId,
            eventType: EVENT_TYPES.REACTION_ROLE_DELETE,
            data: {
                description: `Reaction role panel deleted${actorTag ? ` by ${actorTag}` : ''}`,
                userId: actorId,
                channelId: panel.channelId,
                fields: [
                    { name: 'Panel', value: title, inline: true },
                    { name: 'Channel', value: channel ? channel.toString() : 'Unknown', inline: true },
                ],
            },
        });
    } catch (logErr) {
        logger.warn('Failed to log reaction role deletion:', logErr);
    }

    return { deleted: true, panel, title };
}