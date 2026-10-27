import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { channelUpdateLines } from '../utils/logging/channelLogLines.js';
import { logger } from '../utils/logger.js';

// Server log: a channel's name, topic, category, slowmode, age restriction, user limit
// or permission overwrites changed. Position-only moves are not logged.
export default {
  name: Events.ChannelUpdate,
  once: false,

  async execute(before, after) {
    try {
      if (!after.guild) return;
      const lines = channelUpdateLines(before, after);
      if (!lines.length) return;
      await logEvent({
        client: after.client,
        guildId: after.guild.id,
        eventType: EVENT_TYPES.CHANNEL_UPDATE,
        data: { title: 'Channel Updated', headline: `${after.toString()} was changed`, lines, channelId: after.id },
      });
    } catch (error) {
      logger.debug(`Channel update log failed: ${error.message}`);
    }
  },
};
