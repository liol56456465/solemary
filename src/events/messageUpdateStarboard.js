import { Events } from 'discord.js';
import { handleStarSourceEdit } from '../services/community/starboardService.js';

// Second MessageUpdate listener (logging and automod live in messageUpdate.js).
export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(oldMessage, newMessage) {
    await handleStarSourceEdit(newMessage);
  }
};
