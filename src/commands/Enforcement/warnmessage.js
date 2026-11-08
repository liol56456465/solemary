import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { startWarnFromMessage } from '../../handlers/enforcementPanel.js';
import { assertBotPermissions, assertCanTarget, isAdministrator } from '../../services/enforcement/enforcementService.js';
import { textForInteraction } from '../../utils/botText.js';

function refuse(message, type = ErrorTypes.USER_INPUT) {
    return new TitanBotError(message, type, message, { expected: true });
}

export default {
    // Right-click a message → Apps → Warn for this message. Admin-only (not in commandAccess).
    data: new ContextMenuCommandBuilder()
        .setName('Warn for this message')
        .setType(ApplicationCommandType.Message),

    async execute(interaction) {
        const message = interaction.targetMessage;
        const tr = textForInteraction(interaction); // ephemeral: the moderator's language
        // Any server, but only for a message of the server the warn is given in.
        if (!interaction.guildId || !message?.guildId || message.guildId !== interaction.guildId) {
            throw refuse(tr.t('staff.warnmessage.otherServer'), ErrorTypes.PERMISSION);
        }
        if (!isAdministrator(interaction.member)) {
            throw refuse(tr.t('staff.warnmessage.noAdmin'), ErrorTypes.PERMISSION);
        }
        const author = message.author;
        if (!author || author.bot || message.webhookId || message.system) {
            throw refuse(tr.t('staff.warnmessage.botMessage'));
        }
        if (author.id === interaction.user.id) {
            throw refuse(tr.t('staff.warnmessage.self'));
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        // The same checks the panel runs, up front, so nothing is filled in for nothing.
        const guild = interaction.guild;
        assertBotPermissions(guild);
        const targetMember = await guild.members.fetch(author.id).catch(() => null);
        if (!targetMember) {
            throw refuse(tr.t('staff.warnmessage.notInServer', { name: author.username }));
        }
        assertCanTarget(guild, interaction.member, author.id, targetMember, 'warn');

        await startWarnFromMessage(interaction, message, author);
    },
};
