import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';
// The lookup, message delete, database delete and logging live in the service
// (shared with the web dashboard).
import { deleteGiveawayNow } from '../../../services/giveawayService.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    data: new SlashCommandBuilder()
        .setName("gdelete")
        .setDescription(
            "Deletes a giveaway message and removes it from the database.",
        )
        .addStringOption((option) =>
            option
                .setName("messageid")
                .setDescription("The message ID of the giveaway to delete.")
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
                "You need the 'Manage Server' permission to delete a giveaway.",
                { userId: interaction.user.id, guildId: interaction.guildId }
            );
        }

        logger.info(`Giveaway deletion started by ${interaction.user.tag} in guild ${interaction.guildId}`);

        const messageId = interaction.options.getString("messageid");
        const { giveaway, deletedMessage, channelName } = await deleteGiveawayNow(
            interaction.client,
            interaction.guild,
            messageId,
            interaction.user.id,
        );

        const statusMsg = deletedMessage
            ? `and the message was deleted from #${channelName}`
            : `but the message was already deleted or the channel was inaccessible.`;

        const winnerIds = Array.isArray(giveaway.winnerIds) ? giveaway.winnerIds : [];
        const hasWinners = winnerIds.length > 0;
        const wasEnded = giveaway.ended === true || giveaway.isEnded === true || hasWinners;

        const winnerStatusMsg = hasWinners
            ? `This giveaway already had ${winnerIds.length} winner(s) selected.`
            : wasEnded
                ? 'This giveaway was ended with no valid winners.'
                : 'No winner was picked before deletion.';

        return InteractionHelper.safeReply(interaction, {
            embeds: [
                successEmbed(
                    "Giveaway Deleted",
                    `Successfully deleted the giveaway for **${giveaway.prize}** ${statusMsg}. ${winnerStatusMsg}`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};
