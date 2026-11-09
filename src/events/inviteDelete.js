// An invite was deleted (by staff, expired, or used up): invite tracking keeps it in the cache for a
// minute, marked deleted, because Discord can send this before the join that used it up
// (services/invites/inviteCache.js). The deletion log line comes from services/auditLogLogging.js.

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { noteInviteDelete } from '../services/invites/inviteCache.js';

export default {
  name: Events.InviteDelete,
  once: false,

  async execute(invite) {
    try {
      if (!invite?.guild?.id) return;
      await noteInviteDelete(invite);
    } catch (error) {
      logger.warn(`inviteDelete not handled: ${error.message}`);
    }
  },
};
