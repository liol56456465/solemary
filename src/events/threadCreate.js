import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { threadLines } from '../utils/logging/channelLogLines.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { isLogForumPost } from '../services/logForum.js';

export default {
  name: Events.ThreadCreate,
  once: false,

  // newlyCreated is false when the bot is merely added to an existing thread.
  async execute(thread, newlyCreated) {
    try {
      if (!thread.guild || newlyCreated === false) return;
      // Mewvo's own post in a log forum (Advanced logs) is not a server event worth a log line.
      if (thread.ownerId && thread.ownerId === thread.client.user?.id
        && isLogForumPost(thread, await getGuildConfig(thread.client, thread.guild.id).catch(() => null))) return;
      await logEvent({
        client: thread.client,
        guildId: thread.guild.id,
        eventType: EVENT_TYPES.THREAD_CREATE,
        data: { title: 'Thread created', headline: `${thread.toString()} was created`, lines: threadLines(thread), channelId: thread.id, userId: thread.ownerId || null },
      });
    } catch (error) {
      logger.debug(`Thread create log failed: ${error.message}`);
    }
  },
};
