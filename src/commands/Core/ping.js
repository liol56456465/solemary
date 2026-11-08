import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { localized, publicText, replyText } from './modules/commandText.js';

export default {
    data: new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Check the bot's latency")
        .setDescriptionLocalizations(localized('core.slash.ping.description')),

    async prefixExecute(interaction) {
        // Posted in the channel: the server's language.
        const tr = publicText(interaction);
        try {
            const startTime = Date.now();
            const pingingMessage = await interaction.reply({ content: tr.t('core.ping.pinging') });

            const latency = Date.now() - startTime;
            const apiLatency = Math.max(0, Math.round(interaction.client.ws.ping));

            const embed = createEmbed({ title: tr.t('core.ping.title'), description: null }).addFields(
                { name: tr.t('core.ping.botLatency'), value: tr.t('core.ping.ms', { value: latency }), inline: true },
                { name: tr.t('core.ping.apiLatency'), value: tr.t('core.ping.ms', { value: apiLatency }), inline: true },
            );

            await pingingMessage.edit({ content: null, embeds: [embed] });
        } catch (error) {
            logger.error('Ping prefix command error:', error);
            if (!interaction.replied && !interaction._replyMessage) {
                await interaction.channel.send({
                    embeds: [createEmbed({ title: tr.t('core.ping.errorTitle'), description: tr.t('core.ping.error'), color: 'error' })],
                }).catch(() => {});
            }
        }
    },

    async execute(interaction) {
        logger.info('execute called - checking if slash command or prefix command');
        logger.info(`execute - has _commandStartTime: ${!!interaction._commandStartTime}, createdTimestamp: ${interaction.createdTimestamp}`);
        
        // A public answer (not ephemeral): the server's language.
        const tr = publicText(interaction);
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Ping interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'ping'
            });
            return;
        }

        try {
            await InteractionHelper.safeEditReply(interaction, {
                content: tr.t('core.ping.pinging'),
            });

            const startTime = interaction._commandStartTime || interaction.createdTimestamp;
            logger.info(`execute - using startTime: ${startTime}, type: ${interaction._commandStartTime ? 'prefix' : 'slash'}`);
            const latency = Math.max(0, Date.now() - startTime);
            const apiLatency = Math.max(0, Math.round(interaction.client.ws.ping));
            logger.info(`execute - calculated latency: ${latency}ms, apiLatency: ${apiLatency}ms`);

            const embed = createEmbed({ title: tr.t('core.ping.title'), description: null }).addFields(
                { name: tr.t('core.ping.botLatency'), value: tr.t('core.ping.ms', { value: latency }), inline: true },
                { name: tr.t('core.ping.apiLatency'), value: tr.t('core.ping.ms', { value: apiLatency }), inline: true },
            );

            await InteractionHelper.safeEditReply(interaction, {
                content: null,
                embeds: [embed],
            });
        } catch (error) {
            logger.error('Ping command error:', error);
            try {
                const err = replyText(interaction);
                return await InteractionHelper.safeReply(interaction, {
                    embeds: [createEmbed({ title: err.t('core.ping.errorTitle'), description: err.t('core.ping.error'), color: 'error' })],
                    flags: MessageFlags.Ephemeral,
                });
            } catch (replyError) {
                logger.error('Failed to send error reply:', replyError);
            }
        }
    },
};