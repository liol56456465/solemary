import { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { inviteOrNull, siteOrigin } from '../../services/site/shell.js';
import { botText } from '../../utils/botText.js';
import { localized, replyText } from '../../utils/commandLocalizations.js';

// The same invite the website and the home servers' DMs use (setting supportServerInvite of Mewvo's
// main server, dashboard-editable). Home-only by design (owner, 2026-11-07): /support is the bot's
// help server in every server; a server's own appeal invite is appealsInvite (dmTemplates.js).
const FALLBACK_INVITE = 'https://discord.gg/7Ckv9Bt577';
/** Privacy Policy and Terms links on the website (PUBLIC_URL), or [] when it is not set. Labels in `lang` (default English). */
export function legalLinks(env = process.env, { lang = 'en' } = {}) {
  const origin = siteOrigin(env);
  const tr = botText(lang);
  return origin ? [[tr.t('core.support.privacy'), `${origin}/privacy`], [tr.t('core.support.terms'), `${origin}/terms`]] : [];
}

export function supportInviteUrl(config = enforcementConfig) {
  return inviteOrNull(config?.supportServerInvite) || FALLBACK_INVITE;
}
export default {
    data: new SlashCommandBuilder()
    .setName("support")
    .setDescription("Get the support server link")
    .setDescriptionLocalizations(localized('core.slash.support.description')),

  async execute(interaction) {
    // Ephemeral: the user's Discord language.
    const tr = replyText(interaction);
    try {
      const supportButton = new ButtonBuilder()
        .setLabel(tr.t('core.support.button'))
        .setStyle(ButtonStyle.Link)
        .setURL(supportInviteUrl());

      const actionRow = new ActionRowBuilder().addComponents(
        supportButton,
        ...legalLinks(process.env, { lang: tr.lang }).map(([label, url]) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url)),
      );

      await InteractionHelper.safeReply(interaction, {
        embeds: [
          createEmbed({ title: tr.t('core.support.title'), description: tr.t('core.support.text') }),
        ],
        components: [actionRow],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error('Support command error:', error);
      
      try {
        return await InteractionHelper.safeReply(interaction, {
          embeds: [createEmbed({ title: tr.t('core.support.errorTitle'), description: tr.t('core.support.error'), color: 'error' })],
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        logger.error('Failed to send error reply:', replyError);
      }
    }
  },
};