import { EmbedBuilder } from 'discord.js';
import { getUpcomingBirthdays, filterPresentBirthdays } from '../../../services/birthdayService.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';

const SHOWN = 5;

function timeUntilLabel(daysUntil) {
    if (daysUntil === 0) return '**Today**';
    if (daysUntil === 1) return '**Tomorrow**';
    return `In ${daysUntil} day${daysUntil > 1 ? 's' : ''}`;
}

export default {
    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction);

        const upcoming = await getUpcomingBirthdays(client, interaction.guildId, Infinity);

        if (upcoming.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('No birthdays yet')
                .setDescription('Nobody here has set a birthday. Use `/birthday set` to add yours.');
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        // Read-only: people who left are skipped (guildMemberRemove removes their birthday).
        // The members are fetched in batches of 100 until five present ones are found.
        const next = [];
        const members = new Map();
        for (let i = 0; i < upcoming.length && next.length < SHOWN; i += 100) {
            const result = await filterPresentBirthdays(interaction.guild, upcoming.slice(i, i + 100));
            for (const [id, member] of result.members) members.set(id, member);
            next.push(...result.present.slice(0, SHOWN - next.length));
        }

        if (next.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('No upcoming birthdays')
                .setDescription("None of the saved birthdays belong to someone who's still in the server.");
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        let birthdayList = `Next birthdays in ${interaction.guild.name}:\n\n`;
        next.forEach((birthday, index) => {
            const name = members.get(birthday.userId)?.displayName;
            const who = name ? `**${name}** (<@${birthday.userId}>)` : `<@${birthday.userId}>`;
            birthdayList += `${index + 1}. ${who}\n${birthday.monthName} ${birthday.day} · ${timeUntilLabel(birthday.daysUntil)}\n\n`;
        });
        birthdayList += `Add yours with /birthday set.`;

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('Upcoming birthdays')
            .setDescription(birthdayList.slice(0, 4096));

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [embed],
            allowedMentions: { parse: [] },
        });

        logger.info('Next birthdays retrieved successfully', {
            userId: interaction.user.id,
            guildId: interaction.guildId,
            upcomingCount: next.length,
            commandName: 'next_birthdays'
        });
    }
};
