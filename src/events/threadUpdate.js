import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { threadUpdateLines } from '../utils/logging/channelLogLines.js';
import { logger } from '../utils/logger.js';

// Server log: a thread was archived or reopened, locked or unlocked, or renamed.
export default {
  name: Events.ThreadUpdate,
  once: false,

  async execute(before, after) {
    try {
      if (!after.guild) return;
      const lines = threadUpdateLines(before, after);
      if (!lines.length) return;
      await logEvent({
        client: after.client,
        guildId: after.guild.id,
        eventType: EVENT_TYPES.THREAD_UPDATE,
        data: { title: after.archived && !before.archived ? 'Thread Archived' : 'Thread Updated', headline: `${after.toString()} in <#${after.parentId}>`, lines, channelId: after.id },
      });
    } catch (error) {
      logger.debug(`Thread update log failed: ${error.message}`);
    }
  },
};
