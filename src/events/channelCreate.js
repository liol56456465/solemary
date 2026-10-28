import { Events } from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { applyMutedOverwrite, findMutedRole } from '../services/enforcement/muteService.js';
import { isEnforcementDbAvailable } from '../services/enforcement/db.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { channelLines } from '../utils/logging/channelLogLines.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ChannelCreate,
  once: false,

  async execute(channel) {
    if (!channel.guild) return;

    await logEvent({
      client: channel.client,
      guildId: channel.guild.id,
      eventType: EVENT_TYPES.CHANNEL_CREATE,
      data: { title: 'Channel Created', headline: `${channel.toString()} was created`, lines: channelLines(channel), channelId: channel.id },
    }).catch((error) => logger.debug(`Channel create log failed: ${error.message}`));

    // New channels get the muted-role deny overwrite so muted members stay muted there.
    if (channel.guild.id !== enforcementConfig.mainGuildId || !isEnforcementDbAvailable()) {
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
