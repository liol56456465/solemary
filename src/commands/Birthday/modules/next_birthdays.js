import { EmbedBuilder } from 'discord.js';
import { getUpcomingBirthdays, filterPresentBirthdays, birthdayDateText } from '../../../services/birthdayService.js';
import { logger } from '../../../utils/logger.js';
import { botText, textForInteraction } from '../../../utils/botText.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';

const SHOWN = 5;

/** "**Today**", "**Tomorrow**", "In 3 days" (in `lang`, default English). Pure. */
export function timeUntilLabel(daysUntil, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (daysUntil === 0) return tr.t('birthday.next.today');
    if (daysUntil === 1) return tr.t('birthday.next.tomorrow');
    return tr.tp('birthday.next.inDays', daysUntil);
}

export default {
    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction);
        // A public reply (posted in the channel): the server's language.
        const tr = textForInteraction(interaction, { purpose: 'public' });

        const upcoming = await getUpcomingBirthdays(client, interaction.guildId, Infinity);

        if (upcoming.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(tr.t('birthday.next.noneTitle'))
                .setDescription(tr.t('birthday.next.none'));
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
                .setTitle(tr.t('birthday.next.noUpcomingTitle'))
                .setDescription(tr.t('birthday.next.noUpcoming'));
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        let birthdayList = `${tr.t('birthday.next.intro', { server: interaction.guild.name })}\n\n`;
        next.forEach((birthday, index) => {
            const name = members.get(birthday.userId)?.displayName;
            const who = name ? `**${name}** (<@${birthday.userId}>)` : `<@${birthday.userId}>`;
            birthdayList += `${index + 1}. ${who}\n${birthdayDateText(birthday.month, birthday.day, { lang: tr.lang })} · ${timeUntilLabel(birthday.daysUntil, { lang: tr.lang })}\n\n`;
        });
        birthdayList += tr.t('birthday.next.footer');

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(tr.t('birthday.next.title'))
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
