import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { buildPanel } from '../../handlers/enforcementPanel.js';
import { assertBotPermissions, assertCanTarget, isAdministrator } from '../../services/enforcement/enforcementService.js';
import { textForInteraction } from '../../utils/botText.js';

export default {
    // Right-click a member → Apps → Moderate.
    data: new ContextMenuCommandBuilder()
        .setName('Moderate')
        .setType(ApplicationCommandType.User),

    async execute(interaction) {
        const tr = textForInteraction(interaction); // ephemeral: the moderator's language
        if (!interaction.guildId) {
            throw new TitanBotError('Not in a server', ErrorTypes.PERMISSION, tr.t('staff.moderateuser.serverOnly'), { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION, tr.t('staff.enforcements.noAdmin'), { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        const guild = interaction.guild;
        const targetUser = interaction.targetUser;
        assertBotPermissions(guild);
        // The same panel as /enforcements user:<them>.
        const panel = await buildPanel(guild, interaction.user.id, targetUser, { lang: tr.lang });

        // Early hierarchy check: every action would be refused on Confirm anyway, so
        // show the summary read-only instead of buttons that can only fail.
        try {
            const targetMember = interaction.targetMember?.roles?.cache
                ? interaction.targetMember
                : await guild.members.fetch(targetUser.id).catch(() => null);
            assertCanTarget(guild, interaction.member, targetUser.id, targetMember, 'moderate');
        } catch (error) {
            panel.content = tr.t('staff.moderateuser.readOnly', { reason: error.userMessage || error.message });
            panel.components = [];
        }
        await InteractionHelper.safeEditReply(interaction, panel);
    },
};
