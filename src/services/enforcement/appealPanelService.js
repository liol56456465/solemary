// appealPanelService.js — the appeal panels: the main server's (mutes and warns) and
// the support server's #appeals (bans, kicks, staff reports). Shared by /setappeal
// and the web dashboard. Re-posting replaces the earlier panels the bot posted in
// the same channel, so they never stack.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { getAppealsCategory } from './appealService.js';

export const SUPPORT_PANEL_CHANNEL = 'appeals';

function configError(message) {
    return new TitanBotError(message, ErrorTypes.CONFIGURATION, message, { expected: true });
}

function appealButton() {
    return new ButtonBuilder().setCustomId('appeal:open').setLabel('Appeal').setStyle(ButtonStyle.Primary);
}

// Shows the member their own appeals and decisions, privately.
function myAppealsButton() {
    return new ButtonBuilder().setCustomId('appeal:status').setLabel('My appeals').setStyle(ButtonStyle.Secondary);
}

// Shows the member their own warnings, ladder level and next step, privately.
function myStandingButton() {
    return new ButtonBuilder().setCustomId('appeal:standing').setLabel('My standing').setStyle(ButtonStyle.Secondary);
}

export function mainAppealPanel() {
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

export function supportAppealPanel() {
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
export async function ensureSupportPanelChannel(supportGuild, reason = '/setappeal') {
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
        reason,
    });
    return { channel, created: true };
}

/** Deletes earlier appeal panels the bot posted in this channel, so re-running doesn't stack them. */
export async function removeOldAppealPanels(channel) {
    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages) return 0;
    const panels = messages.filter((message) => message.author.id === channel.client.user.id
        && message.components.some((row) => row.components?.some((component) => component.customId === 'appeal:open')));
    let removed = 0;
    for (const message of panels.values()) {
        await message.delete().then(() => { removed += 1; })
            .catch((error) => logger.warn(`Could not delete old appeal panel ${message.id}: ${error.message}`));
    }
    return removed;
}

/**
 * Posts (or re-posts) both appeal panels. Checks first: an appeals category the bot can
 * open channels in, the support server present, and the bot able to post in the main
 * channel. Resolves { mainChannel, supportChannel, created, category }.
 */
export async function postAppealPanels(client, mainGuild, mainChannel, { reason = '/setappeal' } = {}) {
    const appealsCategory = await getAppealsCategory(mainGuild);
    if (!appealsCategory) {
        throw configError('There is no category to open appeals in. Set the appeals category in the dashboard (Enforcement & appeals), or a ticket category.');
    }
    const botPermissions = appealsCategory.permissionsFor(mainGuild.members.me);
    if (!botPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels])) {
        throw configError(`I need View Channel and Manage Channels in the **${appealsCategory.name}** category to open appeal channels there.`);
    }

    const supportGuild = client.guilds.cache.get(enforcementConfig.supportGuildId);
    if (!supportGuild) {
        throw configError('I am not in the support server (SUPPORT_GUILD_ID), so the ban appeal panel cannot be posted.');
    }
    const inMain = typeof mainChannel?.permissionsFor === 'function' ? mainChannel.permissionsFor(mainGuild.members.me) : null;
    if (!inMain?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw configError(`I need View Channel, Send Messages and Embed Links in <#${mainChannel?.id}> to post the appeal panel.`);
    }

    const { channel: supportChannel, created } = await ensureSupportPanelChannel(supportGuild, reason);

    await removeOldAppealPanels(mainChannel);
    await mainChannel.send(mainAppealPanel());
    await removeOldAppealPanels(supportChannel);
    await supportChannel.send(supportAppealPanel());

    return { mainChannel, supportChannel, created, category: appealsCategory };
}
