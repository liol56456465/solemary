import { Events } from 'discord.js';
import { handleReportReaction } from '../services/automod/memberChecks.js';
import { handleStarReaction } from '../services/community/starboardService.js';

export default {
  name: Events.MessageReactionAdd,
  once: false,

  async execute(reaction, user) {
    // Member reports by flag reaction; reaction roles use their own handler.
    await handleReportReaction(reaction, user);
    await handleStarReaction(reaction, user);
  }
};
