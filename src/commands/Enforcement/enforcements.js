import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { buildPanel } from '../../handlers/enforcementPanel.js';
import { assertBotPermissions, isAdministrator } from '../../services/enforcement/enforcementService.js';
import { resolveTargetUser } from '../../handlers/backgroundView.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';

export default {
    data: new SlashCommandBuilder()
        .setName('enforcements')
        .setDescription('Open the enforcement panel for a user (ban, kick, mute, warn and more)')
        .setDescriptionLocalizations(descriptionLocalizations('staff.enforcements.cmd.description'))
        .addUserOption((option) => option
            .setName('user')
            .setDescription('The user to act on')
            .setDescriptionLocalizations(descriptionLocalizations('staff.enforcements.cmd.user')))
        .addStringOption((option) => option
            .setName('user_id')
            .setDescription('User ID, for people no longer in the server')
            .setDescriptionLocalizations(descriptionLocalizations('staff.enforcements.cmd.userId'))
            .setMinLength(17)
            .setMaxLength(20)),

    async execute(interaction, config, client) {
        // Any server (multi-server B1): every action runs in, and is stored for, this server.
        // The panel is an ephemeral reply: the moderator's Discord language.
        const tr = textForInteraction(interaction);
        if (!interaction.guildId) {
            throw new TitanBotError('/enforcements outside a server', ErrorTypes.PERMISSION,
                tr.t('staff.enforcements.serverOnly'), { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                tr.t('staff.enforcements.noAdmin'), { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const targetUser = await resolveTargetUser(interaction, client);
        assertBotPermissions(interaction.guild);

        await InteractionHelper.safeEditReply(interaction, await buildPanel(interaction.guild, interaction.user.id, targetUser, { lang: tr.lang }));
    },
};
