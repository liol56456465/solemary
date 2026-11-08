import { EmbedBuilder } from 'discord.js';
import { setBirthday, birthdayDateText } from '../../../services/birthdayService.js';
import { textForInteraction } from '../../../utils/botText.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction);
        // A public reply (posted in the channel): the server's language.
        const tr = textForInteraction(interaction, { purpose: 'public' });

        const month = interaction.options.getInteger("month");
        const day = interaction.options.getInteger("day");
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        const result = await setBirthday(client, guildId, userId, month, day, { lang: tr.lang });

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(tr.t('birthday.set.title'))
            .setDescription(tr.t('birthday.set.text', { date: birthdayDateText(result.data.month, result.data.day, { lang: tr.lang }) }));

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [embed]
        });
    }
};
