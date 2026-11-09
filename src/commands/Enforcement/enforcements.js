import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { buildPanel, readOnlyIfUntargetable } from '../../handlers/enforcementPanel.js';
import { panelAccessFor, refusalKey } from '../../services/enforcement/panelAccess.js';
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
        // Acknowledged first: a moderator's role check may read the guild config.
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        // Administrator; in servers that are not Mewvo's own also the Moderator role (owner decision D1).
        const access = await panelAccessFor(interaction.member, interaction.guildId, { client });
        if (!access.level) {
            throw new TitanBotError('No panel access', ErrorTypes.PERMISSION,
                tr.t(refusalKey(access, interaction.guildId)), { expected: true });
        }

        const targetUser = await resolveTargetUser(interaction, client);
        // Bot permissions are checked per action (enforcementService.assertBotPermissions), so a
        // warn never needs Ban Members. The role order is checked now, before any form (audit 3.5).
        const panel = await buildPanel(interaction.guild, interaction.user.id, targetUser, { lang: tr.lang, actions: access.actions });
        await readOnlyIfUntargetable(panel, { guild: interaction.guild, moderator: interaction.member, targetUser, lang: tr.lang });
        await InteractionHelper.safeEditReply(interaction, panel);
    },
};
