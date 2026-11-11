import { Events } from 'discord.js';
import { handleDeletedMessages } from '../services/logTamperService.js';

// A Mewvo log message deleted by someone else comes back (services/logTamperService.js).
export default {
  name: Events.MessageDelete,
  once: false,

  async execute(message) {
    if (!message.guild) return;
    await handleDeletedMessages(message.client, message.guild, message.channel, [message]);
  }
};
