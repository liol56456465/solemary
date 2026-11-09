import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError } from '../../utils/errorHandler.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';
import { unlockChannel } from '../../services/channelToolsService.js';
import { lockRefusal } from './lock.js';

const NO_MENTIONS = Object.freeze({ parse: [] });

// Unlock puts back exactly what /lock changed (services/moderation/channelLock.js); a channel
// locked before that (or by hand) only gets its @everyone deny cleared, as before.
export default {
    data: new SlashCommandBuilder()
        .setName("unlock")
        .setDescription(
            "Unlocks the current channel (allows @everyone to send messages again).",
        )
        .setDescriptionLocalizations(descriptionLocalizations('moderation.unlock.cmd.description'))
.setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    category: "moderation",

    async execute(interaction, config, client, deps = {}) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Unlock interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'unlock'
            });
            return;
        }

        // Errors: the moderator's language; the unlock notice is posted in the channel: the server's language.
        const tr = textForInteraction(interaction);
        const pub = textForInteraction(interaction, { purpose: 'public' });
        const channel = interaction.channel;

        let result;
        try {
            result = await (deps.unlockChannel || unlockChannel)({
                client, guild: interaction.guild, channel, moderator: interaction.user, via: 'command',
                auditReason: `Channel unlocked by ${interaction.user.tag}`.slice(0, 512),
                ...(deps.lockStore ? { lockStore: deps.lockStore } : {}), ...(deps.log ? { log: deps.log } : {}),
            });
        } catch (error) {
            if (!error?.code) logger.error('Unlock command error:', error);
            return await replyUserError(interaction, lockRefusal(tr, error, channel, 'unlock'));
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    pub.t('moderation.unlock.title'),
                    pub.t('moderation.unlock.done', { channel: String(channel) }),
                ),
            ],
            allowedMentions: NO_MENTIONS,
        });

        if (result?.skipped?.length && !interaction._isPrefixCommand && typeof interaction.followUp === 'function') {
            await interaction.followUp({ content: tr.tp('moderation.unlock.skipped', result.skipped.length), flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS })
                .catch((error) => logger.debug(`Unlock note not sent: ${error.message}`));
        }
    }
};
