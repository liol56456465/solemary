import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';
import { rerollGiveaway } from '../../../services/giveawayService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { textForInteraction } from '../../../utils/botText.js';
import { describe } from '../../../utils/commandLocalizations.js';

export default {
    data: describe(new SlashCommandBuilder().setName("greroll"), 'giveaway.cmd.greroll')
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
                tr.t('giveaway.needManageServer.reroll'),
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
            { lang: tr.lang },
        );

        if (!channelId) {
            return InteractionHelper.safeReply(interaction, {
                embeds: [
                    successEmbed(
                        tr.t('giveaway.reroll.completeTitle'),
                        tr.t('giveaway.reroll.noChannel'),
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
                        tr.t('giveaway.reroll.completeTitle'),
                        tr.t('giveaway.reroll.noMessage', { channel }),
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });
        }

        return InteractionHelper.safeReply(interaction, {
            embeds: [
                successEmbed(
                    tr.t('giveaway.reroll.title'),
                    tr.tp('giveaway.reroll.text', newWinners.length, { prize: giveaway.prize, channel }),
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};
