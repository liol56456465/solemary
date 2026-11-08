import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { enforcementConfig } from '../config/enforcement.js';
import { checkImpersonation } from '../services/automod/memberChecks.js';

export default {
  name: Events.UserUpdate,
  once: false,

  async execute(oldUser, newUser) {
    try {
      if (oldUser.bot) return;

      if (oldUser.username !== newUser.username || oldUser.globalName !== newUser.globalName) {
        // Main server as before (fetched if not cached); other servers only where the member is
        // cached (no fetch per server). checkImpersonation returns at once where automod is off.
        const mainGuild = newUser.client.guilds.cache.get(enforcementConfig.mainGuildId);
        const member = mainGuild && await mainGuild.members.fetch(newUser.id).catch(() => null);
        if (member) await checkImpersonation(member);
        for (const guild of newUser.client.guilds.cache.values()) {
          if (guild.id === enforcementConfig.mainGuildId) continue;
          const other = guild.members.cache.get(newUser.id);
          if (other) await checkImpersonation(other);
        }
      }

      const usernameChanged = oldUser.username !== newUser.username;
      const discriminatorChanged = oldUser.discriminator !== newUser.discriminator;

      if (!usernameChanged && !discriminatorChanged) return;

      const fields = [];

      if (usernameChanged) {
        fields.push({
          name: 'Old username',
          value: oldUser.username,
          inline: true
        });
        fields.push({
          name: 'New username',
          value: newUser.username,
          inline: true
        });
      }

      if (discriminatorChanged) {
        fields.push({
          name: 'Old tag',
          value: `#${oldUser.discriminator}`,
          inline: true
        });
        fields.push({
          name: 'New tag',
          value: `#${newUser.discriminator}`,
          inline: true
        });
      }

      const guilds = [...newUser.client.guilds.cache.values()];
      for (const guild of guilds) {
        if (!guild.members.cache.has(newUser.id)) continue;

        await logEvent({
          client: newUser.client,
          guildId: guild.id,
          eventType: EVENT_TYPES.MEMBER_NAME_CHANGE,
          data: {
            description: `${newUser.tag} changed their username`,
            userId: newUser.id,
            fields: [
              {
                name: 'User',
                value: `${newUser.tag} (${newUser.id})`,
                inline: true
              },
              ...fields
            ]
          }
        });
      }

      logger.debug(`Processed userUpdate for ${newUser.id} across ${guilds.length} guild(s)`);
    } catch (error) {
      logger.error('Error in userUpdate event:', error);
    }
  }
};