import { MessageFlags, PermissionsBitField } from 'discord.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { getIgnoreList, updateIgnoreList } from '../../../services/loggingService.js';
import { createEmbed, successEmbed } from '../../../utils/embeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';
import { textForInteraction } from '../../../utils/botText.js';

// /logging ignore channel|role (toggle) and /logging ignore list.
// A channel covers its threads, and a category the channels in it; a role skips logs
// about members who have it (as the subject or the one who did it).

function listText(ids, format, empty) {
  return ids.length ? ids.map(format).join('\n').slice(0, 1024) : empty;
}

export default {
  prefixOnly: false,
  async execute(interaction, config, client) {
    const tr = textForInteraction(interaction); // ephemeral: the admin's Discord language
    try {
      if (!hasAdminAccess(interaction)) {
        return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('logging.ignore.noAdmin') });
      }
      await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      const sub = interaction.options.getSubcommand();

      if (sub === 'list') {
        const ignore = getIgnoreList(await getGuildConfig(client, interaction.guildId));
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [createEmbed({
            title: tr.t('logging.ignore.listTitle'),
            fields: [
              { name: tr.t('logging.ignore.channels'), value: listText(ignore.channels, (id) => `<#${id}>`, tr.t('logging.ignore.none')) },
              { name: tr.t('logging.ignore.roles'), value: listText(ignore.roles, (id) => `<@&${id}>`, tr.t('logging.ignore.none')) },
              { name: tr.t('logging.ignore.users'), value: listText(ignore.users, (id) => `<@${id}>`, tr.t('logging.ignore.none')) },
            ],
            footer: { text: tr.t('logging.ignore.listFooter') },
            color: 'info',
          })],
        });
      }

      const target = sub === 'role' ? interaction.options.getRole('role', true) : interaction.options.getChannel('channel', true);
      if (sub === 'role' && target.id === interaction.guildId) {
        return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('logging.ignore.everyone') });
      }
      const result = {};
      if (!(await updateIgnoreList(client, interaction.guildId, { action: 'toggle', type: sub, id: target.id }, result))) {
        return await replyUserError(interaction, { type: ErrorTypes.DATABASE, message: tr.t('logging.ignore.saveFailed') });
      }
      const mention = sub === 'role' ? `<@&${target.id}>` : `<#${target.id}>`;
      const skipped = sub === 'role' ? tr.t('logging.ignore.skippedRole', { mention }) : tr.t('logging.ignore.skippedChannel', { mention });
      return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
          result.added ? tr.t('logging.ignore.nowIgnored') : tr.t('logging.ignore.noLongerIgnored'),
          result.added ? skipped : tr.t('logging.ignore.loggedAgain', { mention }),
        )],
      });
    } catch (error) {
      logger.error('logging_ignore error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('logging.ignore.failed') });
    }
  },
};
