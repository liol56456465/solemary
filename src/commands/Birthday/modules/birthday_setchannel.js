import { PermissionsBitField, EmbedBuilder, MessageFlags } from 'discord.js';
import { updateBirthdaySettings } from '../../../services/birthdayService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import { canonicalTimeZone, localDateKey } from '../../../utils/timezone.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';
import { textForInteraction } from '../../../utils/botText.js';

export default {
    async execute(interaction, config, client) {
        // Ephemeral answers: the admin's own Discord language.
        const tr = textForInteraction(interaction);
        if (!hasAdminAccess(interaction)) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(tr.t('birthday.setchannel.notAllowedTitle'))
                .setDescription(tr.t('birthday.setchannel.notAllowed'));
            return InteractionHelper.safeReply(interaction, {
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            const channel = interaction.options.getChannel('channel');
            const timezoneInput = interaction.options.getString('timezone');
            const guildId = interaction.guildId;

            let timezone = null;
            if (timezoneInput) {
                timezone = canonicalTimeZone(timezoneInput);
                if (!timezone) {
                    const embed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle(tr.t('birthday.setchannel.unknownTzTitle'))
                        .setDescription(tr.t('birthday.setchannel.unknownTz', { input: timezoneInput }));
                    return InteractionHelper.safeReply(interaction, {
                        embeds: [embed],
                        flags: MessageFlags.Ephemeral,
                    });
                }
            }

            const timezoneLine = timezone
                ? `\n${tr.t('birthday.setchannel.timezoneLine', { timezone, date: localDateKey(new Date(), timezone) })}`
                : '';

            if (channel) {
                await updateBirthdaySettings(client, guildId, {
                    channelId: channel.id,
                    ...(timezone && { timezone }),
                });
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle(tr.t('birthday.setchannel.onTitle'))
                    .setDescription(`${tr.t('birthday.setchannel.on', { channel: String(channel) })}${timezoneLine}`);
                return InteractionHelper.safeReply(interaction, {
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral,
                });
            } else if (timezone) {
                // Only a time zone given: keep the current channel.
                await updateBirthdaySettings(client, guildId, { timezone });
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle(tr.t('birthday.setchannel.tzTitle'))
                    .setDescription(timezoneLine.trim());
                return InteractionHelper.safeReply(interaction, {
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral,
                });
            } else {
                await updateBirthdaySettings(client, guildId, { channelId: null });
                const embed = new EmbedBuilder()
                    .setColor(0xFFFF00)
                    .setTitle(tr.t('birthday.setchannel.offTitle'))
                    .setDescription(tr.t('birthday.setchannel.off'));
                return InteractionHelper.safeReply(interaction, {
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral,
                });
            }
        } catch (error) {
            logger.error('birthday_setchannel error:', error);
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(tr.t('birthday.setchannel.failTitle'))
                .setDescription(tr.t('birthday.setchannel.fail'));
            return InteractionHelper.safeReply(interaction, {
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
