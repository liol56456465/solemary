// giveaways.js

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logger } from './logger.js';
import { TitanBotError, ErrorTypes } from './errorHandler.js';
import { unwrapReplitData, upsertGiveawayRow, deleteGiveawayRow } from './database.js';
import { Mutex } from './mutex.js';
import { 
    createGiveawayEmbed as createGiveawayEmbedService,
    createGiveawayButtons as createGiveawayButtonsService,
    selectWinners as selectWinnersService
} from '../services/giveawayService.js';

export function giveawayKey(guildId) {
    return `guild:${guildId}:giveaways`;
}

function arrayToGiveawayMap(giveaways) {
    const map = {};
    if (Array.isArray(giveaways)) {
        for (const giveaway of giveaways) {
            if (giveaway && giveaway.messageId) {
                map[giveaway.messageId] = giveaway;
            }
        }
    }
    return map;
}

export async function getGuildGiveaways(client, guildId) {
    try {
        if (!client.db) {
            throw new TitanBotError('Database not available for getGuildGiveaways', ErrorTypes.DATABASE,
                'The database is not responding right now. Please try again in a moment.');
        }

        const key = giveawayKey(guildId);
        const giveaways = await client.db.get(key, {});
        const unwrappedGiveaways = unwrapReplitData(giveaways);

        if (typeof unwrappedGiveaways === 'object' && !Array.isArray(unwrappedGiveaways)) {
            return Object.values(unwrappedGiveaways || {});
        }
        return Array.isArray(unwrappedGiveaways) ? unwrappedGiveaways : [];
    } catch (error) {
        logger.error(`Error getting giveaways for guild ${guildId}:`, error);
        throw error;
    }
}

export async function saveGiveaway(client, guildId, giveawayData) {
    try {
        if (!client.db) {
            throw new TitanBotError('Database not available for saveGiveaway', ErrorTypes.DATABASE,
                'The database is not responding right now. Please try again in a moment.');
        }

        if (!giveawayData || !giveawayData.messageId) {
            throw new TitanBotError(
                'Invalid giveaway data: missing messageId',
                ErrorTypes.VALIDATION,
                'Cannot save giveaway without a message ID.',
                { giveawayData }
            );
        }

        if (await upsertGiveawayRow(client, guildId, giveawayData) === null) {
            // Key-value store: the whole guild map is rewritten, so serialize per guild.
            await Mutex.runExclusive(`giveaways:${guildId}`, async () => {
                const giveawayMap = arrayToGiveawayMap(await getGuildGiveaways(client, guildId));
                giveawayMap[giveawayData.messageId] = giveawayData;
                await client.db.set(giveawayKey(guildId), giveawayMap);
            });
        }
        
        logger.debug(`Saved giveaway ${giveawayData.messageId} in guild ${guildId}`);
        return true;
    } catch (error) {
        logger.error(`Error saving giveaway in guild ${guildId}:`, error);
        throw error;
    }
}

export async function deleteGiveaway(client, guildId, messageId) {
    if (!client.db) {
        throw new TitanBotError('Database not available for deleteGiveaway', ErrorTypes.DATABASE,
            'The database is not responding right now. Please try again in a moment.');
    }

    if (!messageId) {
        throw new TitanBotError(
            'Missing messageId parameter',
            ErrorTypes.VALIDATION,
            'Cannot delete giveaway without a message ID.',
            { messageId }
        );
    }

    const deletedRow = await deleteGiveawayRow(client, guildId, messageId);
    if (deletedRow !== null) {
        logger.debug(`Deleted giveaway ${messageId} from guild ${guildId}: ${deletedRow}`);
        return deletedRow;
    }

    // Key-value store: the whole guild map is rewritten, so serialize per guild.
    return Mutex.runExclusive(`giveaways:${guildId}`, async () => {
        const giveawayMap = arrayToGiveawayMap(await getGuildGiveaways(client, guildId));
        if (!giveawayMap[messageId]) {
            logger.debug(`Giveaway not found for deletion: ${messageId} in guild ${guildId}`);
            return false;
        }
        delete giveawayMap[messageId];
        await client.db.set(giveawayKey(guildId), giveawayMap);
        return true;
    });
}

export function createGiveawayEmbed(giveaway, status, winners = []) {
    try {
        return createGiveawayEmbedService(giveaway, status, winners);
    } catch (error) {
        logger.error('Error creating giveaway embed:', error);
        throw error;
    }
}

export function isGiveawayEnded(giveaway) {
    if (!giveaway) return true;
    const endTime = giveaway.endsAt || giveaway.endTime;
    return Date.now() > endTime;
}

export function pickWinners(entrants, count) {
    try {
        return selectWinnersService(entrants, count);
    } catch (error) {
        logger.error('Error picking winners:', error);
        
        if (!entrants || entrants.length === 0) return [];
        const requested = Math.min(count, entrants.length);
        const shuffled = [...entrants];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled.slice(0, requested);
    }
}

export function giveawayEmbed(giveaway, status, winners = []) {
    return createGiveawayEmbed(giveaway, status, winners);
}

export function giveawayButtons(ended = false) {
    try {
        return createGiveawayButtonsService(ended);
    } catch (error) {
        logger.error('Error creating giveaway buttons:', error);
        
        const row = new ActionRowBuilder();
        if (ended) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('giveaway_reroll')
                    .setLabel('🎲 Reroll')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('giveaway_view')
                    .setLabel('👁️ View')
                    .setStyle(ButtonStyle.Primary)
            );
        } else {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('giveaway_join')
                    .setLabel('🎉 Join')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('giveaway_end')
                    .setLabel('🛑 End')
                    .setStyle(ButtonStyle.Danger)
            );
        }
        return row;
    }
}