import { getColor } from '../../../config/bot.js';
import { PermissionFlagsBits } from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { getServerCounters, saveServerCounters, getCounterEmoji as getCounterTypeEmoji, getCounterTypeLabel, getGuildCounterStats, formatCounterChannelName } from '../../../services/serverstatsService.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';
export async function handleList(interaction, client) {
    const guild = interaction.guild;

    try {
        await InteractionHelper.safeDefer(interaction);
    } catch (error) {
        logger.error("Failed to defer reply:", error);
        return;
    }

    if (!hasAdminAccess(interaction)) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the **Administrator** permission to view counters.' }).catch(logger.error);
        return;
    }

    try {
        const counters = await getServerCounters(client, guild.id);
        const stats = getGuildCounterStats(guild); // memberCount + cached bots, no member fetch

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
                title: "Server counters",
                description: "There are no counters yet.\n\nUse `/serverstats create` to add one.",
                color: getColor('warning')
            });

            embed.addFields({
                name: "Counter types",
                value: "**Members + Bots**: everyone\n**Members Only**: people, no bots\n**Bots Only**: just bots",
                inline: false
            });

            embed.addFields({
                name: "Examples",
                value: "`/serverstats create type:members channel_type:voice category:Stats`\n`/serverstats create type:bots channel_type:text category:Server Info`\n`/serverstats list`",
                inline: false
            });

            embed.setFooter({ 
                text: "Counters update every 15 minutes" 
            });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] }).catch(logger.error);
            return;
        }

        const embed = createEmbed({
            title: `Server counters (${validCounters.length})`,
            description: "All counters in this server. They update every 15 minutes.",
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
            const status = channel.name === formatCounterChannelName(counter.type, currentCount) ? 'Up to date' : 'Not updated yet';
            
            embed.addFields({
                name: `Counter #${i + 1} · ${channel.name}`,
                value: `**ID:** \`${counter.id}\`\n**Type:** ${getCounterTypeDisplay(counter.type)}\n**Channel:** ${channel}\n**Count:** ${currentCount}\n**Status:** ${status}\n**Created:** ${new Date(counter.createdAt).toLocaleDateString()}`,
                inline: false
            });
        }

        embed.addFields({
            name: "Totals",
            value: `**Counters:** ${validCounters.length}\n**Up to date:** ${validCounters.filter(c => {
                const channel = guild.channels.cache.get(c.channelId);
                return channel && channel.name === formatCounterChannelName(c.type, getCurrentCount(stats, c.type));
            }).length}\n**Next update:** <t:${Math.floor(Date.now() / 1000) + 900}:R>`,
            inline: false
        });

        embed.addFields({
            name: "Commands",
            value: "`/serverstats create`: add a counter\n`/serverstats update`: change a counter\n`/serverstats delete`: remove a counter",
            inline: false
        });

        embed.setFooter({ 
            text: "Counters update every 15 minutes" 
        });
        embed.setTimestamp();

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] }).catch(logger.error);

    } catch (error) {
        logger.error("Error displaying counters:", error);
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Couldn\'t load the counters. Try again.' }).catch(logger.error);
    }
}

function getCounterTypeDisplay(type) {
    return getCounterTypeLabel(type);
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