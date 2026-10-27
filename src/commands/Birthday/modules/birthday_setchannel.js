import { PermissionsBitField, EmbedBuilder, MessageFlags } from 'discord.js';
import { updateGuildConfig } from '../../../services/config/guildConfig.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import { canonicalTimeZone, localDateKey } from '../../../utils/timezone.js';

export default {
    async execute(interaction, config, client) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('Permission Denied')
                .setDescription('You need **Manage Server** permissions to configure the birthday channel.');
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
                        .setTitle('Unknown Time Zone')
                        .setDescription(`\`${timezoneInput}\` is not a known time zone. Use an IANA name such as \`Europe/London\`, \`America/New_York\` or \`UTC\` (the list suggests names as you type).`);
                    return InteractionHelper.safeReply(interaction, {
                        embeds: [embed],
                        flags: MessageFlags.Ephemeral,
                    });
                }
            }

            const timezoneLine = timezone
                ? `\nBirthdays follow the **${timezone}** date (it is currently ${localDateKey(new Date(), timezone)} there). Announcements go out once per local day.`
                : '';

            if (channel) {
                await updateGuildConfig(client, guildId, {
                    birthdayChannelId: channel.id,
                    ...(timezone && { birthdayTimezone: timezone }),
                });
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('Birthday Announcements Enabled')
                    .setDescription(`Birthday announcements will now be posted in ${channel}.${timezoneLine}`);
                return InteractionHelper.safeReply(interaction, {
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral,
                });
            } else if (timezone) {
                // Only a time zone given: keep the current channel.
                await updateGuildConfig(client, guildId, { birthdayTimezone: timezone });
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('Birthday Time Zone Updated')
                    .setDescription(timezoneLine.trim());
                return InteractionHelper.safeReply(interaction, {
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral,
                });
            } else {
                await updateGuildConfig(client, guildId, { birthdayChannelId: null });
                const embed = new EmbedBuilder()
                    .setColor(0xFFFF00)
                    .setTitle('Birthday Announcements Disabled')
                    .setDescription('No channel provided — birthday announcements have been disabled.');
                return InteractionHelper.safeReply(interaction, {
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral,
                });
            }
        } catch (error) {
            logger.error('birthday_setchannel error:', error);
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⚠️ Configuration Error')
                .setDescription('Could not save the birthday channel configuration.');
            return InteractionHelper.safeReply(interaction, {
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
