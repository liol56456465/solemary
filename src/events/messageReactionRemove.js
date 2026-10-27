import { Events } from 'discord.js';
import { handleStarReaction } from '../services/community/starboardService.js';

export default {
  name: Events.MessageReactionRemove,
  once: false,

  async execute(reaction, user) {
    await handleStarReaction(reaction, user);
  }
};
