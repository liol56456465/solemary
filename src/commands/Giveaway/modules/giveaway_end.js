import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';
import { endGiveawayNow } from '../../../services/giveawayService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { textForInteraction } from '../../../utils/botText.js';
import { describe } from '../../../utils/commandLocalizations.js';

export default {
    data: describe(new SlashCommandBuilder().setName("gend"), 'giveaway.cmd.gend')
        .addStringOption((option) =>
            describe(option.setName("messageid"), 'giveaway.cmd.messageId')
                .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const tr = textForInteraction(interaction);
        // Defer up front: channel/message fetches, edits, the winner ping and logging
        // routinely take longer than Discord's 3-second window.
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
                tr.t('giveaway.needManageServer.end'),
                { userId: interaction.user.id, guildId: interaction.guildId }
            );
        }

        logger.info(`Giveaway end initiated by ${interaction.user.tag} in guild ${interaction.guildId}`);

        const messageId = interaction.options.getString("messageid");

        const { giveaway: updatedGiveaway, winners, participantCount, channelId } = await endGiveawayNow(
            interaction.client,
            interaction.guildId,
            messageId,
            interaction.user.id,
            { lang: tr.lang },
        );
        const channel = `<#${channelId}>`;

        logger.info(`Giveaway successfully ended by ${interaction.user.tag}: ${messageId}`);

        return InteractionHelper.safeReply(interaction, {
            embeds: [
                successEmbed(
                    tr.t('giveaway.ended.title'),
                    tr.tp('giveaway.ended.text', winners.length, { prize: updatedGiveaway.prize, channel, entries: participantCount }),
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};
