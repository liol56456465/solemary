import { getColor } from '../../../config/bot.js';
import { PermissionFlagsBits } from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { getServerCounters, saveServerCounters, getCounterEmoji as getCounterTypeEmoji, getCounterTypeLabel, getGuildCounterStats, formatCounterChannelName, counterNameLanguage } from '../../../services/serverstatsService.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';
import { textForInteraction } from '../../../utils/botText.js';
export async function handleList(interaction, client) {
    const guild = interaction.guild;
    const tr = textForInteraction(interaction); // ephemeral: the admin's Discord language

    try {
        await InteractionHelper.safeDefer(interaction);
    } catch (error) {
        logger.error("Failed to defer reply:", error);
        return;
    }

    if (!hasAdminAccess(interaction)) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('serverstats.noAdmin.view') }).catch(logger.error);
        return;
    }

    try {
        const counters = await getServerCounters(client, guild.id);
        const stats = getGuildCounterStats(guild); // memberCount + cached bots, no member fetch
        const nameLang = counterNameLanguage(guild.id); // channel names are in the server's language

        const validCounters = [];
        const orphanedCounters = [];
        
        for (const counter of counters) {
            const channel = guild.channels.cache.get(counter.channelId);
            if (channel) {
                validCounters.push(counter);
            } else {
                orphanedCounters.push(counter);
                logger.info(`Removing orphaned counter ${counter.id} (type: ${counter.type}, deleted channel: ${counter.channelId}) from guild ${guild.id}`);
            }
        }

        if (orphanedCounters.length > 0) {
            await saveServerCounters(client, guild.id, validCounters);
            logger.info(`Cleaned up ${orphanedCounters.length} orphaned counter(s) from guild ${guild.id}`);
        }

        if (validCounters.length === 0) {
            const embed = createEmbed({
                title: tr.t('serverstats.list.title'),
                description: tr.t('serverstats.list.empty'),
                color: getColor('warning')
            });

            embed.addFields({
                name: tr.t('serverstats.list.typesName'),
                value: tr.t('serverstats.list.typesValue'),
                inline: false
            });

            embed.addFields({
                name: tr.t('serverstats.list.examplesName'),
                value: tr.t('serverstats.list.examplesValue'),
                inline: false
            });

            embed.setFooter({ 
                text: tr.t('serverstats.list.footer') 
            });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] }).catch(logger.error);
            return;
        }

        const embed = createEmbed({
            title: tr.t('serverstats.list.titleCount', { count: validCounters.length }),
            description: tr.t('serverstats.list.description'),
            color: getColor('info')
        });

        for (let i = 0; i < validCounters.length; i++) {
            const counter = validCounters[i];
            const channel = guild.channels.cache.get(counter.channelId);
            
            if (!channel) {
                
                logger.warn(`Counter ${counter.id} still has missing channel after cleanup`);
                continue;
            }

            const currentCount = getCurrentCount(stats, counter.type);
            const status = channel.name === formatCounterChannelName(counter.type, currentCount, { lang: nameLang }) ? tr.t('serverstats.list.upToDate') : tr.t('serverstats.list.notUpdated');
            
            embed.addFields({
                name: tr.t('serverstats.list.counterName', { number: i + 1, channelName: channel.name }),
                value: tr.t('serverstats.list.counterValue', {
                    id: counter.id,
                    type: getCounterTypeDisplay(counter.type, tr.lang),
                    channel: String(channel),
                    count: currentCount,
                    status,
                    // English keeps the old (server-locale) date; other languages their own format
                    created: tr.lang === 'en' ? new Date(counter.createdAt).toLocaleDateString() : new Date(counter.createdAt).toLocaleDateString(tr.lang),
                }),
                inline: false
            });
        }

        embed.addFields({
            name: tr.t('serverstats.list.totalsName'),
            value: tr.t('serverstats.list.totalsValue', {
                counters: validCounters.length,
                upToDate: validCounters.filter(c => {
                    const channel = guild.channels.cache.get(c.channelId);
                    return channel && channel.name === formatCounterChannelName(c.type, getCurrentCount(stats, c.type), { lang: nameLang });
                }).length,
                next: Math.floor(Date.now() / 1000) + 900,
            }),
            inline: false
        });

        embed.addFields({
            name: tr.t('serverstats.list.commandsName'),
            value: tr.t('serverstats.list.commandsValue'),
            inline: false
        });

        embed.setFooter({ 
            text: tr.t('serverstats.list.footer') 
        });
        embed.setTimestamp();

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] }).catch(logger.error);

    } catch (error) {
        logger.error("Error displaying counters:", error);
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('serverstats.error.loadFailed') }).catch(logger.error);
    }
}

function getCounterTypeDisplay(type, lang = 'en') {
    return getCounterTypeLabel(type, { lang });
}

function getCounterEmoji(type) {
    return getCounterTypeEmoji(type);
}

function getCurrentCount(stats, type) {
    switch (type) {
        case "members":
            return stats.totalCount;
        case "bots":
            return stats.botCount;
        case "members_only":
            return stats.humanCount;
        default:
            return 0;
    }
}