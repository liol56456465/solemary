// A new invite: invite tracking adds it to the server's use cache (services/invites/inviteCache.js),
// only where the feature is on and the cache is loaded. Logging the creation is done by the audit
// log logger (services/auditLogLogging.js), not here: no second log line.

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { noteInviteCreate } from '../services/invites/inviteCache.js';
import { inviteTrackingOn } from '../services/invites/inviteStats.js';

export default {
  name: Events.InviteCreate,
  once: false,

  async execute(invite) {
    try {
      if (!invite?.guild?.id || !inviteTrackingOn(invite.guild.id)) return;
      await noteInviteCreate(invite);
    } catch (error) {
      logger.warn(`inviteCreate not handled: ${error.message}`);
    }
  },
};
