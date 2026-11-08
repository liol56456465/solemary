// appealPanelService.js — the appeal panels: the main server's (mutes and warns) and
// the support server's #appeals (bans, kicks, staff reports). Shared by /setappeal
// and the web dashboard. Re-posting replaces the earlier panels the bot posted in
// the same channel, so they never stack.
//
// Language (utils/botText.js): a panel is a public post, so it is in the language of the server
// it is posted in, whoever posts it (/setappeal or the dashboard). The setup errors go to the
// admin who posts: `lang` (the slash command passes the admin's; the dashboard keeps English).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { botText, resolveBotLanguage } from '../../utils/botText.js';
import { getAppealsCategory } from './appealService.js';
import { getFromDb, setInDb } from '../../utils/database.js';

/** A panel's language: the server it is posted in. */
const panelLanguage = (guildId) => resolveBotLanguage({ guildId, purpose: 'public' });

export const SUPPORT_PANEL_CHANNEL = 'appeals';

/** Key-value store key of "the appeal panels were posted" (dashboard Getting started). */
export const appealPanelKey = (guildId) => `appealPanels:posted:${guildId}`;

/** { at, mainChannelId, supportChannelId } of the last posting, or null. A database error throws. */
export async function getAppealPanelPosting(guildId) {
    return getFromDb(appealPanelKey(guildId), null);
}

function configError(message) {
    return new TitanBotError(message, ErrorTypes.CONFIGURATION, message, { expected: true });
}

function appealButton(tr) {
    return new ButtonBuilder().setCustomId('appeal:open').setLabel(tr.t('staff.setappeal.panel.appealButton')).setStyle(ButtonStyle.Primary);
}

// Shows the member their own appeals and decisions, privately.
function myAppealsButton(tr) {
    return new ButtonBuilder().setCustomId('appeal:status').setLabel(tr.t('staff.setappeal.panel.myAppealsButton')).setStyle(ButtonStyle.Secondary);
}

// Shows the member their own warnings, ladder level and next step, privately.
function myStandingButton(tr) {
    return new ButtonBuilder().setCustomId('appeal:standing').setLabel(tr.t('staff.setappeal.panel.myRecordButton')).setStyle(ButtonStyle.Secondary);
}

function reportButton(tr) {
    return new ButtonBuilder().setCustomId('appeal:report').setLabel(tr.t('staff.setappeal.panel.reportButton')).setStyle(ButtonStyle.Danger);
}

/** The three form steps and the "how it works" line every panel shares. */
function formSteps(tr) {
    return [
        tr.t('staff.setappeal.panel.step1'),
        tr.t('staff.setappeal.panel.step2'),
        tr.t('staff.setappeal.panel.step3'),
        '',
        tr.t('staff.setappeal.panel.howItWorks'),
    ];
}

export function mainAppealPanel({ lang = 'en' } = {}) {
    const tr = botText(lang);
    return {
        embeds: [createEmbed({
            title: tr.t('staff.setappeal.panel.title', { server: enforcementConfig.serverName }),
            description: [
                tr.t('staff.setappeal.panel.mainIntro'),
                ...formSteps(tr),
                '',
                tr.t('staff.setappeal.panel.mainBanned'),
            ].join('\n'),
            color: 'primary',
        })],
        components: [new ActionRowBuilder().addComponents(appealButton(tr), myAppealsButton(tr), myStandingButton(tr))],
    };
}

export function supportAppealPanel({ lang = 'en' } = {}) {
    const tr = botText(lang);
    return {
        embeds: [createEmbed({
            title: tr.t('staff.setappeal.panel.title', { server: enforcementConfig.serverName }),
            description: [
                tr.t('staff.setappeal.panel.supportIntro'),
                ...formSteps(tr),
                '',
                tr.t('staff.setappeal.panel.reportLine'),
                '',
                tr.t('staff.setappeal.panel.supportWindows'),
            ].join('\n'),
            color: 'primary',
        })],
        components: [new ActionRowBuilder().addComponents(
            appealButton(tr),
            myAppealsButton(tr),
            myStandingButton(tr),
            reportButton(tr),
        )],
    };
}

