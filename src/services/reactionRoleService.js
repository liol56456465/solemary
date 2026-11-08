// reactionRoleService.js

import { ActionRowBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits, StringSelectMenuBuilder } from 'discord.js';
import { getColor } from '../config/bot.js';
import { logger } from '../utils/logger.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { getReactionRoleKey, getReactionRolesPrefix } from '../utils/database/keys.js';
import { getDangerousPermissions, hasDangerousPermissions } from '../utils/roleSafety.js';
import { BOT_CATALOG, LANG_CODES, botText, textForGuild } from '../utils/botText.js';

// Re-exported for reactroles.js, which imports it from here.
export { hasDangerousPermissions };

const MAX_ROLES_PER_MESSAGE = 25;

// Panel texts are posted in the server's language (Dashboard → Bot language). A panel posted
// earlier in another language keeps working: its role field is found by any language's name.
const AVAILABLE_ROLES_NAMES = new Set(LANG_CODES.map((code) => BOT_CATALOG.translate(code, 'reactionroles.panel.availableRoles')));

/** True when an embed field is a panel's role list (its name in any of the 8 languages). */
export function isAvailableRolesField(field) {
    return AVAILABLE_ROLES_NAMES.has(field?.name);
}

/** The select-menu row of a panel, in the server's language (tr). */
export function panelSelectRow(roles, tr) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('reaction_roles')
            .setPlaceholder(tr.t('reactionroles.panel.placeholder'))
            .setMinValues(0)
            .setMaxValues(roles.length)
            .addOptions(roles.map((role) => ({
                label: String(role.name).substring(0, 100),
                description: tr.t('reactionroles.panel.optionDescription', { role: role.name }).substring(0, 100),
                value: role.id,
            }))),
    );
}

/** A panel's embed fields with the role list replaced (or added) for these roles. */
export function panelFieldsWithRoles(fields, roles, tr) {
    const out = (fields || []).map((f) => ({ name: f.name, value: f.value, inline: f.inline }));
    const idx = out.findIndex(isAvailableRolesField);
    const field = { name: tr.t('reactionroles.panel.availableRoles'), value: roles.map((r) => `• ${r}`).join('\n'), inline: false };
    if (idx !== -1) out[idx] = field;
    else out.push(field);
    return out;
}


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
        let stored = 0;

        for (const key of keys) {
            // A failed read throws (the caller shows "database not responding"): a silently
            // missing panel would look deleted and let a sixth panel past the cap.
            const data = await client.db.get(key);
            if (!data) continue;
            stored += 1;
            const actualData = data && data.value ? data.value : data;
            if (actualData && actualData.messageId && actualData.channelId) {
                messages.push(actualData);
            } else if (actualData) {
                logger.warn(`Skipping malformed reaction role data for guild ${guildId}:`, actualData);
            }
        }

        // Every stored panel, malformed ones included, for the MAX_PANELS_PER_GUILD cap.
        Object.defineProperty(messages, 'storedCount', { value: stored, enumerable: false });
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

