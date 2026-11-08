import { EmbedBuilder } from 'discord.js';
import { getAllBirthdays, filterPresentBirthdays, fitLines } from '../../../services/birthdayService.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction);

        const guildId = interaction.guildId;

        const sortedBirthdays = await getAllBirthdays(client, guildId);

        if (sortedBirthdays.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('No birthdays')
                .setDescription('No birthdays have been set in this server yet.');
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        // Read-only: birthdays of people who left are hidden here; guildMemberRemove removes them.
        const { present } = await filterPresentBirthdays(interaction.guild, sortedBirthdays);

        if (present.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('No birthdays')
                .setDescription('No birthdays have been set by current server members.');
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        const header = `**${present.length} birthday${present.length !== 1 ? 's' : ''} in ${interaction.guild.name}**\n\n`;
        const lines = present.map((birthday, index) => `${index + 1}. <@${birthday.userId}> - ${birthday.monthName} ${birthday.day}`);
        // Embed descriptions stop at 4096 characters: a long list ends with "…and N more".
        const { text } = fitLines(lines, { maxLength: 3800 - header.length });

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('Birthdays')
            .setDescription(`${header}${text}`);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [embed],
            allowedMentions: { parse: [] },
        });

        logger.info('Birthday list retrieved successfully', {
            userId: interaction.user.id,
            guildId,
            birthdayCount: present.length,
            commandName: 'birthday_list'
        });
    }
};