/**
 * The one panel of a server that is not Mewvo's (multi-server B1): appeals for its own mutes,
 * warns and kicks, My appeals, My record and Report staff, all handled in that server.
 */
export function serverAppealPanel(guildName, { lang = 'en' } = {}) {
    const tr = botText(lang);
    return {
        embeds: [createEmbed({
            title: tr.t('staff.setappeal.panel.title', { server: String(guildName || tr.t('staff.setappeal.panel.serverFallback')).slice(0, 200) }),
            description: [
                tr.t('staff.setappeal.panel.serverIntro'),
                ...formSteps(tr),
                '',
                tr.t('staff.setappeal.panel.reportLine'),
            ].join('\n'),
            color: 'primary',
        })],
        components: [new ActionRowBuilder().addComponents(
            appealButton(tr),
            myAppealsButton(tr),
            myStandingButton(tr),
            reportButton(tr),
        )],
    };
}

/**
 * Posts (or re-posts) the panel of a server that is not Mewvo's, in `channel` of that server.
 * Checks first: a category to open appeals in (its appeals category, else its /ticket one) the
 * bot can open channels in, and the bot able to post in the channel. Never touches the Support
 * server. Resolves { channel, category }.
 */
export async function postServerAppealPanel(guild, channel, { reason = '/setappeal', lang = 'en' } = {}) {
    const tr = botText(lang);
    const category = await getAppealsCategory(guild);
    if (!category) {
        throw configError(tr.t('staff.setappeal.error.noServerCategory'));
    }
    const botPermissions = category.permissionsFor(guild.members.me);
    if (!botPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels])) {
        throw configError(tr.t('staff.setappeal.error.categoryPermissions', { category: category.name }));
    }
    const here = typeof channel?.permissionsFor === 'function' ? channel.permissionsFor(guild.members.me) : null;
    if (!here?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw configError(tr.t('staff.setappeal.error.channelPermissions', { channelId: channel?.id }));
    }
    await removeOldAppealPanels(channel);
    await channel.send(serverAppealPanel(guild.name, { lang: panelLanguage(guild.id) }));
    await setInDb(appealPanelKey(guild.id), { at: new Date().toISOString(), mainChannelId: channel.id, supportChannelId: null, reason })
        .catch((error) => logger.warn(`Could not remember the appeal panel posting: ${error.message}`));
    return { channel, category };
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
export async function postAppealPanels(client, mainGuild, mainChannel, { reason = '/setappeal', lang = 'en' } = {}) {
    const tr = botText(lang);
    const appealsCategory = await getAppealsCategory(mainGuild);
    if (!appealsCategory) {
        throw configError(tr.t('staff.setappeal.error.noMainCategory'));
    }
    const botPermissions = appealsCategory.permissionsFor(mainGuild.members.me);
    if (!botPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels])) {
        throw configError(tr.t('staff.setappeal.error.categoryPermissions', { category: appealsCategory.name }));
    }

    const supportGuild = client.guilds.cache.get(enforcementConfig.supportGuildId);
    if (!supportGuild) {
        throw configError(tr.t('staff.setappeal.error.noSupportServer'));
    }
    const inMain = typeof mainChannel?.permissionsFor === 'function' ? mainChannel.permissionsFor(mainGuild.members.me) : null;
    if (!inMain?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw configError(tr.t('staff.setappeal.error.channelPermissions', { channelId: mainChannel?.id }));
    }

    const { channel: supportChannel, created } = await ensureSupportPanelChannel(supportGuild, reason);

    // Each panel in the language of the server it is posted in.
    await removeOldAppealPanels(mainChannel);
    await mainChannel.send(mainAppealPanel({ lang: panelLanguage(mainGuild.id) }));
    await removeOldAppealPanels(supportChannel);
    await supportChannel.send(supportAppealPanel({ lang: panelLanguage(supportGuild.id) }));
    // Remembered for the dashboard checklist only: a failed write must not undo the posting.
    await setInDb(appealPanelKey(mainGuild.id), { at: new Date().toISOString(), mainChannelId: mainChannel.id, supportChannelId: supportChannel.id })
        .catch((error) => logger.warn(`Could not remember the appeal panel posting: ${error.message}`));

    return { mainChannel, supportChannel, created, category: appealsCategory };
}
