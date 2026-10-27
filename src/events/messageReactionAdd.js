import { Events } from 'discord.js';
import { handleReportReaction } from '../services/automod/memberChecks.js';

export default {
  name: Events.MessageReactionAdd,
  once: false,

  async execute(reaction, user) {
    // Member reports by flag reaction; reaction roles use their own handler.
    await handleReportReaction(reaction, user);
  }
};
