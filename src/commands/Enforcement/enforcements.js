import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { buildPanel } from '../../handlers/enforcementPanel.js';
import { assertBotPermissions, isAdministrator } from '../../services/enforcement/enforcementService.js';
import { resolveTargetUser } from '../../handlers/backgroundView.js';

export default {
    // Registered as a guild command in MAIN_GUILD_ID only.
    scope: 'main',
    data: new SlashCommandBuilder()
        .setName('enforcements')
        .setDescription('Open the enforcement panel for a user (ban, kick, mute, warn and more)')
        .addUserOption((option) => option
            .setName('user')
            .setDescription('The user to act on'))
        .addStringOption((option) => option
            .setName('user_id')
            .setDescription('User ID, for people no longer in the server')
            .setMinLength(17)
            .setMaxLength(20)),

    async execute(interaction, config, client) {
        // Any server (multi-server B1): every action runs in, and is stored for, this server.
        if (!interaction.guildId) {
            throw new TitanBotError('/enforcements outside a server', ErrorTypes.PERMISSION,
                'This command only works in a server.', { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                'You need the Administrator permission to use this panel.', { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const targetUser = await resolveTargetUser(interaction, client);
        assertBotPermissions(interaction.guild);

        await InteractionHelper.safeEditReply(interaction, await buildPanel(interaction.guild, interaction.user.id, targetUser));
    },
};
