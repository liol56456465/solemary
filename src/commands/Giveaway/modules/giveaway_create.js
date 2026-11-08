import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';
// Validation, posting, saving and logging live in the service (shared with the web dashboard).
import { createGiveaway } from '../../../services/giveawayService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { textForInteraction } from '../../../utils/botText.js';
import { describe } from '../../../utils/commandLocalizations.js';

import { botConfig } from '../../../config/bot.js';

const GIVEAWAY_MIN_WINNERS = botConfig.giveaways?.minimumWinners ?? 1;
const GIVEAWAY_MAX_WINNERS = botConfig.giveaways?.maximumWinners ?? 10;

export default {
    data: describe(new SlashCommandBuilder().setName("gcreate"), 'giveaway.cmd.gcreate')
        .addStringOption((option) =>
            describe(option.setName("duration"), 'giveaway.cmd.duration')
                .setRequired(true),
        )
        .addIntegerOption((option) =>
            describe(option.setName("winners"), 'giveaway.cmd.winners')
                .setMinValue(GIVEAWAY_MIN_WINNERS)
                .setMaxValue(GIVEAWAY_MAX_WINNERS)
                .setRequired(true),
        )
        .addStringOption((option) =>
            describe(option.setName("prize"), 'giveaway.cmd.prize')
                .setRequired(true),
        )
        .addChannelOption((option) =>
            describe(option.setName("channel"), 'giveaway.cmd.channel')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(false),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        // Ephemeral answers: the moderator's own Discord language. The giveaway post: the server's.
        const tr = textForInteraction(interaction);
        // Defer up front: sending the giveaway message + DB write can exceed the 3s window
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
                tr.t('giveaway.needManageServer.create'),
                { userId: interaction.user.id, guildId: interaction.guildId }
            );
        }

        logger.info(`Giveaway creation started by ${interaction.user.tag} in guild ${interaction.guildId}`);

        const durationString = interaction.options.getString("duration");
        const winnerCount = interaction.options.getInteger("winners");
        const prize = interaction.options.getString("prize");
        const targetChannel = interaction.options.getChannel("channel") || interaction.channel;

        const { giveaway } = await createGiveaway(interaction.client, interaction.guild, {
            channel: targetChannel,
            duration: durationString,
            winnerCount,
            prize,
            hostId: interaction.user.id,
            lang: tr.lang,
        });

        await InteractionHelper.safeReply(interaction, {
            embeds: [
                successEmbed(
                    tr.t('giveaway.created.title'),
                    tr.t('giveaway.created.text', { prize: giveaway.prize, channel: String(targetChannel), duration: durationString }),
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};
