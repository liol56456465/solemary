import { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { inviteOrNull } from '../../services/site/shell.js';

// The same invite the website and the DMs use (setting supportServerInvite, dashboard-editable).
const FALLBACK_INVITE = 'https://discord.gg/7Ckv9Bt577';
export function supportInviteUrl(config = enforcementConfig) {
  return inviteOrNull(config?.supportServerInvite) || FALLBACK_INVITE;
}
export default {
    data: new SlashCommandBuilder()
    .setName("support")
    .setDescription("Get link to the support server"),

  async execute(interaction) {
    try {
      const supportButton = new ButtonBuilder()
        .setLabel("Join Support Server")
        .setStyle(ButtonStyle.Link)
        .setURL(supportInviteUrl());

      const actionRow = new ActionRowBuilder().addComponents(supportButton);

      await InteractionHelper.safeReply(interaction, {
        embeds: [
          createEmbed({ title: "Need help?", description: "Join the Mewvo support server to ask questions, appeal, report bugs or suggest features." }),
        ],
        components: [actionRow],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error('Support command error:', error);
      
      try {
        return await InteractionHelper.safeReply(interaction, {
          embeds: [createEmbed({ title: 'System Error', description: 'Could not display support information.', color: 'error' })],
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        logger.error('Failed to send error reply:', replyError);
      }
    }
  },
};