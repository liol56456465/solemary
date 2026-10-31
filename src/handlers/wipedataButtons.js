import { createEmbed, successEmbed } from '../utils/embeds.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';

import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { WIPE_ITEMS, wipeMemberData } from '../services/wipedataService.js';
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
    try {
      const { deleted, failed } = await wipeMemberData(client, guildId, userId);
      const label = (id) => WIPE_ITEMS.find((item) => item.id === id)?.label || id;
      if (failed.length > 0) {
        for (const { id, error } of failed) logger.error(`Wipedata: deleting ${id} failed for ${userId} in ${guildId}: ${error.message}`);
        await interaction.editReply({
          embeds: [createEmbed({
            title: 'Not everything was deleted',
            description: `The database did not respond for: ${failed.map(({ id }) => label(id)).join(', ')}. `
              + (deleted.length ? `Deleted: ${deleted.map(label).join(', ')}. ` : '')
              + 'Run /wipedata again in a few minutes.',
            color: 'error',
          })],
          components: [],
        });
        return;
      }
      await interaction.editReply({
        embeds: [successEmbed('Your data was deleted', `Deleted in this server: ${deleted.map(label).join(', ')}.\n\n`
          + 'Moderation, appeal, report and verification records are kept, because they are the server\'s safety records. '
          + 'See the Privacy Policy for how to ask about those.')],
        components: [],
      });
      logger.info(`User ${userId} wiped their data in guild ${guildId}`);
    } catch (error) {
      logger.error('Wipedata confirm button handler error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'The database is not responding. Nothing may have been deleted; try again in a few minutes.' });
    }
  }
};

const wipedataCancelHandler = {
  name: 'wipedata_no',
  async execute(interaction, client) {
    try {
      await interaction.update({
        embeds: [
          createEmbed({
            title: 'Nothing was deleted',
            description: 'Your data is unchanged.',
            color: 'info'
          })
        ],
        components: []
      });

      logger.info(`User ${interaction.user.tag} (${interaction.user.id}) cancelled data wipe in guild ${interaction.guildId}`);
    } catch (error) {
      logger.error('Wipedata cancel button handler error:', error);
      
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not cancel data wipe.' });
      }
    }
  }
};

export { wipedataConfirmHandler, wipedataCancelHandler };