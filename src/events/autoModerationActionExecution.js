import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { handleNativeExecution } from '../services/automod/nativeBridge.js';

// Discord's own AutoMod acted (needs the AutoModerationExecution intent and Manage
// Server). Bridged into the review flow by services/automod/nativeBridge.js.
export default {
  name: Events.AutoModerationActionExecution,
  once: false,

  async execute(execution) {
    try {
      await handleNativeExecution(execution);
    } catch (error) {
      logger.error('Native AutoMod bridge failed:', error);
    }
  }
};
