import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, MessageFlags } from 'discord.js';
import { getWelcomeConfig } from '../../utils/database.js';
import { addAutoRole, removeAutoRole, updateWelcomeSettings } from '../../services/welcomeService.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { getRoleAssignmentProblem } from '../../utils/roleSafety.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';

function createAutoroleInfoEmbed(description) {
    return new EmbedBuilder()
        .setColor(getColor('primary'))
        .setDescription(description)
        .setFooter({ text: new Date().toLocaleString() });
}

export default {
    data: new SlashCommandBuilder()
        .setName('autorole')
        .setDescription('Manage roles that are automatically assigned to new members')
        .setDescriptionLocalizations(localizations('welcome.cmd.autorole.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Add a role to be automatically assigned to new members')
                .setDescriptionLocalizations(localizations('welcome.cmd.autorole.add.description'))
                .addRoleOption(option =>
                    option.setName('role')
                        .setDescription('The role to add')
                        .setDescriptionLocalizations(localizations('welcome.cmd.autorole.add.role'))
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove a role from auto-assignment')
                .setDescriptionLocalizations(localizations('welcome.cmd.autorole.remove.description'))
                .addRoleOption(option =>
                    option.setName('role')
                        .setDescription('The role to remove')
                        .setDescriptionLocalizations(localizations('welcome.cmd.autorole.remove.role'))
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all auto-assigned roles')
                .setDescriptionLocalizations(localizations('welcome.cmd.autorole.list'))),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Autorole interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'autorole'
            });
            return;
        }

        // Errors are private (the user's language); the answers are posted in the channel (the server's).
        const tr = textForInteraction(interaction);
        const pub = textForInteraction(interaction, { purpose: 'public' });

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('welcome.manageServer', { command: '/autorole' }) });
        }

    const { options, guild, client } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand === 'add') {
            const role = options.getRole('role');

            const guildConfig = await getGuildConfig(client, guild.id);
            const verificationEnabled = Boolean(guildConfig.verification?.enabled);
            const autoVerifyEnabled = Boolean(guildConfig.verification?.autoVerify?.enabled);

            if (verificationEnabled || autoVerifyEnabled) {
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('welcome.autorole.verificationConflict') });
            }
            
            // Every new member gets this role, so it must be harmless and assignable.
            const roleProblem = getRoleAssignmentProblem(role, guild.members.me);
            if (roleProblem) {
                logger.warn(`[Autorole] User ${interaction.user.tag} tried to add unsafe role ${role.name} (${role.id}) in ${guild.name}: ${roleProblem}`);
                return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: roleProblem });
            }

            try {
                // Only one auto-role is allowed: adding replaces the current one (atomically).
                const { before, changed } = await addAutoRole(client, guild.id, role.id);
                const currentRoleId = before.roleIds?.[0] || null;

                if (!changed) {
                    logger.info(`[Autorole] User ${interaction.user.tag} tried to add duplicate role ${role.name} (${role.id}) in ${guild.name}`);
                    return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('welcome.autorole.alreadySet', { role: String(role) }) });
                }

                logger.info(`[Autorole] Set single auto-role to ${role.name} (${role.id}) in ${guild.name} by ${interaction.user.tag}`);
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [createAutoroleInfoEmbed(
                        currentRoleId
                            ? pub.t('welcome.autorole.changed', { role: String(role) })
                            : pub.t('welcome.autorole.set', { role: String(role) })
                    )],
                    flags: MessageFlags.Ephemeral
                });
            } catch (error) {
                logger.error(`[Autorole] Failed to add role for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('welcome.autorole.addFailed') });
            }
        } 
        
        else if (subcommand === 'remove') {
            const role = options.getRole('role');

            try {
                const { changed } = await removeAutoRole(client, guild.id, role.id);

                if (!changed) {
                    logger.info(`[Autorole] User ${interaction.user.tag} tried to remove non-existent role ${role.name} (${role.id}) in ${guild.name}`);
                    return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('welcome.autorole.notSet', { role: String(role) }) });
                }

                logger.info(`[Autorole] Removed role ${role.name} (${role.id}) from auto-assign in ${guild.name} by ${interaction.user.tag}`);
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [createAutoroleInfoEmbed(pub.t('welcome.autorole.removed', { role: String(role) }))],
                    flags: MessageFlags.Ephemeral
                });
            } catch (error) {
                logger.error(`[Autorole] Failed to remove role for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('welcome.autorole.removeFailed') });
            }
        }
        
        else if (subcommand === 'list') {
            try {
                const guildConfig = await getGuildConfig(client, guild.id);
                const verificationEnabled = Boolean(guildConfig.verification?.enabled);
                const autoVerifyEnabled = Boolean(guildConfig.verification?.autoVerify?.enabled);
                const conflictSummary = [
                    verificationEnabled ? pub.t('welcome.autorole.verificationOn') : null,
                    autoVerifyEnabled ? pub.t('welcome.autorole.autoVerifyOn') : null
                ].filter(Boolean).join('\n');
                const needsFixing = conflictSummary ? pub.t('welcome.autorole.needsFixing', { list: conflictSummary }) : '';

                const config = await getWelcomeConfig(client, guild.id);
                const autoRoles = Array.isArray(config.roleIds) ? config.roleIds : [];

                const singleRoleIds = autoRoles.length > 1 ? [autoRoles[0]] : autoRoles;
                if (singleRoleIds.length !== autoRoles.length) {
                    await updateWelcomeSettings(client, guild.id, {
                        roleIds: singleRoleIds
                    });
                    logger.info(`[Autorole] Trimmed auto-role list to one role in ${interaction.guild.name}`);
                }

                if (singleRoleIds.length === 0) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [createAutoroleInfoEmbed(`${pub.t('welcome.autorole.none')}${needsFixing}`)],
                        flags: MessageFlags.Ephemeral
                    });
                }

                const roles = await guild.roles.fetch();
                const validRoles = [];
                const invalidRoleIds = [];
                
                for (const roleId of singleRoleIds) {
                    const role = roles.get(roleId);
                    if (role) {
                        validRoles.push(role);
                    } else {
                        invalidRoleIds.push(roleId);
                    }
                }

                if (invalidRoleIds.length > 0) {
                    logger.info(`[Autorole] Cleaning up ${invalidRoleIds.length} invalid role(s) from guild ${interaction.guild.name}`);
                    for (const invalidRoleId of invalidRoleIds) {
                        await removeAutoRole(client, guild.id, invalidRoleId);
                    }
                }

                if (validRoles.length === 0) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [createAutoroleInfoEmbed(`${pub.t('welcome.autorole.noneWorking')}${needsFixing}`)],
                        flags: MessageFlags.Ephemeral
                    });
                }

                const embed = new EmbedBuilder()
                    .setColor(getColor('info'))
                    .setTitle(pub.t('welcome.autorole.title'))
                    .setDescription(`${validRoles[0]}${needsFixing}`)
                    .setFooter({ text: pub.t('welcome.autorole.footer') });

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });

            } catch (error) {
                logger.error(`[Autorole] Failed to list roles for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('welcome.autorole.listFailed') });
            }
        }
    },
};