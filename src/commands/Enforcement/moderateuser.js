import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { buildPanel } from '../../handlers/enforcementPanel.js';
import { assertBotPermissions, assertCanTarget, isAdministrator } from '../../services/enforcement/enforcementService.js';

export default {
    // Registered as a guild command in MAIN_GUILD_ID only: right-click a member → Apps → Moderate.
    scope: 'main',
    data: new ContextMenuCommandBuilder()
        .setName('Moderate')
        .setType(ApplicationCommandType.User),

    async execute(interaction) {
        if (interaction.guildId !== enforcementConfig.mainGuildId) {
            throw new TitanBotError('Wrong guild', ErrorTypes.PERMISSION, 'This only works in the main server.', { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION, 'You need the Administrator permission to use this panel.', { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        const guild = interaction.guild;
        const targetUser = interaction.targetUser;
        assertBotPermissions(guild);
        // The same panel as /enforcements user:<them>.
        const panel = await buildPanel(guild, interaction.user.id, targetUser);

        // Early hierarchy check: every action would be refused on Confirm anyway, so
        // show the summary read-only instead of buttons that can only fail.
        try {
            const targetMember = interaction.targetMember?.roles?.cache
                ? interaction.targetMember
                : await guild.members.fetch(targetUser.id).catch(() => null);
            assertCanTarget(guild, interaction.member, targetUser.id, targetMember, 'moderate');
        } catch (error) {
            panel.content = `⛔ ${error.userMessage || error.message} The panel is read-only.`;
            panel.components = [];
        }
        await InteractionHelper.safeEditReply(interaction, panel);
    },
};
