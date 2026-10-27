import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
// The panels, the checks and the posting live in the service (shared with the web dashboard).
import { postAppealPanels } from '../../services/enforcement/appealPanelService.js';

export default {
    // Registered as a guild command in MAIN_GUILD_ID only.
    scope: 'main',
    data: new SlashCommandBuilder()
        .setName('setappeal')
        .setDescription('Post the appeal panels: here (mutes/warns) and in #appeals in the support server (bans)')
        .addChannelOption((option) => option
            .setName('channel')
            .setDescription('Where to post the main-server panel (default: this channel)')
            .addChannelTypes(ChannelType.GuildText)),

    async execute(interaction, config, client) {
        if (interaction.guildId !== enforcementConfig.mainGuildId) {
            throw new TitanBotError('Wrong guild for /setappeal', ErrorTypes.PERMISSION,
                'This command only works in the main server.', { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                'You need the Administrator permission to set up appeals.', { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const target = interaction.options.getChannel('channel') || interaction.channel;
        const { mainChannel, supportChannel, created, category } = await postAppealPanels(client, interaction.guild, target);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Appeal panels posted', [
                `**Main server:** <#${mainChannel.id}>, for mutes and warns.`,
                `**Support server:** #${supportChannel.name}${created ? ' (created)' : ''}, for bans and kicks, plus staff reports.`,
                '',
                `Every appeal and report opens in **${category.name}**, visible to administrators only.`,
                'Review and decide them with **/appeals**.',
            ].join('\n'))],
        });
    },
};
