import { EmbedBuilder } from 'discord.js';
import { getAllBirthdays, filterPresentBirthdays, fitLines, birthdayDateText } from '../../../services/birthdayService.js';
import { logger } from '../../../utils/logger.js';
import { textForInteraction } from '../../../utils/botText.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction);
        // A public reply (posted in the channel): the server's language.
        const tr = textForInteraction(interaction, { purpose: 'public' });

        const guildId = interaction.guildId;

        const sortedBirthdays = await getAllBirthdays(client, guildId);

        if (sortedBirthdays.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(tr.t('birthday.list.noneTitle'))
                .setDescription(tr.t('birthday.list.none'));
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        // Read-only: birthdays of people who left are hidden here; guildMemberRemove removes them.
        const { present } = await filterPresentBirthdays(interaction.guild, sortedBirthdays);

        if (present.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(tr.t('birthday.list.noneTitle'))
                .setDescription(tr.t('birthday.list.noneMembers'));
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        const header = `${tr.tp('birthday.list.header', present.length, { server: interaction.guild.name })}\n\n`;
        const lines = present.map((birthday, index) => `${index + 1}. <@${birthday.userId}> - ${birthdayDateText(birthday.month, birthday.day, { lang: tr.lang })}`);
        // Embed descriptions stop at 4096 characters: a long list ends with "…and N more".
        const { text } = fitLines(lines, { maxLength: 3800 - header.length, more: (n) => tr.tp('birthday.list.more', n) });

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(tr.t('birthday.list.title'))
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
