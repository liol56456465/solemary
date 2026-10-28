import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { endTempRoles } from '../services/members/tempRoleService.js';

// A ban ends the member's temporary roles, so they are not given back if they are unbanned
// and rejoin before the end time.
export default {
  name: Events.GuildBanAdd,
  once: false,

  async execute(ban) {
    try {
      if (!ban.guild || !ban.user) return;
      await endTempRoles(ban.guild.id, ban.user.id);
    } catch (error) {
      logger.warn(`Could not end temporary roles after a ban of ${ban.user?.id}: ${error.message}`);
    }
  }
};
