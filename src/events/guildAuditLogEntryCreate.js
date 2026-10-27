import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { handleAuditLogEntry } from '../services/automod/staffGuardService.js';
import { logAuditEntry } from '../services/auditLogLogging.js';

export default {
  name: Events.GuildAuditLogEntryCreate,
  once: false,

  async execute(entry, guild) {
    try {
      await handleAuditLogEntry(entry, guild);
    } catch (error) {
      logger.error('Staff guard failed on an audit log entry:', error);
    }
    // Server log: emoji, stickers, scheduled events, webhooks, invites, AutoMod rules.
    await logAuditEntry(entry, guild);
  }
};
