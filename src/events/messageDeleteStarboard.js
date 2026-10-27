import { Events } from 'discord.js';
import { handleStarMessageDelete } from '../services/community/starboardService.js';

// Second MessageDelete listener (logging and reaction-role cleanup live in messageDelete.js).
export default {
  name: Events.MessageDelete,
  once: false,

  async execute(message) {
    await handleStarMessageDelete(message);
  }
};
