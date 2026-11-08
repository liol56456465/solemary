import { EmbedBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { getColor } from '../../config/bot.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import { getReactionRoleMessage } from '../../services/reactionRoleService.js';
import { hasDangerousPermissions } from '../../utils/roleSafety.js';
import { textForInteraction } from '../../utils/botText.js';

export async function handleReactionRolesSelectMenu(interaction, client) {
    // An ephemeral answer to the member who picked: their Discord language.
    const tr = textForInteraction(interaction);
    try {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) return;

        if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
            throw createError(
                'Reaction role interaction used outside a guild context',
                ErrorTypes.VALIDATION,
                tr.t('reactionroles.select.outsideGuild'),
                { userId: interaction.user.id }
            );
        }

        logger.debug(`Reaction role select menu interaction by ${interaction.user.tag} on message ${interaction.message.id}`);

        const reactionRoleData = await getReactionRoleMessage(client, interaction.guildId, interaction.message.id);

        if (!reactionRoleData) {
            logger.warn(`Reaction role data not found for message ${interaction.message.id} in guild ${interaction.guildId}`);
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(tr.t('reactionroles.select.inactive'))
                        .setColor(getColor('error'))
                ]
            });
        }

        const member = interaction.member;
        const selectedRoleIds = interaction.values;

        const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe().catch(() => null);

        if (!me) {
            throw createError(
                'Unable to fetch bot member for permission validation',
                ErrorTypes.PERMISSION,
                tr.t('reactionroles.select.cannotVerify'),
                { guildId: interaction.guildId }
            );
        }

        if (!me.permissions.has('ManageRoles')) {
            throw createError(
                'Bot missing ManageRoles permission',
                ErrorTypes.PERMISSION,
                tr.t('reactionroles.select.noManageRoles'),
                { guildId: interaction.guildId }
            );
        }

        const botRolePosition = me.roles.highest.position;

        const availableRoleIds = Array.isArray(reactionRoleData.roles)
            ? reactionRoleData.roles
            : (typeof reactionRoleData.roles === 'object' ? Object.values(reactionRoleData.roles) : []);

        const addedRoles = [];
        const removedRoles = [];
        const skippedRoles = [];

        for (const roleId of selectedRoleIds) {
            if (!availableRoleIds.includes(roleId)) {
                logger.warn(`Role ${roleId} not in available roles for message ${interaction.message.id}`);
                continue;
            }

            const role = interaction.guild.roles.cache.get(roleId);
            if (!role) {
                logger.warn(`Role ${roleId} not found in guild ${interaction.guildId}`);
                skippedRoles.push(roleId);
                continue;
            }

            // Re-checked on every click: the role's permissions may have changed since setup.
            if (role.managed || hasDangerousPermissions(role)) {
                logger.warn(`Blocked self-assignment for protected role ${role.name} (${roleId})`);
                skippedRoles.push(role.name);
                continue;
            }

            if (role.position >= botRolePosition) {
                logger.warn(`Cannot assign role ${role.name} (${roleId}), hierarchy issue`);
                skippedRoles.push(role.name);
                continue;
            }

            if (!member.roles.cache.has(roleId)) {
                try {
                    await member.roles.add(role);
                    addedRoles.push(role.name);
                    logger.debug(`Added role ${role.name} to ${member.user.tag}`);
                } catch (roleError) {
                    logger.error(`Failed to add role ${role.name} to ${member.user.tag}:`, roleError);
                    skippedRoles.push(role.name);
                }
            }
        }

        for (const roleId of availableRoleIds) {
            if (selectedRoleIds.includes(roleId)) continue;

            const role = interaction.guild.roles.cache.get(roleId);
            if (!role) continue;

            if (role.position >= botRolePosition) continue;

            if (member.roles.cache.has(roleId)) {
                try {
                    await member.roles.remove(role);
                    removedRoles.push(role.name);
                    logger.debug(`Removed role ${role.name} from ${member.user.tag}`);
                } catch (roleError) {
                    logger.error(`Failed to remove role ${role.name} from ${member.user.tag}:`, roleError);
                }
            }
        }

        const description = rolesUpdatedText(tr, { addedRoles, removedRoles, skipped: skippedRoles.length });

        const responseEmbed = new EmbedBuilder()
            .setDescription(description)
            .setColor(getColor('success'))
            .setTimestamp();

        await interaction.editReply({ embeds: [responseEmbed] });

        if (addedRoles.length > 0 || removedRoles.length > 0) {
            try {
                await logEvent({
                    client,
                    guildId: interaction.guildId,
                    eventType: EVENT_TYPES.REACTION_ROLE_UPDATE,
                    data: {
                        description: `Reaction roles updated for ${member.user.tag}`,
                        userId: member.user.id,
                        channelId: interaction.channelId,
                        fields: [
                            {
                                name: 'Member',
                                value: `${member.user.tag} (${member.user.id})`,
                                inline: false
                            },
                            ...(addedRoles.length > 0 ? [{
                                name: 'Roles added',
                                value: addedRoles.join(', '),
                                inline: false
                            }] : []),
                            ...(removedRoles.length > 0 ? [{
                                name: 'Roles removed',
                                value: removedRoles.join(', '),
                                inline: false
                            }] : [])
                        ]
                    }
                });
            } catch (logError) {
                logger.warn('Failed to log reaction role update:', logError);
            }
        }

        logger.info(`Reaction roles updated for ${member.user.tag}: +${addedRoles.length}, -${removedRoles.length}`);

    } catch (error) {
        await handleInteractionError(interaction, error, {
            type: 'select_menu',
            customId: 'reaction_roles'
        });
    }
}

/** The member's "roles updated" reply text (role names are shown as typed, in bold). */
export function rolesUpdatedText(tr, { addedRoles = [], removedRoles = [], skipped = 0 }) {
    const bold = (names) => names.map((name) => `**${name}**`).join(', ');
    let description = `${tr.t('reactionroles.select.updated')}\n\n`;
    if (addedRoles.length > 0) description += `${tr.t('reactionroles.select.added', { roles: bold(addedRoles) })}\n`;
    if (removedRoles.length > 0) description += `${tr.t('reactionroles.select.removed', { roles: bold(removedRoles) })}\n`;
    if (addedRoles.length === 0 && removedRoles.length === 0) description += tr.t('reactionroles.select.nothing');
    if (skipped > 0) description += `\n${tr.tp('reactionroles.select.skipped', skipped)}`;
    return description;
}
