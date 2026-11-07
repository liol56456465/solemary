import { PermissionsBitField, ChannelType, MessageFlags } from 'discord.js';
import { setLogChannel } from '../../../services/loggingService.js';
import { successEmbed } from '../../../utils/embeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
const DESTINATION_LABELS = {
  audit: 'Audit Log',
  applications: 'Applications',
  reports: 'Reports',
};

export default {
  prefixOnly: false,
  async execute(interaction, config, client) {
    try {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Server** permissions to configure logging channels.' });
      }

      await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

      const destination = interaction.options.getString('destination');
      const channel = interaction.options.getChannel('channel');
      const disable = interaction.options.getBoolean('disable') ?? false;

      if (disable) {
        if (!(await setLogChannel(client, interaction.guildId, destination, null))) {
          return await replyUserError(interaction, { type: ErrorTypes.DATABASE, message: 'Couldn\'t clear the log channel. Try again.' });
        }
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [successEmbed(
            'Channel cleared',
            `The **${DESTINATION_LABELS[destination]}** channel has been removed.`,
          )],
        });
      }

      // Announcement channels work too: the bot posts there like in a text channel.
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Pick a text or announcement channel.' });
      }

      const botPerms = channel.permissionsFor(interaction.guild.members.me);
      if (!botPerms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
        return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: `I need **View Channel**, **Send Messages**, and **Embed Links** in ${channel}.` });
      }

      if (!(await setLogChannel(client, interaction.guildId, destination, channel.id))) {
        return await replyUserError(interaction, { type: ErrorTypes.DATABASE, message: 'Couldn\'t save the log channel. Try again.' });
      }

      return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
          'Channel updated',
          `**${DESTINATION_LABELS[destination]}** logs will be sent to ${channel}.\nUse \`/logging dashboard\` to toggle event categories.`,
        )],
      });
    } catch (error) {
      logger.error('logging_channel error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to update the log channel.' });
    }
  },
};
