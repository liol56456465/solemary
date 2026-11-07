// The bot was removed from a server (or the server was deleted). Log only: the server's data is
// kept until the server asks for it to be deleted (owner decision, multi-server B2). Nothing here
// may delete or change stored data. An outage (guild.available === false) is not a removal.

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildDelete,
  async execute(guild) {
    try {
      if (guild?.available === false) {
        logger.warn('Guild unavailable (Discord outage); nothing changed', { event: 'guild.unavailable', guildId: guild.id });
        return;
      }
      logger.info('Bot left guild; its data is kept', {
        event: 'guild.delete',
        guildId: guild?.id,
        guildName: guild?.name,
        memberCount: guild?.memberCount,
      });
    } catch (error) {
      logger.error(`Error logging guild ${guild?.id} leave:`, error);
    }
  },
};
