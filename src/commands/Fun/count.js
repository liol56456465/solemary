import { SlashCommandBuilder, ChannelType, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
  getCountingGameConfig,
  activateCountingGame,
  disableCountingGame,
  resetCountingGame,
  buildCountingLeaderboard,
  getCountingSystemChoices,
  getCountingSystemLabel,
  getExpectedCountValue,
} from '../../services/countingGameService.js';
import { logger } from '../../utils/logger.js';

import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { localized, replyText } from '../Core/modules/commandText.js';
export default {
  data: new SlashCommandBuilder()
    .setName('count')
    .setDescription('Manage the server counting game')
    .setDescriptionLocalizations(localized('fun.slash.count.description'))
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('setup')
        .setDescription('Start a counting game in a text channel')
        .setDescriptionLocalizations(localized('fun.slash.count.sub.setup.description'))
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('The channel where counting will take place')
            .setDescriptionLocalizations(localized('fun.slash.count.sub.setup.options.channel'))
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addStringOption((option) =>
          option
            .setName('system')
            .setDescription('The counting system to use')
            .setDescriptionLocalizations(localized('fun.slash.count.sub.setup.options.system'))
            .setRequired(true)
            .addChoices(...getCountingSystemChoices()),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('disable').setDescription('Disable the counting game for this server').setDescriptionLocalizations(localized('fun.slash.count.sub.disable.description')),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription('View current counting game status').setDescriptionLocalizations(localized('fun.slash.count.sub.status.description')),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reset')
        .setDescription('Reset the current counting sequence')
        .setDescriptionLocalizations(localized('fun.slash.count.sub.reset.description'))
        .addIntegerOption((option) =>
          option
            .setName('start')
            .setDescription('The number to start at after reset')
            .setDescriptionLocalizations(localized('fun.slash.count.sub.reset.options.start'))
            .setMinValue(1),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('leaderboard').setDescription('Show the counting game leaderboard').setDescriptionLocalizations(localized('fun.slash.count.sub.leaderboard.description')),
    ),
  category: 'Fun',

  async execute(interaction) {
    try {
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) {
        logger.warn('Count command defer failed', { userId: interaction.user.id, guildId: interaction.guildId });
        return;
      }

      // Every answer here is ephemeral: the user's Discord language.
      const tr = replyText(interaction);
      // Access: utils/commandGate.js (status + leaderboard for everyone, the rest Administrator).
      const guildId = interaction.guildId;
      const subcommand = interaction.options.getSubcommand();
      const config = await getCountingGameConfig(interaction.client, guildId);

      if (subcommand === 'setup') {
        const channel = interaction.options.getChannel('channel');
        const system = interaction.options.getString('system');
        if (!channel || channel.type !== ChannelType.GuildText) {
          return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('fun.count.textChannel') });
        }

        if (config.enabled && config.channelId && config.channelId !== channel.id) {
          return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('fun.count.alreadyActive', { channelId: config.channelId }) });
        }

        await activateCountingGame(interaction.client, guildId, channel.id, system);
        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [
            successEmbed(
              tr.t('fun.count.onTitle'),
              tr.t('fun.count.onText', { channel: String(channel), system: getCountingSystemLabel(system) }),
            ),
          ],
        });
      }

      if (subcommand === 'disable') {
        if (!config.enabled) {
          return await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed(tr.t('fun.count.offTitle'), tr.t('fun.count.alreadyOff'))],
          });
        }

        await disableCountingGame(interaction.client, guildId);
        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [successEmbed(tr.t('fun.count.offTitle'), tr.t('fun.count.turnedOff'))],
        });
      }

      if (subcommand === 'status') {
        const fields = [
          { name: tr.t('fun.count.status.enabled'), value: config.enabled ? tr.t('fun.count.status.yes') : tr.t('fun.count.status.no'), inline: true },
          { name: tr.t('fun.count.status.channel'), value: config.channelId ? `<#${config.channelId}>` : tr.t('fun.count.status.notConfigured'), inline: true },
          { name: tr.t('fun.count.status.system'), value: getCountingSystemLabel(config.system), inline: true },
          { name: tr.t('fun.count.status.next'), value: getExpectedCountValue(config), inline: true },
          { name: tr.t('fun.count.status.streak'), value: `${config.currentStreak}`, inline: true },
          { name: tr.t('fun.count.status.best'), value: `${config.bestStreak || 0}`, inline: true },
          { name: tr.t('fun.count.status.last'), value: config.lastUserId ? `<@${config.lastUserId}>` : tr.t('fun.count.status.none'), inline: true },
        ];

        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [
            createEmbed({
              title: tr.t('fun.count.status.title'),
              description: tr.t('fun.count.status.description'),
              fields,
              color: 'primary',
            }),
          ],
        });
      }

      if (subcommand === 'reset') {
        if (!config.enabled) {
          return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('fun.count.enableFirst') });
        }

        const startNumber = interaction.options.getInteger('start') || 1;
        await resetCountingGame(interaction.client, guildId, startNumber);

        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [
            successEmbed(
              tr.t('fun.count.resetTitle'),
              tr.t('fun.count.resetText', { start: startNumber, channelId: config.channelId }),
            ),
          ],
        });
      }

      if (subcommand === 'leaderboard') {
        const leaderboard = buildCountingLeaderboard(config, interaction.guild);

        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [
            createEmbed({
              title: tr.t('fun.count.leaderboardTitle'),
              description: leaderboard.length > 0 ? leaderboard.join('\n') : tr.t('fun.count.leaderboardEmpty'),
              color: 'primary',
            }),
          ],
        });
      }

      return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('fun.count.invalidAction') });
    } catch (error) {
      logger.error('Count command error:', error);
      return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('fun.count.failed') });
    }
  },
};
