import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { reportMessage } from '../../services/automod/memberChecks.js';

const recentReports = new Map(); // reporterId → at

export default {
    // Registered as a guild command in MAIN_GUILD_ID only. Open to every member.
    scope: 'main',
    data: new ContextMenuCommandBuilder()
        .setName('Report message')
        .setType(ApplicationCommandType.Message),

    async execute(interaction) {
        if (interaction.guildId !== enforcementConfig.mainGuildId) {
            throw new TitanBotError('Wrong guild', ErrorTypes.PERMISSION, 'Reports only work in the main server.', { expected: true });
        }
        const message = interaction.targetMessage;
        if (message.author.bot || message.author.id === interaction.user.id) {
            throw new TitanBotError('Invalid report', ErrorTypes.USER_INPUT, 'You can only report messages from other members.', { expected: true });
        }
        const last = recentReports.get(interaction.user.id) || 0;
        if (Date.now() - last < 30 * 1000) {
            throw new TitanBotError('Report cooldown', ErrorTypes.RATE_LIMIT, 'Please wait a little before reporting another message.', { expected: true });
        }
        recentReports.set(interaction.user.id, Date.now());

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        await reportMessage(message, interaction.user);
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Report sent', 'Thanks. The moderators will look at it.')],
        });
    },
};
