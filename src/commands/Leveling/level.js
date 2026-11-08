import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { getLevelingConfig, updateLevelingConfig } from '../../services/leveling/leveling.js';
import { botHasPermission } from '../../utils/permissionGuard.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import levelDashboard from './modules/level_dashboard.js';
import levelAdd from './modules/level_add.js';
import levelRemove from './modules/level_remove.js';
import levelSet from './modules/level_set.js';
import { mergeSubcommands } from '../../utils/mergedCommand.js';
import { textForInteraction } from '../../utils/botText.js';
import { describe, descriptionLocalizations } from '../../utils/commandLocalizations.js';
import { DEFAULT_LEVEL_UP_MESSAGE } from '../../services/leveling/xpSystem.js';

// /level add|remove|set replace /leveladd, /levelremove and /levelset (same options).
const levelCommand = mergeSubcommands(
    describe(new SlashCommandBuilder().setName('level'), 'leveling.cmd.level.description')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((subcommand) =>
            describe(subcommand.setName('setup'), 'leveling.cmd.level.setup')
                .addChannelOption((option) =>
                    describe(option.setName('channel'), 'leveling.cmd.level.setupChannel')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true),
                )
                .addIntegerOption((option) =>
                    describe(option.setName('xp_min'), 'leveling.cmd.level.setupXpMin')
                        .setMinValue(1)
                        .setMaxValue(500)
                        .setRequired(false),
                )
                .addIntegerOption((option) =>
                    describe(option.setName('xp_max'), 'leveling.cmd.level.setupXpMax')
                        .setMinValue(1)
                        .setMaxValue(500)
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    describe(option.setName('message'), 'leveling.cmd.level.setupMessage', { user: '{user}', level: '{level}' })
                        .setMaxLength(500)
                        .setRequired(false),
                )
                .addIntegerOption((option) =>
                    describe(option.setName('xp_cooldown'), 'leveling.cmd.level.setupCooldown')
                        .setMinValue(0)
                        .setMaxValue(3600)
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            describe(subcommand.setName('dashboard'), 'leveling.cmd.level.dashboard'),
        ),
    {
        add: { module: levelAdd, description: 'Add levels to a member', descriptionLocalizations: descriptionLocalizations('leveling.cmd.level.add') },
        remove: { module: levelRemove, description: 'Remove levels from a member', descriptionLocalizations: descriptionLocalizations('leveling.cmd.level.remove') },
        set: { module: levelSet, description: "Set a member's level", descriptionLocalizations: descriptionLocalizations('leveling.cmd.level.set') },
    },
);

/** The bot's default level-up message in a language, with {user} and {level} kept for the template. */
export function defaultLevelUpMessage(tr) {
    return tr.t('leveling.levelUp.default', { user: '{user}', level: '{level}' });
}

export default {
    data: levelCommand.data,
    category: 'Leveling',

    async execute(interaction, config, client) {
        if (await levelCommand.run(interaction, config, client)) return;

        const deferred = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral,
        });
        if (!deferred) return;
        // Every answer here is ephemeral: the user's own language.
        const tr = textForInteraction(interaction);

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('leveling.setup.manageServer') });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'dashboard') {
            return levelDashboard.execute(interaction, config, client);
        }

        if (subcommand === 'setup') {
            const channel = interaction.options.getChannel('channel');
            const xpMin = interaction.options.getInteger('xp_min') ?? 15;
            const xpMax = interaction.options.getInteger('xp_max') ?? 25;
            // No message given: the bot's default, stored in English and posted in the server's language.
            const message =
                interaction.options.getString('message') ??
                DEFAULT_LEVEL_UP_MESSAGE;
            const xpCooldown = interaction.options.getInteger('xp_cooldown') ?? 60;

            if (xpMin > xpMax) {
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('leveling.setup.minAboveMax', { min: xpMin, max: xpMax }) });
            }

            if (!botHasPermission(channel, ['SendMessages', 'EmbedLinks'])) {
                throw new TitanBotError(
                    'Bot missing permissions in the specified channel',
                    ErrorTypes.PERMISSION,
                    tr.t('leveling.setup.botPermissions', { channel: String(channel) }),
                );
            }

            const existingConfig = await getLevelingConfig(client, interaction.guildId);

            if (existingConfig.configured) {
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('leveling.setup.already', { channelId: existingConfig.levelUpChannel }) });
            }

            const setupPatch = {
                configured: true,
                enabled: true,
                levelUpChannel: channel.id,
                xpRange: { min: xpMin, max: xpMax },
                xpCooldown: xpCooldown,
                levelUpMessage: message,
                announceLevelUp: true,
            };

            await updateLevelingConfig(client, interaction.guildId, setupPatch);

            logger.info(`Leveling system set up in guild ${interaction.guildId}`, {
                channelId: channel.id,
                xpMin,
                xpMax,
                xpCooldown,
                userId: interaction.user.id,
            });

            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    createEmbed({
                        title: tr.t('leveling.setup.doneTitle'),
                        description:
                            `${tr.t('leveling.setup.doneIntro')}\n\n` +
                            `${tr.t('leveling.setup.doneChannel', { channel: String(channel) })}\n` +
                            `${tr.t('leveling.setup.doneXp', { min: xpMin, max: xpMax })}\n` +
                            `${tr.t('leveling.setup.doneCooldown', { seconds: xpCooldown })}\n` +
                            `${tr.t('leveling.setup.doneMessage', { message: message === DEFAULT_LEVEL_UP_MESSAGE ? defaultLevelUpMessage(tr) : message })}\n\n` +
                            tr.t('leveling.setup.doneOutro'),
                        color: 'success',
                    }),
                ],
            });
        }
    },
};