import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
import { getAppealsCategory } from '../../services/enforcement/appealService.js';

const SUPPORT_PANEL_CHANNEL = 'appeals';

function configError(message) {
    return new TitanBotError(message, ErrorTypes.CONFIGURATION, message, { expected: true });
}

function appealButton() {
    return new ButtonBuilder().setCustomId('appeal:open').setLabel('Appeal').setStyle(ButtonStyle.Primary);
}

function mainPanel() {
    return {
        embeds: [createEmbed({
            title: `${enforcementConfig.serverName} appeals`,
            description: [
                '**Muted or warned?** Press **Appeal** and fill in:',
                '1. Why it should be lifted',
                '2. Your case code, from the DM you got',
                '3. More info, if you want to add anything',
                '',
                'The administrators review your appeal and you get the decision by DM. Press **My appeals** any time to check where yours stand, or **My standing** to see your warnings and what a next warning would do.',
                '',
                '-# Banned? Appeal in the Meowist Support server instead — the link is in your ban DM.',
            ].join('\n'),
            color: 'primary',
        })],
        components: [new ActionRowBuilder().addComponents(appealButton(), myAppealsButton(), myStandingButton())],
    };
}

// Shows the member their own appeals and decisions, privately.
function myAppealsButton() {
    return new ButtonBuilder().setCustomId('appeal:status').setLabel('My appeals').setStyle(ButtonStyle.Secondary);
}

// Shows the member their own warnings, ladder level and next step, privately.
function myStandingButton() {
    return new ButtonBuilder().setCustomId('appeal:standing').setLabel('My standing').setStyle(ButtonStyle.Secondary);
}

function supportPanel() {
    return {
        embeds: [createEmbed({
            title: `${enforcementConfig.serverName} appeals`,
            description: [
                '**Appeal** — banned, kicked, muted or warned in Meowist? Press **Appeal** and fill in:',
                '1. Why it should be lifted',
                '2. Your case code, from the DM you got',
                '3. More info, if you want to add anything',
                '',
                'The administrators review your appeal and you get the decision by DM. Press **My appeals** any time to check where yours stand, or **My standing** to see your warnings and what a next warning would do.',
                '',
                '**Report staff** — report a staff member who broke the rules. Only administrators can see reports.',
                '',
                '-# Bans and mutes can be appealed while active; warnings and kicks within 30 days.',
            ].join('\n'),
            color: 'primary',
        })],
        components: [new ActionRowBuilder().addComponents(
            appealButton(),
            myAppealsButton(),
            myStandingButton(),
            new ButtonBuilder().setCustomId('appeal:report').setLabel('Report staff').setStyle(ButtonStyle.Danger),
        )],
    };
}

/** The support server's #appeals channel, created read-only for members if it doesn't exist. */
async function ensureSupportPanelChannel(supportGuild) {
    const existing = supportGuild.channels.cache.find((channel) =>
        channel.type === ChannelType.GuildText && channel.name === SUPPORT_PANEL_CHANNEL);
    if (existing) return { channel: existing, created: false };

    const channel = await supportGuild.channels.create({
        name: SUPPORT_PANEL_CHANNEL,
        type: ChannelType.GuildText,
        permissionOverwrites: [
            { id: supportGuild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
            { id: supportGuild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
        ],
        reason: '/setappeal',
    });
    return { channel, created: true };
}

/** Deletes earlier appeal panels the bot posted in this channel, so re-running doesn't stack them. */
async function removeOldPanels(channel) {
    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages) return;
    const panels = messages.filter((message) => message.author.id === channel.client.user.id
        && message.components.some((row) => row.components?.some((component) => component.customId === 'appeal:open')));
    for (const message of panels.values()) {
        await message.delete().catch((error) => logger.warn(`Could not delete old appeal panel ${message.id}: ${error.message}`));
    }
}

export default {
    // Registered as a guild command in MAIN_GUILD_ID only.
    scope: 'main',
    data: new SlashCommandBuilder()
        .setName('setappeal')
        .setDescription('Post the appeal panels: here (mutes/warns) and in #appeals in the support server (bans)')
        .addChannelOption((option) => option
            .setName('channel')
            .setDescription('Where to post the main-server panel (default: this channel)')
            .addChannelTypes(ChannelType.GuildText)),

    async execute(interaction, config, client) {
        if (interaction.guildId !== enforcementConfig.mainGuildId) {
            throw new TitanBotError('Wrong guild for /setappeal', ErrorTypes.PERMISSION,
                'This command only works in the main server.', { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                'You need the Administrator permission to set up appeals.', { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const appealsCategory = await getAppealsCategory(interaction.guild);
        if (!appealsCategory) {
            throw configError(`There is no ticket category to open appeals in. Set one in the ticket dashboard (/ticket), or make sure ${enforcementConfig.appealsCategoryId} is a category in this server.`);
        }
        const botPermissions = appealsCategory.permissionsFor(interaction.guild.members.me);
        if (!botPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels])) {
            throw configError(`I need View Channel and Manage Channels in the **${appealsCategory.name}** category to open appeal channels there.`);
        }

        const supportGuild = client.guilds.cache.get(enforcementConfig.supportGuildId);
        if (!supportGuild) {
            throw configError('I am not in the support server (SUPPORT_GUILD_ID), so the ban appeal panel cannot be posted.');
        }

        const mainChannel = interaction.options.getChannel('channel') || interaction.channel;
        const { channel: supportChannel, created } = await ensureSupportPanelChannel(supportGuild);

        await removeOldPanels(mainChannel);
        await mainChannel.send(mainPanel());
        await removeOldPanels(supportChannel);
        await supportChannel.send(supportPanel());

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Appeal panels posted', [
                `**Main server:** <#${mainChannel.id}>, for mutes and warns.`,
                `**Support server:** #${supportChannel.name}${created ? ' (created)' : ''}, for bans and kicks, plus staff reports.`,
                '',
                `Every appeal and report opens in **${appealsCategory.name}**, visible to administrators only.`,
                'Review and decide them with **/appeals**.',
            ].join('\n'))],
        });
    },
};
