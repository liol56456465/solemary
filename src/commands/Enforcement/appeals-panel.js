import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';

export default {
    // Registered as a guild command in SUPPORT_GUILD_ID only.
    scope: 'support',
    data: new SlashCommandBuilder()
        .setName('appeals-panel')
        .setDescription('Post the Appeal / Report staff panel in this channel'),

    async execute(interaction) {
        if (interaction.guildId !== enforcementConfig.supportGuildId) {
            throw new TitanBotError('Wrong guild for /appeals-panel', ErrorTypes.PERMISSION,
                'This command only works in the support server.', { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                'You need the Administrator permission to post the appeals panel.', { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const category = interaction.guild.channels.cache.get(enforcementConfig.appealsCategoryId);
        if (!category || category.type !== ChannelType.GuildCategory) {
            throw new TitanBotError('APPEALS_CATEGORY_ID invalid', ErrorTypes.CONFIGURATION,
                'APPEALS_CATEGORY_ID does not point to a category in this server. Fix it before posting the panel.', { expected: true });
        }

        const embed = createEmbed({
            title: `${enforcementConfig.serverName} appeals`,
            description: [
                '**Appeal** — punished in Meowist? Use the case code from your DM. Administrators review every appeal privately and you get the decision by DM.',
                '',
                '**Report staff** — report a staff member who broke the rules. Only administrators can see reports.',
                '',
                '-# Bans, mutes and warnings can be appealed while active (warnings and kicks within 30 days).',
            ].join('\n'),
            color: 'primary',
        });

        await interaction.channel.send({
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('appeal:open').setLabel('Appeal').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('appeal:report').setLabel('Report staff').setStyle(ButtonStyle.Danger),
            )],
        });

        await InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Appeals panel posted.')] });
    },
};
