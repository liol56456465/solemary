import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';
import { rerollGiveaway } from '../../../services/giveawayService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName("greroll")
        .setDescription("Rerolls the winner(s) for an ended giveaway.")
        .addStringOption((option) =>
            option
                .setName("messageid")
                .setDescription("The message ID of the ended giveaway.")
                .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        // Defer up front: message lookups, edits and logging can exceed the 3s window
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        if (!interaction.inGuild()) {
            throw new TitanBotError(
                'Giveaway command used outside guild',
                ErrorTypes.VALIDATION,
                'This command can only be used in a server.',
                { userId: interaction.user.id }
            );
        }

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            throw new TitanBotError(
                'User lacks ManageGuild permission',
                ErrorTypes.PERMISSION,
                "You need the 'Manage Server' permission to reroll a giveaway.",
                { userId: interaction.user.id, guildId: interaction.guildId }
            );
        }

        logger.info(`Giveaway reroll initiated by ${interaction.user.tag} in guild ${interaction.guildId}`);

        const messageId = interaction.options.getString("messageid");

        const { giveaway, winners: newWinners, channelId, messageFound } = await rerollGiveaway(
            interaction.client,
            interaction.guildId,
            messageId,
            interaction.user.id,
        );

        if (!channelId) {
            return InteractionHelper.safeReply(interaction, {
                embeds: [
                    successEmbed(
                        "Reroll Complete",
                        "The new winners have been selected and saved to the database. Could not find channel to announce.",
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });
        }

        const channel = `<#${channelId}>`;

        if (!messageFound) {
            return InteractionHelper.safeReply(interaction, {
                embeds: [
                    successEmbed(
                        "Reroll Complete",
                        `The new winners have been announced in ${channel}. (Original message not found).`,
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });
        }

        return InteractionHelper.safeReply(interaction, {
            embeds: [
                successEmbed(
                    "Reroll Successful ✅",
                    `Successfully rerolled the giveaway for **${giveaway.prize}** in ${channel}. Selected ${newWinners.length} new winner(s).`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};