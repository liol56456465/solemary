import { Events } from 'discord.js';
import { handleDeletedMessages } from '../services/logTamperService.js';

// Bulk deletes (purge, "delete messages" on a ban) in a log channel (services/logTamperService.js).
export default {
  name: Events.MessageBulkDelete,
  once: false,

  async execute(messages, channel) {
    if (!channel?.guild) return;
    await handleDeletedMessages(channel.client, channel.guild, channel, [...messages.values()], { bulk: true });
  }
};
