import { EmbedBuilder } from 'discord.js';
import { getUserBirthday, birthdayDateText } from '../../../services/birthdayService.js';
import { logger } from '../../../utils/logger.js';
import { textForInteraction } from '../../../utils/botText.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction);
        // A public reply (posted in the channel): the server's language.
        const tr = textForInteraction(interaction, { purpose: 'public' });

        const targetUser = interaction.options.getUser("user") || interaction.user;
        const userId = targetUser.id;
        const guildId = interaction.guildId;

        const birthdayData = await getUserBirthday(client, guildId, userId);

        if (!birthdayData) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(tr.t('birthday.info.noneTitle'))
                .setDescription(targetUser.id === interaction.user.id
                    ? tr.t('birthday.info.noneSelf')
                    : tr.t('birthday.info.noneOther', { name: targetUser.username }));
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(tr.t('birthday.info.title'))
            .setDescription(tr.t('birthday.info.text', { date: birthdayDateText(birthdayData.month, birthdayData.day, { lang: tr.lang }), user: targetUser.toString() }));

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [embed]
        });

        logger.info('Birthday info retrieved successfully', {
            userId: interaction.user.id,
            targetUserId: targetUser.id,
            guildId,
            commandName: 'birthday_info'
        });
    }
};
