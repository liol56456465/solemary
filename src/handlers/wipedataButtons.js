import { createEmbed, successEmbed } from '../utils/embeds.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';

import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { WIPE_ITEMS, wipeMemberData } from '../services/wipedataService.js';
import { replyText } from '../commands/Core/modules/commandText.js';
import { wipeItemLabel } from '../commands/Utility/wipedata.js';
const wipedataConfirmHandler = {
  name: 'wipedata_yes',
  async execute(interaction, client) {
    // deferUpdate so the result replaces the confirmation prompt (and its buttons)
    // instead of leaving a live "Confirm" button behind a second reply.
    try {
      await interaction.deferUpdate();
    } catch (error) {
      logger.error('Wipedata: could not acknowledge the button:', error);
      return;
    }
    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    // A private answer: the user's language.
    const tr = replyText(interaction);
    try {
      const { deleted, failed } = await wipeMemberData(client, guildId, userId);
      const label = (id) => wipeItemLabel(id, tr);
      // Leftovers of removed features (economy, AFK) are deleted but not named.
      const shown = (ids) => ids.filter((id) => !WIPE_ITEMS.find((item) => item.id === id)?.legacy);
      if (failed.length > 0) {
        for (const { id, error } of failed) logger.error(`Wipedata: deleting ${id} failed for ${userId} in ${guildId}: ${error.message}`);
        await interaction.editReply({
          embeds: [createEmbed({
            title: tr.t('utility.wipedata.partialTitle'),
            description: tr.t('utility.wipedata.partialFailed', { items: failed.map(({ id }) => label(id)).join(', ') })
              + (deleted.length ? tr.t('utility.wipedata.partialDeleted', { items: deleted.map(label).join(', ') }) : '')
              + tr.t('utility.wipedata.partialRetry'),
            color: 'error',
          })],
          components: [],
        });
        return;
      }
      await interaction.editReply({
        embeds: [successEmbed(tr.t('utility.wipedata.doneTitle'), tr.t('utility.wipedata.done', { items: shown(deleted).map(label).join(', ') || tr.t('utility.wipedata.nothingStored') }))],
        components: [],
      });
      logger.info(`User ${userId} wiped their data in guild ${guildId}`);
    } catch (error) {
      logger.error('Wipedata confirm button handler error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.wipedata.failed') });
    }
  }
};

const wipedataCancelHandler = {
  name: 'wipedata_no',
  async execute(interaction, client) {
    const tr = replyText(interaction);
    try {
      await interaction.update({
        embeds: [
          createEmbed({
            title: tr.t('utility.wipedata.cancelledTitle'),
            description: tr.t('utility.wipedata.cancelled'),
            color: 'info'
          })
        ],
        components: []
      });

      logger.info(`User ${interaction.user.tag} (${interaction.user.id}) cancelled data wipe in guild ${interaction.guildId}`);
    } catch (error) {
      logger.error('Wipedata cancel button handler error:', error);
      
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.wipedata.cancelFailed') });
      }
    }
  }
};

export { wipedataConfirmHandler, wipedataCancelHandler };