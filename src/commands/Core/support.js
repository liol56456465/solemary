import { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { inviteOrNull, siteOrigin } from '../../services/site/shell.js';

// The same invite the website and the DMs use (setting supportServerInvite, dashboard-editable).
const FALLBACK_INVITE = 'https://discord.gg/7Ckv9Bt577';
/** Privacy Policy and Terms links on the website (PUBLIC_URL), or [] when it is not set. */
export function legalLinks(env = process.env) {
  const origin = siteOrigin(env);
  return origin ? [['Privacy Policy', `${origin}/privacy`], ['Terms', `${origin}/terms`]] : [];
}

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

      const actionRow = new ActionRowBuilder().addComponents(
        supportButton,
        ...legalLinks().map(([label, url]) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url)),
      );

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