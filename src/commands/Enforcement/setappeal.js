import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
// The panels, the checks and the posting live in the service (shared with the web dashboard).
// The panels are in the server's language; this reply is in the admin's.
import { postAppealPanels, postServerAppealPanel } from '../../services/enforcement/appealPanelService.js';
import { isHomeGuild } from '../../services/settings/guildSettings.js';

export default {
    data: new SlashCommandBuilder()
        .setName('setappeal')
        .setDescription('Post the appeal and report panel in this server (or the channel you pick)')
        .setDescriptionLocalizations(descriptionLocalizations('staff.setappeal.cmd.description'))
        .addChannelOption((option) => option
            .setName('channel')
            .setDescription('Where to post the panel (default: this channel)')
            .setDescriptionLocalizations(descriptionLocalizations('staff.setappeal.cmd.channel'))
            .addChannelTypes(ChannelType.GuildText)),

    async execute(interaction, config, client) {
        const tr = textForInteraction(interaction);
        // Mewvo's support server posts nothing itself (its panel comes from the main server's run).
        if (!interaction.guildId || interaction.guildId === enforcementConfig.supportGuildId) {
            throw new TitanBotError('Wrong guild for /setappeal', ErrorTypes.PERMISSION,
                tr.t('staff.setappeal.supportServer'), { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                tr.t('staff.setappeal.noAdmin'), { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const target = interaction.options.getChannel('channel') || interaction.channel;
        if (!isHomeGuild(interaction.guildId)) {
            // Any other server (multi-server B1): one panel in this server; appeals and reports open here.
            const { channel, category } = await postServerAppealPanel(interaction.guild, target, { lang: tr.lang });
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(tr.t('staff.setappeal.posted.serverTitle'), [
                    tr.t('staff.setappeal.posted.serverPanel', { channelId: channel.id }),
                    '',
                    tr.t('staff.setappeal.posted.category', { category: category.name }),
                    tr.t('staff.setappeal.posted.serverDecide'),
                ].join('\n'))],
            });
            return;
        }
        const { mainChannel, supportChannel, created, category } = await postAppealPanels(client, interaction.guild, target, { lang: tr.lang });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('staff.setappeal.posted.homeTitle'), [
                tr.t('staff.setappeal.posted.main', { channelId: mainChannel.id }),
                tr.t(created ? 'staff.setappeal.posted.supportCreated' : 'staff.setappeal.posted.support', { channel: supportChannel.name }),
                '',
                tr.t('staff.setappeal.posted.category', { category: category.name }),
                tr.t('staff.setappeal.posted.homeDecide'),
            ].join('\n'))],
        });
    },
};
