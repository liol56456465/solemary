import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { buildPanel, readOnlyIfUntargetable } from '../../handlers/enforcementPanel.js';
import { panelAccessFor, refusalKey } from '../../services/enforcement/panelAccess.js';
import { textForInteraction } from '../../utils/botText.js';

export default {
    // Right-click a member → Apps → Moderate.
    data: new ContextMenuCommandBuilder()
        .setName('Moderate')
        .setType(ApplicationCommandType.User),

    async execute(interaction, config, client) {
        const tr = textForInteraction(interaction); // ephemeral: the moderator's language
        if (!interaction.guildId) {
            throw new TitanBotError('Not in a server', ErrorTypes.PERMISSION, tr.t('staff.moderateuser.serverOnly'), { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        // Administrator; in servers that are not Mewvo's own also the Moderator role (owner decision D1).
        const access = await panelAccessFor(interaction.member, interaction.guildId, { client: client ?? interaction.client });
        if (!access.level) {
            throw new TitanBotError('No panel access', ErrorTypes.PERMISSION, tr.t(refusalKey(access, interaction.guildId)), { expected: true });
        }
        const guild = interaction.guild;
        const targetUser = interaction.targetUser;
        // The same panel as /enforcements user:<them> (bot permissions are checked per action).
        const panel = await buildPanel(guild, interaction.user.id, targetUser, { lang: tr.lang, actions: access.actions });

        // Early hierarchy check: every action would be refused on Confirm anyway, so
        // show the summary read-only instead of buttons that can only fail.
        await readOnlyIfUntargetable(panel, {
            guild, moderator: interaction.member, targetUser, lang: tr.lang,
            targetMember: interaction.targetMember?.roles?.cache ? interaction.targetMember : undefined,
        });
        await InteractionHelper.safeEditReply(interaction, panel);
    },
};
