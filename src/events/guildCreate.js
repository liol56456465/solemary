import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { welcomeOnJoin } from '../services/setup/joinWelcome.js';

export default {
  name: Events.GuildCreate,
  async execute(guild, client) {
    try {
      logger.info('Bot joined guild', {
        event: 'guild.create',
        guildId: guild.id,
        guildName: guild.name,
        memberCount: guild.memberCount,
      });

      // Initialises the guild config (as before) and posts the welcome (services/setup/joinWelcome.js).
      // Never throws; a send error is one log line.
      await welcomeOnJoin(guild, client);
    } catch (error) {
      logger.error(`Error initializing guild ${guild?.id} on join:`, error);
    }
  },
};
