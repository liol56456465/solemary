import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, MessageFlags } from 'discord.js';
import { getWelcomeConfig } from '../../utils/database.js';
import { updateWelcomeSettings } from '../../services/welcomeService.js';
import { formatWelcomeMessage, truncateForEmbedField } from '../../utils/welcome.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';

// The variables list stays as typed in every language (they are template tokens, not words).
const VARIABLES = ' {user}, {username}, {server}, {memberCount}';
const withVariables = (texts) => Object.fromEntries(Object.entries(texts).map(([locale, text]) => [locale, text + VARIABLES]));

export default {
    data: new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('Configure the welcome system')
        .setDescriptionLocalizations(localizations('welcome.cmd.welcome.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Set up the welcome message')
                .setDescriptionLocalizations(localizations('welcome.cmd.welcome.setup.description'))
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('The channel to send welcome messages to')
                        .setDescriptionLocalizations(localizations('welcome.cmd.welcome.setup.channel'))
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('message')
                        .setDescription('Welcome message. Variables: {user}, {username}, {server}, {memberCount}')
                        .setDescriptionLocalizations(withVariables(localizations('welcome.cmd.welcome.setup.message')))
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('image')
                        .setDescription('Image URL to add to the message')
                        .setDescriptionLocalizations(localizations('welcome.cmd.welcome.setup.image'))
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('ping')
                        .setDescription('Ping the member in the message')
                        .setDescriptionLocalizations(localizations('welcome.cmd.welcome.setup.ping'))
                        .setRequired(false))),

    async execute(interaction) {
        try {
            const deferSuccess = await InteractionHelper.safeDefer(interaction);
            if (!deferSuccess) {
                logger.warn(`Welcome interaction defer failed`, {
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'welcome'
                });
                return;
            }
        } catch (deferError) {
            logger.error(`Welcome defer error`, { error: deferError.message });
            return;
        }

        const { options, guild, client } = interaction;
        // Errors are private (the user's language); the setup summary is posted in the channel (the server's).
        const tr = textForInteraction(interaction);
        const pub = textForInteraction(interaction, { purpose: 'public' });

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('welcome.manageServer', { command: '/welcome' }) });
        }

        const subcommand = options.getSubcommand();

        if (subcommand === 'setup') {
            const channel = options.getChannel('channel');
            const message = options.getString('message');
            const image = options.getString('image');
            const ping = options.getBoolean('ping') ?? false;

            const existingConfig = await getWelcomeConfig(client, guild.id);
            if (existingConfig?.channelId) {
                logger.info(`[Welcome] Setup blocked because config already exists in channel ${existingConfig.channelId} for guild ${guild.id}`);
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('welcome.welcome.alreadySet', { channelId: existingConfig.channelId }) });
            }
            
            if (!message || message.trim().length === 0) {
                logger.warn(`[Welcome] Empty message provided by ${interaction.user.tag} in ${guild.name}`);
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('welcome.welcome.empty') });
            }

            if (image) {
                try {
                    new URL(image);
                } catch (e) {
                    logger.warn(`[Welcome] Invalid image URL provided by ${interaction.user.tag}: ${image}`);
                    return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('welcome.invalidImage') });
                }
            }

            try {
                await updateWelcomeSettings(client, guild.id, {
                    enabled: true,
                    channelId: channel.id,
                    welcomeMessage: message,
                    welcomeImage: image || undefined,
                    welcomePing: ping
                });

                logger.info(`[Welcome] Setup configured by ${interaction.user.tag} for guild ${guild.name} (${guild.id})`);

                const previewMessage = formatWelcomeMessage(message, {
                    user: interaction.user,
                    guild
                });

                const embed = new EmbedBuilder()
                    .setColor(getColor('success'))
                    .setTitle(pub.t('welcome.welcome.doneTitle'))
                    .setDescription(pub.t('welcome.welcome.doneBody', { channel: String(channel) }))
                    .addFields(
                        { name: pub.t('welcome.setupDone.preview'), value: truncateForEmbedField(previewMessage) },
                        { name: pub.t('welcome.setupDone.ping'), value: ping ? pub.t('welcome.setupDone.yes') : pub.t('welcome.setupDone.no') },
                        { name: pub.t('welcome.setupDone.status'), value: pub.t('welcome.setupDone.on') }
                    )
                    .setFooter({ text: pub.t('welcome.setupDone.footer') });

                if (image) {
                    embed.setImage(image);
                }

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                if (error?.type === ErrorTypes.VALIDATION && error.userMessage) {
                    return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: error.userMessage });
                }
                logger.error(`[Welcome] Failed to setup welcome system for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('welcome.welcome.failed') });
            }
        }
    },
};