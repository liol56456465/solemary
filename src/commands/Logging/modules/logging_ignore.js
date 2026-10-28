import { MessageFlags, PermissionsBitField } from 'discord.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { getIgnoreList, updateIgnoreList } from '../../../services/loggingService.js';
import { createEmbed, successEmbed } from '../../../utils/embeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';

// /logging ignore channel|role (toggle) and /logging ignore list.
// A channel covers its threads, and a category the channels in it; a role skips logs
// about members who have it (as the subject or the one who did it).

function listText(ids, format, empty) {
  return ids.length ? ids.map(format).join('\n').slice(0, 1024) : empty;
}

export default {
  prefixOnly: false,
  async execute(interaction, config, client) {
    try {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Server** permissions to change the logging ignore lists.' });
      }
      await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      const sub = interaction.options.getSubcommand();

      if (sub === 'list') {
        const ignore = getIgnoreList(await getGuildConfig(client, interaction.guildId));
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [createEmbed({
            title: 'Logging ignore lists',
            fields: [
              { name: 'Channels', value: listText(ignore.channels, (id) => `<#${id}>`, '*none*') },
              { name: 'Roles', value: listText(ignore.roles, (id) => `<@&${id}>`, '*none*') },
              { name: 'Users', value: listText(ignore.users, (id) => `<@${id}>`, '*none*') },
            ],
            footer: { text: 'Toggle with /logging ignore channel or /logging ignore role. Users: /logging dashboard → filters.' },
            color: 'info',
          })],
        });
      }

      const target = sub === 'role' ? interaction.options.getRole('role', true) : interaction.options.getChannel('channel', true);
      if (sub === 'role' && target.id === interaction.guildId) {
        return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Ignoring @everyone would turn member logs off: use the dashboard categories instead.' });
      }
      const result = {};
      if (!(await updateIgnoreList(client, interaction.guildId, { action: 'toggle', type: sub, id: target.id }, result))) {
        return await replyUserError(interaction, { type: ErrorTypes.DATABASE, message: 'Could not save the ignore list. Please try again.' });
      }
      const mention = sub === 'role' ? `<@&${target.id}>` : `<#${target.id}>`;
      const scope = sub === 'role' ? 'members with this role' : 'this channel (and its threads, or the channels in it for a category)';
      return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
          result.added ? 'Now ignored' : 'No longer ignored',
          result.added ? `Logs about ${scope} are skipped: ${mention}.` : `${mention} is logged again.`,
        )],
      });
    } catch (error) {
      logger.error('logging_ignore error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to update the ignore list.' });
    }
  },
};
