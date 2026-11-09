import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { startWarnFromMessage } from '../../handlers/enforcementPanel.js';
import { assertCanTarget } from '../../services/enforcement/enforcementService.js';
import { panelAccessFor, panelActionAllowed, refusalKey } from '../../services/enforcement/panelAccess.js';
import { textForInteraction } from '../../utils/botText.js';

function refuse(message, type = ErrorTypes.USER_INPUT) {
    return new TitanBotError(message, type, message, { expected: true });
}

export default {
    // Right-click a message → Apps → Warn for this message. Administrator; in servers that are not
    // Mewvo's own also the Moderator role (commandAccess.js MODERATOR_PANEL_COMMANDS, owner decision D1).
    data: new ContextMenuCommandBuilder()
        .setName('Warn for this message')
        .setType(ApplicationCommandType.Message),

    async execute(interaction, config, client) {
        const message = interaction.targetMessage;
        const tr = textForInteraction(interaction); // ephemeral: the moderator's language
        // Any server, but only for a message of the server the warn is given in.
        if (!interaction.guildId || !message?.guildId || message.guildId !== interaction.guildId) {
            throw refuse(tr.t('staff.warnmessage.otherServer'), ErrorTypes.PERMISSION);
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
        // After the acknowledgement: a moderator's role check may read the guild config.
        const access = await panelAccessFor(interaction.member, interaction.guildId, { client: client ?? interaction.client });
        if (!panelActionAllowed(access, 'warn')) {
            throw refuse(tr.t(refusalKey(access, interaction.guildId, { forWarn: true })), ErrorTypes.PERMISSION);
        }

        // The same checks the panel runs, up front, so nothing is filled in for nothing.
        // A warn needs no bot permission beyond answering (audit 3.6).
        const guild = interaction.guild;
        const targetMember = await guild.members.fetch(author.id).catch(() => null);
        if (!targetMember) {
            throw refuse(tr.t('staff.warnmessage.notInServer', { name: author.username }));
        }
        assertCanTarget(guild, interaction.member, author.id, targetMember, 'warn', { lang: tr.lang });

        await startWarnFromMessage(interaction, message, author);
    },
};
