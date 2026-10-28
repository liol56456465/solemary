import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { checkImpersonation } from '../services/automod/memberChecks.js';
import { endTempRoles } from '../services/members/tempRoleService.js';

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  async execute(oldMember, newMember) {
    try {
      if (!newMember.guild) return;

      // A role taken off in Discord ends its timer, so a rejoin does not give it back.
      // A partial old member has no role list to compare with; nothing to do then.
      if (!oldMember.partial) {
        const removed = [...oldMember.roles.cache.keys()].filter((id) => !newMember.roles.cache.has(id));
        if (removed.length) {
          await endTempRoles(newMember.guild.id, newMember.id, removed).catch((error) => {
            logger.warn(`Could not end temporary roles for ${newMember.id}: ${error.message}`);
          });
        }
      }

      if (oldMember.nickname !== newMember.nickname) {
        await checkImpersonation(newMember);
      }

      if (oldMember.nickname !== newMember.nickname) {
        await logEvent({
          client: newMember.client,
          guildId: newMember.guild.id,
          eventType: EVENT_TYPES.MEMBER_NAME_CHANGE,
          data: {
            title: 'Nickname changed',
            lines: [
              `**User:** ${newMember.user.toString()} (${newMember.user.tag})`,
              `**ID:** \`${newMember.user.id}\``,
              `**Before:** ${oldMember.nickname || '*(no nickname)*'}`,
              `**After:** ${newMember.nickname || '*(no nickname)*'}`,
            ],
            thumbnail: newMember.user.displayAvatarURL({ dynamic: true }),
            userId: newMember.user.id,
          }
        });

        return;
      }

    } catch (error) {
      logger.error('Error in guildMemberUpdate event:', error);
    }
  }
};