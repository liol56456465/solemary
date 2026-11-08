import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { handleCreate } from './modules/serverstats_create.js';
import { handleList } from './modules/serverstats_list.js';
import { handleUpdate } from './modules/serverstats_update.js';
import { handleDelete } from './modules/serverstats_delete.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations, englishDescription } from '../../utils/commandLocalizations.js';

const CHOICE_KEYS = {
    members: 'serverstats.cmd.choice.members',
    membersOnly: 'serverstats.cmd.choice.membersOnly',
    bots: 'serverstats.cmd.choice.bots',
    voice: 'serverstats.cmd.choice.voice',
    text: 'serverstats.cmd.choice.text',
};
/** A choice with its English name and the 7 other languages (value unchanged). */
const choice = (key, value) => ({ name: englishDescription(CHOICE_KEYS[key]), name_localizations: descriptionLocalizations(CHOICE_KEYS[key]), value });

export default {
    data: new SlashCommandBuilder()
        .setName("serverstats")
        .setDescription(englishDescription('serverstats.cmd.root')).setDescriptionLocalizations(descriptionLocalizations('serverstats.cmd.root'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand(subcommand =>
            subcommand
                .setName("create")
                .setDescription(englishDescription('serverstats.cmd.create.desc')).setDescriptionLocalizations(descriptionLocalizations('serverstats.cmd.create.desc'))
                .addStringOption(option =>
                    option
                        .setName("type")
                        .setDescription(englishDescription('serverstats.cmd.create.type')).setDescriptionLocalizations(descriptionLocalizations('serverstats.cmd.create.type'))
                        .setRequired(true)
                        .addChoices(
                            choice('members', "members"),
                            choice('membersOnly', "members_only"),
                            choice('bots', "bots")
                        )
                )
                .addStringOption(option =>
                    option
                        .setName("channel_type")
                        .setDescription(englishDescription('serverstats.cmd.create.channelType')).setDescriptionLocalizations(descriptionLocalizations('serverstats.cmd.create.channelType'))
                        .setRequired(true)
                        .addChoices(
                            choice('voice', "voice"),
                            choice('text', "text")
                        )
                )
                .addChannelOption(option =>
                    option
                        .setName("category")
                        .setDescription(englishDescription('serverstats.cmd.create.category')).setDescriptionLocalizations(descriptionLocalizations('serverstats.cmd.create.category'))
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildCategory)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("list")
                .setDescription(englishDescription('serverstats.cmd.list.desc')).setDescriptionLocalizations(descriptionLocalizations('serverstats.cmd.list.desc'))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("update")
                .setDescription(englishDescription('serverstats.cmd.update.desc')).setDescriptionLocalizations(descriptionLocalizations('serverstats.cmd.update.desc'))
                .addStringOption(option =>
                    option
                        .setName("counter-id")
                        .setDescription(englishDescription('serverstats.cmd.update.counterId')).setDescriptionLocalizations(descriptionLocalizations('serverstats.cmd.update.counterId'))
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("type")
                        .setDescription(englishDescription('serverstats.cmd.update.type')).setDescriptionLocalizations(descriptionLocalizations('serverstats.cmd.update.type'))
                        .setRequired(false)
                        .addChoices(
                            choice('members', "members"),
                            choice('membersOnly', "members_only"),
                            choice('bots', "bots")
                        )
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("delete")
                .setDescription(englishDescription('serverstats.cmd.delete.desc')).setDescriptionLocalizations(descriptionLocalizations('serverstats.cmd.delete.desc'))
                .addStringOption(option =>
                    option
                        .setName("counter-id")
                        .setDescription(englishDescription('serverstats.cmd.delete.counterId')).setDescriptionLocalizations(descriptionLocalizations('serverstats.cmd.delete.counterId'))
                        .setRequired(true)
                )
        ),

    async execute(interaction, guildConfig, client) {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case "create":
                await handleCreate(interaction, client);
                break;
            case "list":
                await handleList(interaction, client);
                break;
            case "update":
                await handleUpdate(interaction, client);
                break;
            case "delete":
                await handleDelete(interaction, client);
                break;
            default:
                await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: textForInteraction(interaction).t('serverstats.unknownSubcommand') });
        }
    }
};