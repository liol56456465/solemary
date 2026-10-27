import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { handleAuditLogEntry } from '../services/automod/staffGuardService.js';

export default {
  name: Events.GuildAuditLogEntryCreate,
  once: false,

  async execute(entry, guild) {
    try {
      await handleAuditLogEntry(entry, guild);
    } catch (error) {
      logger.error('Staff guard failed on an audit log entry:', error);
    }
  }
};
