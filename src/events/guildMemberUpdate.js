import { Events } from 'discord.js';
import { hasIntent } from '../config/intents.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { checkImpersonation } from '../services/automod/memberChecks.js';
import { endTempRoles } from '../services/members/tempRoleService.js';
import { applyRoleRulesToMember } from '../services/members/roleRuleService.js';
import { isEnforcementDbAvailable } from '../services/enforcement/db.js';
import { handleMemberUpdate as mirrorRoles } from '../services/homeServers/roleMirror.js';

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  async execute(oldMember, newMember) {
    // Discord sends no member events without the Guild Members intent; a cheap guard all the same
    // (welcome, join gate, member logs, mute re-apply, role and level rules: warned at startup).
    if (!hasIntent('GuildMembers')) return;
    try {
      if (!newMember.guild) return;

      // Home-server role mirror: a source-role change in MAIN updates support/database (never throws;
      // changes there come back here and are ignored, so it cannot loop).
      void mirrorRoles(oldMember, newMember);

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

      // Role rules with a "has role" trigger (dashboard Members): only when the roles changed
      // (or are unknown). The bot's own change comes back here and finds nothing to do.
      const rolesChanged = oldMember.partial || oldMember.roles.cache.size !== newMember.roles.cache.size
        || [...newMember.roles.cache.keys()].some((id) => !oldMember.roles.cache.has(id));
      if (rolesChanged && isEnforcementDbAvailable()) {
        await applyRoleRulesToMember(newMember, { triggers: ['has_role'] }).catch((error) => {
          logger.warn(`Role rules not applied to ${newMember.id}: ${error.message}`);
        });
      }

      if (oldMember.nickname !== newMember.nickname) {
        await checkImpersonation(newMember);
      }

      // A partial old member (not cached, Partials.GuildMember) has no known nickname: checking
      // impersonation is fine, but logging "Before: (no nickname)" would be wrong.
      if (!oldMember.partial && oldMember.nickname !== newMember.nickname) {
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