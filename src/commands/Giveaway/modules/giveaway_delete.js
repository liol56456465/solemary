import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';
// The lookup, message delete, database delete and logging live in the service
// (shared with the web dashboard).
import { deleteGiveawayNow } from '../../../services/giveawayService.js';
import { textForInteraction } from '../../../utils/botText.js';
import { describe } from '../../../utils/commandLocalizations.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    data: describe(new SlashCommandBuilder().setName("gdelete"), 'giveaway.cmd.gdelete')
        .addStringOption((option) =>
            describe(option.setName("messageid"), 'giveaway.cmd.messageId')
                .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const tr = textForInteraction(interaction);
        // Defer up front: message lookups, edits and logging can exceed the 3s window
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        if (!interaction.inGuild()) {
            throw new TitanBotError(
                'Giveaway command used outside guild',
                ErrorTypes.VALIDATION,
                tr.t('giveaway.guildOnly'),
                { userId: interaction.user.id }
            );
        }

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            throw new TitanBotError(
                'User lacks ManageGuild permission',
                ErrorTypes.PERMISSION,
                tr.t('giveaway.needManageServer.delete'),
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
            { lang: tr.lang },
        );

        const deletedLine = deletedMessage
            ? tr.t('giveaway.deleted.withMessage', { prize: giveaway.prize, channel: channelName })
            : tr.t('giveaway.deleted.withoutMessage', { prize: giveaway.prize });

        const winnerIds = Array.isArray(giveaway.winnerIds) ? giveaway.winnerIds : [];
        const hasWinners = winnerIds.length > 0;
        const wasEnded = giveaway.ended === true || giveaway.isEnded === true || hasWinners;

        const winnerStatusMsg = hasWinners
            ? tr.tp('giveaway.deleted.hadWinners', winnerIds.length)
            : wasEnded
                ? tr.t('giveaway.deleted.endedNoWinner')
                : tr.t('giveaway.deleted.noWinner');

        return InteractionHelper.safeReply(interaction, {
            embeds: [
                successEmbed(
                    tr.t('giveaway.deleted.title'),
                    `${deletedLine} ${winnerStatusMsg}`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};