export async function reconcileReactionRoleMessages(client, guildId = null, { quiet = false } = {}) {
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

        if (!quiet) logger.info(
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
function panelRoleCheck(guild, role, panel, lang) {
    const { t } = botText(lang);
    const roles = Array.isArray(panel?.roles) ? panel.roles : [];
    if (roles.length >= MAX_ROLES_PER_MESSAGE) {
        return { type: ErrorTypes.VALIDATION, message: t('reactionroles.errors.maxRoles', { max: MAX_ROLES_PER_MESSAGE }) };
    }
    if (!role) return null;
    if (roles.includes(role.id)) {
        return { type: ErrorTypes.VALIDATION, message: t('reactionroles.errors.alreadyIn', { role: String(role) }) };
    }
    if (role.id === guild?.id) {
        return { type: ErrorTypes.VALIDATION, message: t('reactionroles.errors.everyone') };
    }
    if (role.managed) {
        return { type: ErrorTypes.VALIDATION, message: t('reactionroles.errors.managed') };
    }
    if (hasDangerousPermissions(role)) {
        return { type: ErrorTypes.PERMISSION, message: t('reactionroles.errors.dangerous') };
    }
    const botHighest = guild?.members?.me?.roles?.highest;
    if (!botHighest || role.position >= botHighest.position) {
        return { type: ErrorTypes.PERMISSION, message: t('reactionroles.errors.hierarchy') };
    }
    return null;
}

/**
 * Why `role` can't be added to `panel` (a user-facing sentence), or null when it
 * can. With role = null only the panel itself is checked (the 25-role limit).
 * The sentence is in `lang` (default English; /reactroles passes the user's language).
 */
export function getPanelRoleProblem(guild, role, panel, { lang } = {}) {
    return panelRoleCheck(guild, role, panel, lang)?.message ?? null;
}

function panelNotFound(guildId, messageId, lang) {
    return createError(
        `Reaction role panel not found: ${messageId}`,
        ErrorTypes.VALIDATION,
        botText(lang).t('reactionroles.errors.panelGone'),
        { guildId, messageId, expected: true },
    );
}

async function resolveGuild(client, guildId, lang) {
    const guild = client.guilds?.cache?.get(guildId) || await client.guilds?.fetch?.(guildId).catch(() => null);
    if (!guild) {
        throw createError(`Guild not found: ${guildId}`, ErrorTypes.VALIDATION, botText(lang).t('reactionroles.errors.serverNotFound'), { guildId, expected: true });
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

        const tr = textForGuild(guild.id, { purpose: 'public' });
        const updatedEmbed = EmbedBuilder.from(msg.embeds[0]).setFields(panelFieldsWithRoles(msg.embeds[0].fields, roleObjects, tr));
        const selectRow = panelSelectRow(roleObjects, tr);

        await msg.edit({ embeds: [updatedEmbed], components: [selectRow] });
    } catch (error) {
        logger.warn('Could not rebuild live reaction role panel:', error.message);
    }
}

/**
 * Adds a role to a panel (checked with getPanelRoleProblem against the panel as
 * stored, under the lock) and rebuilds the live message. Resolves { panel }.
 * Throws a TitanBotError with a userMessage (in `lang`, default English) when refused or the panel is gone.
 */
export async function addPanelRole(client, guildId, messageId, roleId, { lang } = {}) {
    validateGuildId(guildId);
    validateMessageId(messageId);
    validateRoleId(roleId);
    const guild = await resolveGuild(client, guildId, lang);
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
        throw createError(`Role not found: ${roleId}`, ErrorTypes.VALIDATION, botText(lang).t('reactionroles.errors.roleGone'), { guildId, roleId, expected: true });
    }

    const panel = await client.db.update(getReactionRoleKey(guildId, messageId), (current) => {
        if (!current || !Array.isArray(current.roles)) throw panelNotFound(guildId, messageId, lang);
        const problem = panelRoleCheck(guild, role, current, lang);
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
 * Throws a TitanBotError (userMessage in `lang`, default English) when the panel is gone.
 */
export async function removePanelRole(client, guildId, messageId, roleId, { lang } = {}) {
    validateGuildId(guildId);
    validateMessageId(messageId);
    validateRoleId(roleId);
    const guild = await resolveGuild(client, guildId, lang);

    const panel = await client.db.update(getReactionRoleKey(guildId, messageId), (current) => {
        if (!current || !Array.isArray(current.roles)) throw panelNotFound(guildId, messageId, lang);
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

export const MAX_PANELS_PER_GUILD = 5;
export const PANEL_TITLE_MAX = 256;
export const PANEL_DESCRIPTION_MAX = 4000;

/** Why `role` can't be on a new panel (a line for the "cannot be added" list), or null. */
function newPanelRoleProblem(guild, role, seen, t) {
    const p = { role: role.name };
    if (seen.has(role.id)) return t('reactionroles.errors.rejectDuplicate', p);
    if (role.position >= (guild.members.me?.roles?.highest?.position ?? 0)) {
        return t('reactionroles.errors.rejectHierarchy', p);
    }
    if (hasDangerousPermissions(role)) return t('reactionroles.errors.rejectDangerous', p);
    if (role.managed) return t('reactionroles.errors.rejectManaged', p);
    if (role.id === guild.id) return t('reactionroles.errors.rejectEveryone', p);
    return null;
}

/**
 * The panel message (embed + select menu) for a title, description and roles. The title and
 * description are the admin's own text (never translated); the bot's labels are in `lang`
 * (the server's language when posting; default English).
 */
export function buildReactionRolePanelPayload(title, description, roles, { lang } = {}) {
    const tr = botText(lang);
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(getColor('info'))
        .addFields({ name: tr.t('reactionroles.panel.availableRoles'), value: roles.map((role) => `• ${role}`).join('\n') })
        .setFooter({ text: tr.t('reactionroles.panel.footer') });
    return { embeds: [embed], components: [panelSelectRow(roles, tr)] };
}

/**
 * Creates a reaction role panel (shared by /reactroles setup and the web dashboard):
 * text/announcement channel, Manage Roles, Send Messages there, at most 5 panels, then
 * every role checked (duplicates, hierarchy, dangerous permissions, managed, @everyone).
 * Refused roles are skipped and listed; with no valid role at all it throws. Posts the
 * panel, saves it (deleting the message again when saving fails) and logs
 * REACTION_ROLE_CREATE. Resolves { message, panel, roles, rejected }.
 * Refusals and the rejected lines are in `lang` (default English; /reactroles passes the user's
 * language); the posted panel is in the server's language.
 */
export async function createReactionRolePanel(client, guild, { channel, title, description, roleIds, actorId = null, actorTag = null, lang }) {
    const { t } = botText(lang);
    const cleanTitle = String(title ?? '').trim();
    const cleanDescription = String(description ?? '').trim();
    if (!cleanTitle || cleanTitle.length > PANEL_TITLE_MAX) {
        throw createError('Bad panel title', ErrorTypes.VALIDATION, t('reactionroles.errors.titleLength', { max: PANEL_TITLE_MAX }), { expected: true });
    }
    if (!cleanDescription || cleanDescription.length > PANEL_DESCRIPTION_MAX) {
        throw createError('Bad panel description', ErrorTypes.VALIDATION, t('reactionroles.errors.descriptionLength', { max: PANEL_DESCRIPTION_MAX }), { expected: true });
    }
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        throw createError(`Invalid channel type: ${channel?.type}`, ErrorTypes.VALIDATION, t('reactionroles.errors.channelType'), { channelType: channel?.type, expected: true });
    }
    const me = guild.members.me;
    if (!me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
        throw createError('Bot missing ManageRoles permission', ErrorTypes.PERMISSION, t('reactionroles.errors.manageRoles'), { permission: 'ManageRoles', expected: true });
    }
    if (!channel.permissionsFor(me)?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw createError(`Bot cannot send messages in ${channel.name}`, ErrorTypes.PERMISSION, t('reactionroles.errors.sendMessages', { channelId: channel.id }), { channelId: channel.id, expected: true });
    }
    const existing = await getAllReactionRoleMessages(client, guild.id);
    const panelCount = existing ? (existing.storedCount ?? existing.length) : 0;
    if (panelCount >= MAX_PANELS_PER_GUILD) {
        throw createError('Panel limit reached', ErrorTypes.VALIDATION,
            t('reactionroles.errors.panelLimit', { max: MAX_PANELS_PER_GUILD }),
            { maxPanels: MAX_PANELS_PER_GUILD, currentPanels: panelCount, expected: true });
    }

    const roles = [];
    const rejected = [];
    const seen = new Set();
    for (const roleId of (roleIds || []).slice(0, MAX_ROLES_PER_MESSAGE)) {
        const role = guild.roles.cache.get(roleId);
        if (!role) {
            rejected.push(t('reactionroles.errors.rejectMissing', { roleId }));
            continue;
        }
        const problem = newPanelRoleProblem(guild, role, seen, t);
        if (problem) {
            rejected.push(problem);
            continue;
        }
        seen.add(role.id);
        roles.push(role);
    }
    if (roles.length === 0) {
        const message = rejected.length
            ? t('reactionroles.errors.cannotAdd', { list: rejected.join('\n') })
            : t('reactionroles.errors.atLeastOne');
        throw createError('No valid roles provided', ErrorTypes.VALIDATION, message, { errors: rejected, expected: true });
    }

    const panelLang = textForGuild(guild.id, { purpose: 'public' }).lang;
    const message = await channel.send(buildReactionRolePanelPayload(cleanTitle, cleanDescription, roles, { lang: panelLang }));
    let panel;
    try {
        panel = await createReactionRoleMessage(client, guild.id, channel.id, message.id, roles.map((role) => role.id));
    } catch (saveError) {
        // The panel is posted but its data failed to persist, so the dropdown would not
        // work. Remove the orphaned message before surfacing the error.
        await message.delete().catch(() => {});
        throw saveError;
    }

    logger.info(`Reaction role message created: ${message.id} with ${roles.length} roles by ${actorTag || actorId}`);
    try {
        await logEvent({
            client,
            guildId: guild.id,
            eventType: EVENT_TYPES.REACTION_ROLE_CREATE,
            data: {
                description: `Reaction role panel created${actorTag ? ` by ${actorTag}` : ''}`,
                userId: actorId,
                channelId: channel.id,
                fields: [
                    { name: 'Title', value: cleanTitle, inline: false },
                    { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                    { name: 'Roles', value: `${roles.length} roles`, inline: true },
                    { name: 'Role list', value: roles.map((r) => r.toString()).join(','), inline: false },
                    { name: 'Message link', value: message.url || message.id, inline: false },
                ],
            },
        });
    } catch (logError) {
        logger.warn('Failed to log reaction role creation:', logError);
    }
    return { message, panel, roles, rejected };
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