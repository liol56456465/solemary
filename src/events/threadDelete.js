import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { threadLines } from '../utils/logging/channelLogLines.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ThreadDelete,
  once: false,

  async execute(thread) {
    try {
      if (!thread.guild) return;
      await logEvent({
        client: thread.client,
        guildId: thread.guild.id,
        eventType: EVENT_TYPES.THREAD_DELETE,
        // The thread itself is gone, so the ignore check uses its parent channel.
        data: { title: 'Thread Deleted', headline: `**${thread.name}** was deleted`, lines: threadLines(thread), channelId: thread.parentId || thread.id },
      });
    } catch (error) {
      logger.debug(`Thread delete log failed: ${error.message}`);
    }
  },
};
