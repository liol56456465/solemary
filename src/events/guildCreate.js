import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { welcomeOnJoin } from '../services/setup/joinWelcome.js';
import { warmInviteCache } from '../services/invites/invitePage.js';
import { inviteTrackingOn } from '../services/invites/inviteStats.js';

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
      // Invite tracking (off by default; a server that comes back keeps its settings): load the
      // invite use cache in the background. Never throws.
      if (inviteTrackingOn(guild.id)) warmInviteCache(guild);
    } catch (error) {
      logger.error(`Error initializing guild ${guild?.id} on join:`, error);
    }
  },
};
