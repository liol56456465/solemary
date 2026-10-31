import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, warningEmbed } from '../../utils/embeds.js';
import { getConfirmationButtons } from '../../utils/components.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { WIPE_ITEMS } from '../../services/wipedataService.js';
export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('wipedata')
        .setDescription('Delete your levels, balance, AFK, birthday, to-do list and reminders (cannot be undone)'),

    async execute(interaction, guildConfig, client) {
        const warningMessage =
            'This permanently deletes your data in this server:\n'
            + WIPE_ITEMS.map((item) => `- ${item.label}`).join('\n')
            + "\n\nYour to-do list and reminders are the same in every server, so they are deleted everywhere. "
            + 'Moderation, appeal, report and verification records are kept.\n\n**This cannot be undone.**';

        const embed = warningEmbed('Delete your data?', warningMessage);

        const confirmButtons = getConfirmationButtons('wipedata');

        await InteractionHelper.safeReply(interaction, {
            embeds: [embed],
            components: [confirmButtons],
            flags: MessageFlags.Ephemeral
        });

        logger.info(`Wipedata command executed - confirmation prompt shown`, {
            userId: interaction.user.id,
            guildId: interaction.guildId
        });
    }
};