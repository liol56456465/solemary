import { Events } from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { applyMutedOverwrite, findMutedRole } from '../services/enforcement/muteService.js';
import { isEnforcementDbAvailable } from '../services/enforcement/db.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ChannelCreate,
  once: false,

  // New channels get the muted-role deny overwrite so muted members stay muted there.
  async execute(channel) {
    if (!channel.guild || channel.guild.id !== enforcementConfig.mainGuildId || !isEnforcementDbAvailable()) {
      return;
    }

    try {
      const role = await findMutedRole(channel.guild);
      if (role) {
        await applyMutedOverwrite(channel, role);
      }
    } catch (error) {
      logger.warn(`Could not apply muted overwrite to new channel ${channel.id}: ${error.message}`);
    }
  },
};
