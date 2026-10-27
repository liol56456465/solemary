import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { startWarnFromMessage } from '../../handlers/enforcementPanel.js';
import { assertBotPermissions, assertCanTarget, isAdministrator } from '../../services/enforcement/enforcementService.js';

function refuse(message, type = ErrorTypes.USER_INPUT) {
    return new TitanBotError(message, type, message, { expected: true });
}

export default {
    // Registered as a guild command in MAIN_GUILD_ID only: right-click a message →
    // Apps → Warn for this message. Admin-only (not in commandAccess).
    scope: 'main',
    data: new ContextMenuCommandBuilder()
        .setName('Warn for this message')
        .setType(ApplicationCommandType.Message),

    async execute(interaction) {
        const message = interaction.targetMessage;
        if (interaction.guildId !== enforcementConfig.mainGuildId || message?.guildId !== enforcementConfig.mainGuildId) {
            throw refuse('This only works on messages in the main server.', ErrorTypes.PERMISSION);
        }
        if (!isAdministrator(interaction.member)) {
            throw refuse('You need the Administrator permission to warn members.', ErrorTypes.PERMISSION);
        }
        const author = message.author;
        if (!author || author.bot || message.webhookId || message.system) {
            throw refuse('Bot, webhook and system messages cannot be warned for.');
        }
        if (author.id === interaction.user.id) {
            throw refuse('You cannot warn yourself.');
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        // The same checks the panel runs, up front, so nothing is filled in for nothing.
        const guild = interaction.guild;
        assertBotPermissions(guild);
        const targetMember = await guild.members.fetch(author.id).catch(() => null);
        if (!targetMember) {
            throw refuse(`**${author.username}** is no longer in the server, so a warning can't reach them.`);
        }
        assertCanTarget(guild, interaction.member, author.id, targetMember, 'warn');

        await startWarnFromMessage(interaction, message, author);
    },
};
