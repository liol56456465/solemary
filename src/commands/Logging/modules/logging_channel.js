import { PermissionsBitField, ChannelType, MessageFlags } from 'discord.js';
import { setLogChannel } from '../../../services/loggingService.js';
import { successEmbed } from '../../../utils/embeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';
import { textForInteraction } from '../../../utils/botText.js';

// Ephemeral replies: the admin's Discord language.
function destinationLabel(tr, destination) {
  const labels = {
    audit: () => tr.t('logging.channel.destination.audit'),
    applications: () => tr.t('logging.channel.destination.applications'),
    reports: () => tr.t('logging.channel.destination.reports'),
  };
  return labels[destination] ? labels[destination]() : String(destination);
}

export default {
  prefixOnly: false,
  async execute(interaction, config, client) {
    const tr = textForInteraction(interaction);
    try {
      if (!hasAdminAccess(interaction)) {
        return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('logging.channel.noAdmin') });
      }

      await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

      const destination = interaction.options.getString('destination');
      const channel = interaction.options.getChannel('channel');
      const disable = interaction.options.getBoolean('disable') ?? false;

      if (disable) {
        if (!(await setLogChannel(client, interaction.guildId, destination, null))) {
          return await replyUserError(interaction, { type: ErrorTypes.DATABASE, message: tr.t('logging.channel.clearFailed') });
        }
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [successEmbed(
            tr.t('logging.channel.clearedTitle'),
            tr.t('logging.channel.cleared', { destination: destinationLabel(tr, destination) }),
          )],
        });
      }

      // Announcement channels work too: the bot posts there like in a text channel.
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('logging.channel.pickText') });
      }

      const botPerms = channel.permissionsFor(interaction.guild.members.me);
      if (!botPerms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
        return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('logging.channel.needPerms', { channel: String(channel) }) });
      }

      if (!(await setLogChannel(client, interaction.guildId, destination, channel.id))) {
        return await replyUserError(interaction, { type: ErrorTypes.DATABASE, message: tr.t('logging.channel.saveFailed') });
      }

      return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
          tr.t('logging.channel.updatedTitle'),
          tr.t('logging.channel.updated', { destination: destinationLabel(tr, destination), channel: String(channel) }),
        )],
      });
    } catch (error) {
      logger.error('logging_channel error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('logging.channel.failed') });
    }
  },
};
