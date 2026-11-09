import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';
import { PURGE_MAX, PURGE_MIN, TOOL_PERMS, missingBotPerms } from '../../services/channelToolsService.js';
import { previewText, purgeButtons, purgePreviews, splitByAge } from '../../services/moderation/purgePreview.js';

const NO_MENTIONS = Object.freeze({ parse: [] });

// /purge shows a preview first (services/moderation/purgePreview.js); the Delete button
// (interactions/buttons/moderation/purge.js) deletes exactly the previewed messages.
export default {
    data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete a specific amount of messages")
    .setDescriptionLocalizations(descriptionLocalizations('moderation.purge.cmd.description'))
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Number of messages (1-100)")
        .setDescriptionLocalizations(descriptionLocalizations('moderation.purge.cmd.amount'))
        .setRequired(true),
    )
.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  category: "moderation",
  abuseProtection: { maxAttempts: 5, windowMs: 60_000 },

  async execute(interaction, config, client, { previews = purgePreviews, now = Date.now() } = {}) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });
    if (!deferSuccess) {
      logger.warn(`Purge interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'purge'
      });
      return;
    }

    const tr = textForInteraction(interaction); // ephemeral: the moderator's language
    const amount = interaction.options.getInteger("amount");
    const channel = interaction.channel;

    if (!Number.isInteger(amount) || amount < PURGE_MIN || amount > PURGE_MAX)
      return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('moderation.purge.range') });

    const missing = missingBotPerms(interaction.guild, channel, TOOL_PERMS.purge);
    if (missing.length) {
      return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('moderation.purge.botMissing', { perms: missing.join(', '), channel: String(channel) }) });
    }

    try {
      const fetched = await channel.messages.fetch({ limit: amount });
      const { fresh, old } = splitByAge([...fetched.values()], now);
      if (!fresh.length) {
        const message = old.length
          ? tr.tp('moderation.purge.allTooOld', old.length)
          : tr.t('moderation.purge.empty', { channel: String(channel) });
        return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message });
      }

      const { nonce, expiresAt } = previews.create({
        guildId: interaction.guildId, channelId: channel.id, userId: interaction.user.id, requested: amount, fresh, old,
      }, now);

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({
          title: tr.t('moderation.purge.previewTitle'),
          description: previewText(tr, { fresh: fresh.length, old: old.length, channel, expiresAt }),
          color: 'warning',
        })],
        components: [purgeButtons(nonce, tr)],
        allowedMentions: NO_MENTIONS,
      });
    } catch (error) {
      logger.error('Purge command error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('moderation.purge.failed') });
    }
  }
};
