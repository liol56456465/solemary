import { EmbedBuilder } from 'discord.js';
import { deleteBirthday } from '../../../services/birthdayService.js';
import { textForInteraction } from '../../../utils/botText.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction);
        // A public reply (posted in the channel): the server's language.
        const tr = textForInteraction(interaction, { purpose: 'public' });

        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        const result = await deleteBirthday(client, guildId, userId, { lang: tr.lang });

        if (result.status === 'not_found') {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(tr.t('birthday.remove.noneTitle'))
                .setDescription(tr.t('birthday.remove.none'));
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(tr.t('birthday.remove.title'))
            .setDescription(tr.t('birthday.remove.text'));
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [embed]
        });
    }
};
