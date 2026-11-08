import { MessageFlags } from 'discord.js';
import { createEmbed, successEmbed } from '../utils/embeds.js';
import { performDeletionByCounterId } from '../commands/ServerStats/modules/serverstats_delete.js';
import { logger } from '../utils/logger.js';
import { ErrorTypes, replyUserError, handleInteractionError } from '../utils/errorHandler.js';
import { textForInteraction } from '../utils/botText.js';

export const counterDeleteActionHandler = {
  name: 'counter-delete',
  async execute(interaction, client, args = []) {
    const tr = textForInteraction(interaction); // ephemeral panel: the clicker's Discord language
    try {
      
      try {
        await interaction.deferUpdate();
      } catch (error) {
        logger.error("Failed to defer button interaction:", error);
        return;
      }

      const [action, counterId, ownerId] = args;

      if (!interaction.inGuild()) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('serverstats.error.serverOnly') }).catch(logger.error);
        return;
      }

      if (!action || !counterId) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('serverstats.error.actionMissing') }).catch(logger.error);
        return;
      }

      if (ownerId && interaction.user.id !== ownerId) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('serverstats.error.notYours') }).catch(logger.error);
        return;
      }

      if (action === 'cancel') {
        await interaction.editReply({
          embeds: [createEmbed({
            title: tr.t('serverstats.delete.cancelledTitle'),
            description: tr.t('serverstats.delete.cancelledBody'),
            color: 'error'
          })],
          components: []
        }).catch(logger.error);
        return;
      }

      if (action !== 'confirm') {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('serverstats.error.unknownAction') }).catch(logger.error);
        return;
      }

      const { message } = await performDeletionByCounterId(client, interaction.guild, counterId, { lang: tr.lang });

      await interaction.editReply({
        embeds: [successEmbed(tr.t('serverstats.success'), message)],
        components: []
      }).catch(logger.error);
    } catch (error) {
      await handleInteractionError(interaction, error, {
        type: 'button',
        handler: 'counter_delete',
        customId: interaction.customId,
      });
    }
  }
};

export default counterDeleteActionHandler;