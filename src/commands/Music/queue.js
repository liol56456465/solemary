import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { buildQueueReply } from '../../services/music/musicActions.js';
import { getGuildMusicData } from '../../services/music/playerStore.js';

export default {
    slashOnly: true,
    category: 'Music',
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Show the current music queue')
        .addIntegerOption((opt) =>
            opt.setName('page').setDescription('Page number').setMinValue(1),
        ),

    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        const page = (interaction.options.getInteger('page') || 1) - 1;
        const payload = buildQueueReply(client, interaction.guild.id, page);
        // Pagination buttons navigate relative to this per-user page.
        getGuildMusicData(interaction.guild.id).queuePages.set(interaction.user.id, payload.page);
        await InteractionHelper.safeEditReply(interaction, {
            embeds: payload.embeds,
            components: payload.components,
        });
    },
};
