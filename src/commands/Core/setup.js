// /setup — this server's setup checklist, the dashboard link and every command by category
// (multi-server B2). Administrator or Manage Server (commandAccess.js MANAGE_SERVER_COMMANDS),
// ephemeral, in the user's Discord language. Changes nothing.

import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { textForInteraction } from '../../utils/botText.js';
import { collectSetupState, defaultSetupData, setupReply } from '../../services/setup/setupGuide.js';

/** Runs /setup. `data` is injectable for tests (services/setup/setupGuide.js defaultSetupData). */
export async function runSetup(interaction, guildConfig, client, { data = defaultSetupData } = {}) {
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const tr = textForInteraction(interaction);
    // A read that fails throws: the dispatcher answers with the normal database error.
    const state = await collectSetupState({ client, guildId: interaction.guildId, config: guildConfig, data });
    const { embeds, components } = setupReply({ client, guild: interaction.guild, userId: interaction.user.id, state, tr });
    await InteractionHelper.safeEditReply(interaction, { embeds, components, allowedMentions: { parse: [] } });
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('See what is set up in this server, open the dashboard, browse all commands'),

    async execute(interaction, guildConfig, client) {
        return runSetup(interaction, guildConfig, client);
    },
};
