import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { getColor } from '../../config/bot.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';
export default {
    data: new SlashCommandBuilder()
    .setName("lock")
    .setDescription(
      "Locks the current channel (prevents @everyone from sending messages).",
    )
    .setDescriptionLocalizations(descriptionLocalizations('moderation.lock.cmd.description'))
.setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  category: "moderation",

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn(`Lock interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'lock'
      });
      return;
    }

    // Errors: the moderator's language; the lock notice is posted in the channel: the server's language.
    const tr = textForInteraction(interaction);
    const pub = textForInteraction(interaction, { purpose: 'public' });
    const channel = interaction.channel;
    const everyoneRole = interaction.guild.roles.everyone;

    try {
      const currentPermissions = channel.permissionsFor(everyoneRole);
      if (currentPermissions.has(PermissionFlagsBits.SendMessages) === false) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('moderation.lock.already', { channel: String(channel) }) });
      }

      await channel.permissionOverwrites.edit(
        everyoneRole,
        { SendMessages: false },
{ type: 0, reason: `Channel locked by ${interaction.user.tag}` },
      );

      await logEvent({
        client,
        guild: interaction.guild,
        event: {
          action: "Channel Locked",
          target: channel.toString(),
          executor: `${interaction.user.tag} (${interaction.user.id})`,
          metadata: {
            channelId: channel.id,
            category: channel.parent?.name || 'None',
            moderatorId: interaction.user.id
          }
        }
      });

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(
            pub.t('moderation.lock.title'),
            pub.t('moderation.lock.done', { channel: String(channel) }),
          ),
        ],
      });
    } catch (error) {
      logger.error('Lock command error:', error);
      await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('moderation.lock.failed') });
    }
  }
};