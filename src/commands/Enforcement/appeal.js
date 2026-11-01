// /appeal status: a member's own appeals and where each one stands (the same text as the
// My appeals button on the appeal panel). Everyone may use it; the reply is private.

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { listUserAppeals } from '../../services/enforcement/caseService.js';
import { myAppealsText } from '../../handlers/appealsHandler.js';

export default {
    data: new SlashCommandBuilder()
        .setName('appeal')
        .setDescription('Your appeals')
        .addSubcommand((sub) => sub.setName('status').setDescription('Where your appeals stand')),

    // (interaction, guildConfig, client) from the dispatcher; the 4th argument is for tests.
    async execute(interaction, guildConfig, client, { list = listUserAppeals } = {}) {
        const reply = (description, color = 'primary') => InteractionHelper.safeReply(interaction, {
            embeds: [createEmbed({ title: 'My appeals', description, color })], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
        });
        try {
            return reply(myAppealsText(await list(interaction.user.id)));
        } catch (error) {
            logger.error(`/appeal status failed for ${interaction.user.id}: ${error.message}`);
            return reply('The database is not responding. Try again in a few minutes.', 'error');
        }
    },
};
