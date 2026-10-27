// giveawayService.js

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../utils/errorHandler.js';
import { getColor, botConfig } from '../config/bot.js';
import { getEndedGiveaways, markGiveawayEnded } from '../utils/database.js';
import { getGuildGiveaways, saveGiveaway } from '../utils/giveaways.js';
import { Mutex } from '../utils/mutex.js';
import { checkRateLimit, getRateLimitStatus } from '../utils/rateLimiter.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';

const GIVEAWAY_CONFIG = botConfig.giveaways || {};
const GIVEAWAY_INTERACTION_COOLDOWN = 1000;

function getGiveawayInteractionKey(userId, giveawayId) {
    return `giveaway:${userId}:${giveawayId}`;
}

export function parseDuration(durationString) {
    if (!durationString || typeof durationString !== 'string') {
        throw new TitanBotError(
            'Invalid duration format provided',
            ErrorTypes.VALIDATION,
            'Please provide a valid duration (e.g., 1h, 30m, 5d, 10s).',
            { durationString }
        );
    }

    const regex = /^(\d+)([hmds])$/i;
    const match = durationString.trim().match(regex);

    if (!match) {
        throw new TitanBotError(
            `Invalid duration format: ${durationString}`,
            ErrorTypes.VALIDATION,
            'Invalid duration format. Use: 1h, 30m, 5d, 10s (min: 10s, max: 30d)',
            { input: durationString }
        );
    }

    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    if (amount <= 0 || amount > 999) {
        throw new TitanBotError(
            `Duration amount out of range: ${amount}`,
            ErrorTypes.VALIDATION,
            'Duration amount must be between 1 and 999.',
            { amount, unit }
        );
    }

    let ms = 0;
    switch (unit) {
        case 's':
            ms = amount * 1000;
            break;
        case 'm':
            ms = amount * 60 * 1000;
            break;
        case 'h':
            ms = amount * 60 * 60 * 1000;
            break;
        case 'd':
            ms = amount * 24 * 60 * 60 * 1000;
            break;
        default:
            throw new TitanBotError(
                `Unknown duration unit: ${unit}`,
                ErrorTypes.VALIDATION,
                'Please use s (seconds), m (minutes), h (hours), or d (days).',
                { unit }
            );
    }

    const maxDuration = GIVEAWAY_CONFIG.maximumDuration ?? 30 * 24 * 60 * 60 * 1000;
    if (ms > maxDuration) {
        throw new TitanBotError(
            `Duration exceeds maximum: ${ms}ms > ${maxDuration}ms`,
            ErrorTypes.VALIDATION,
            `Maximum duration is ${Math.floor(maxDuration / (24 * 60 * 60 * 1000))} days.`,
            { requestedMs: ms, maxMs: maxDuration }
        );
    }

    const minDuration = GIVEAWAY_CONFIG.minimumDuration ?? 10 * 1000;
    if (ms < minDuration) {
        throw new TitanBotError(
            `Duration below minimum: ${ms}ms < ${minDuration}ms`,
            ErrorTypes.VALIDATION,
            `Minimum duration is ${Math.ceil(minDuration / 1000)} seconds.`,
            { requestedMs: ms, minMs: minDuration }
        );
    }

    return ms;
}

export function validatePrize(prize) {
    if (!prize || typeof prize !== 'string') {
        throw new TitanBotError(
            'Prize must be a non-empty string',
            ErrorTypes.VALIDATION,
            'Please provide a valid prize description.',
            { prize }
        );
    }

    const trimmed = prize.trim();
    if (trimmed.length === 0 || trimmed.length > 256) {
        throw new TitanBotError(
            `Prize length out of range: ${trimmed.length}`,
            ErrorTypes.VALIDATION,
            'Prize must be between 1 and 256 characters.',
            { length: trimmed.length }
        );
    }

    return trimmed;
}

export function validateWinnerCount(winnerCount) {
    const minimumWinners = GIVEAWAY_CONFIG.minimumWinners ?? 1;
    const maximumWinners = GIVEAWAY_CONFIG.maximumWinners ?? 10;

    if (!Number.isInteger(winnerCount) || winnerCount < minimumWinners || winnerCount > maximumWinners) {
        throw new TitanBotError(
            `Invalid winner count: ${winnerCount}`,
            ErrorTypes.VALIDATION,
            `Winner count must be between ${minimumWinners} and ${maximumWinners}.`,
            { winnerCount, minimumWinners, maximumWinners }
        );
    }
}

export function createGiveawayEmbed(giveaway, status, winners = []) {
    try {
        const statusEmoji = status === 'ended' ? '🎉' : status === 'reroll' ? '🔄' : '🎉';
        const isEnded = status === 'ended' || status === 'reroll';
        const color = isEnded ? getColor('giveaway.ended') : getColor('giveaway.active');
        
        const embed = new EmbedBuilder()
            .setTitle(`${statusEmoji} ${giveaway.prize}`)
            .setDescription('React with the button below to enter!')
            .setColor(color)
            .addFields(
                { name: '👤 Hosted by', value: `<@${giveaway.hostId}>`, inline: true },
                { name: '🏆 Winners', value: giveaway.winnerCount.toString(), inline: true },
                { name: '👥 Entries', value: giveaway.participants?.length?.toString() || '0', inline: true }
            );

        if (isEnded) {
            const winnerDisplay = winners.length > 0 
                ? winners.map(id => `<@${id}>`).join(', ')
                : 'No valid entries';
            embed.addFields({ name: '🎯 Winners', value: winnerDisplay, inline: false });
        } else {
            const endTime = giveaway.endsAt || giveaway.endTime;
            embed.addFields({ name: '⏰ Ends', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false });
        }

        embed.setTimestamp();
        
        return embed;
    } catch (error) {
        logger.error('Error creating giveaway embed:', error);
        throw new TitanBotError(
            'Failed to create giveaway embed',
            ErrorTypes.UNKNOWN,
            'An internal error occurred while formatting the giveaway.',
            { error: error.message }
        );
    }
}

export function createGiveawayButtons(ended = false) {
    try {
        const row = new ActionRowBuilder();

        if (ended) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('giveaway_reroll')
                    .setLabel('🎲 Reroll')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(false),
                new ButtonBuilder()
                    .setCustomId('giveaway_view')
                    .setLabel('👁️ View Winners')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(false)
            );
        } else {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('giveaway_join')
                    .setLabel('🎉 Join')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(false),
                new ButtonBuilder()
                    .setCustomId('giveaway_end')
                    .setLabel('🛑 End')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(false)
            );
        }

        return row;
    } catch (error) {
        logger.error('Error creating giveaway buttons:', error);
        throw new TitanBotError(
            'Failed to create giveaway buttons',
            ErrorTypes.UNKNOWN,
            'An internal error occurred while creating interactive buttons.',
            { error: error.message }
        );
    }
}

export function selectWinners(participants, winnerCount) {
    if (!Array.isArray(participants) || participants.length === 0) {
        return [];
    }

    const uniqueParticipants = [...new Set(participants)];

    if (!Number.isInteger(winnerCount) || winnerCount < 1) {
        throw new TitanBotError(
            'Invalid winner count for selection',
            ErrorTypes.VALIDATION,
            'Winner count must be at least 1.',
            { winnerCount }
        );
    }

    const requested = Math.min(winnerCount, uniqueParticipants.length);
    
    try {
        
        const shuffled = [...uniqueParticipants];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled.slice(0, requested);
    } catch (error) {
        logger.error('Error selecting winners:', error);
        throw new TitanBotError(
            'Failed to select winners',
            ErrorTypes.UNKNOWN,
            'An error occurred while selecting winners.',
            { error: error.message, participantCount: participants.length }
        );
    }
}

export function isUserRateLimited(userId, giveawayId) {
    const status = getRateLimitStatus(
        getGiveawayInteractionKey(userId, giveawayId),
        GIVEAWAY_INTERACTION_COOLDOWN,
    );
    return status.attempts >= 1 && status.remaining > 0;
}

export async function recordUserInteraction(userId, giveawayId) {
    await checkRateLimit(
        getGiveawayInteractionKey(userId, giveawayId),
        1,
        GIVEAWAY_INTERACTION_COOLDOWN,
    );
}

export async function endGiveaway(client, giveaway, guildId, endedBy) {
    try {
        if (!giveaway) {
            throw new TitanBotError(
                'Giveaway object is null or undefined',
                ErrorTypes.VALIDATION,
                'Cannot end a non-existent giveaway.',
                { giveaway }
            );
        }

        if (giveaway.ended === true || giveaway.isEnded === true) {
            throw new TitanBotError(
                `Giveaway ${giveaway.messageId} is already ended`,
                ErrorTypes.VALIDATION,
                'This giveaway has already ended.',
                { giveawayId: giveaway.messageId, status: 'already_ended' }
            );
        }

        const participants = giveaway.participants || [];
        const winners = selectWinners(participants, giveaway.winnerCount || 1);

        const updatedGiveaway = {
            ...giveaway,
            ended: true,
            isEnded: true,
            winnerIds: winners,
            endedAt: new Date().toISOString(),
            endedBy: endedBy,
            participantCount: participants.length
        };

        logger.info(`Ending giveaway ${giveaway.messageId}: selected ${winners.length} winners from ${participants.length} entries`);

        return {
            giveaway: updatedGiveaway,
            winners: winners,
            participantCount: participants.length
        };
    } catch (error) {
        if (error instanceof TitanBotError) {
            logger.debug(`Giveaway end validation error: ${error.message}`, error.context || {});
            throw error;
        }
        logger.error('Error ending giveaway:', error);
        throw new TitanBotError(
            'Failed to end giveaway',
            ErrorTypes.UNKNOWN,
            'An error occurred while ending the giveaway.',
            { error: error.message, giveawayId: giveaway?.messageId }
        );
    }
}

export async function checkGiveaways(client) {
  try {
    if (!client.db) {
      logger.warn('Database not available for giveaway check');
      return;
    }

    const endedGiveaways = await getEndedGiveaways(client);
    
    if (endedGiveaways.length === 0) {
      return;
    }

    logger.info(`Processing ${endedGiveaways.length} ended giveaways`);

    for (const giveawayRecord of endedGiveaways) {
      // Same lock as the Join button (giveawayButtons.js).
      await Mutex.runExclusive(`giveaway:${giveawayRecord.message_id}`, async () => {
        try {
          const { id: giveawayId, guild_id: guildId, message_id: messageId, data: giveawayData } = giveawayRecord;
          // Re-read under the join lock: entries added since the query count, and a
          // giveaway already ended by an overlapping run is skipped.
          const fresh = (await getGuildGiveaways(client, guildId)).find((g) => String(g.messageId) === String(messageId));
          if (fresh?.ended || fresh?.isEnded) return;
          const giveaway = fresh || (typeof giveawayData === 'string' ? JSON.parse(giveawayData) : giveawayData);

          const guild = client.guilds.cache.get(guildId);
          if (!guild) {
            logger.debug(`Guild ${guildId} not found, skipping giveaway ${messageId}`);
            return;
          }

          const channel = await guild.channels.fetch(giveaway.channelId).catch(() => null);
          if (!channel) {
            logger.debug(`Channel ${giveaway.channelId} not found for giveaway ${messageId}`);
            return;
          }

          const message = await channel.messages.fetch(messageId).catch(() => null);
          if (!message) {
            logger.debug(`Message ${messageId} not found for giveaway in channel ${giveaway.channelId}`);
            return;
          }

          const participants = giveaway.participants || [];
          const winners = selectWinners(participants, giveaway.winnerCount || 1);

          const winnerMentions = winners.length > 0
            ? winners.map(id => `<@${id}>`).join(', ')
            : 'No valid entries!';

          const endedEmbed = createGiveawayEmbed(giveaway, 'ended', winners);

          await message.edit({
            embeds: [endedEmbed],
            components: [createGiveawayButtons(true)]
          });

          giveaway.ended = true;
          giveaway.isEnded = true;
          giveaway.winnerIds = winners;
          giveaway.endedAt = new Date().toISOString();
          // The key-value fallback of markGiveawayEnded needs guildId on the record;
          // without it the giveaway is never marked ended and gets re-ended every tick.
          giveaway.guildId = giveaway.guildId || guildId;
          giveaway.messageId = giveaway.messageId || messageId;

          const markedSuccess = await markGiveawayEnded(client, giveawayId, giveaway);
          if (!markedSuccess) {
            logger.warn(`Failed to mark giveaway ${messageId} as ended in database`);
          }

          if (winners.length > 0) {
            const winnerAnnouncement = `🎉 Congratulations ${winnerMentions}! You won the **${giveaway.prize || 'giveaway'}**! Please contact <@${giveaway.hostId}> to claim your prize.`;
            const winnerPingMsg = await channel.send({ content: winnerAnnouncement });
            giveaway.winnerPingMessageId = winnerPingMsg.id;
            await markGiveawayEnded(client, giveawayId, giveaway);

            try {
              await logEvent({
                client,
                guildId,
                eventType: EVENT_TYPES.GIVEAWAY_WINNER,
                data: {
                  description: `Giveaway ended with ${winners.length} winner(s)`,
                  channelId: channel.id,
                  fields: [
                    {
                      name: '🎁 Prize',
                      value: giveaway.prize || 'Mystery Prize!',
                      inline: true
                    },
                    {
                      name: '🏆 Winners',
                      value: winners.map(id => `<@${id}>`).join(', '),
                      inline: false
                    },
                    {
                      name: '👥 Entries',
                      value: participants.length.toString(),
                      inline: true
                    }
                  ]
                }
              });
            } catch (error) {
              logger.debug('Error logging giveaway winner:', error);
            }
          } else {
            await channel.send({ content: `The giveaway for **${giveaway.prize}** has ended with no valid entries.` });
          }

          logger.info(`Ended giveaway ${messageId} in guild ${guildId}`);
        } catch (error) {
          logger.error(`Error processing giveaway:`, error);
        }
      });
    }
  } catch (error) {
    logger.error('Error checking giveaways:', error);
  }
}

// ── End now / reroll ──────────────────────────────────────────────────────────
// Shared by /gend, /greroll and the web dashboard. Both run under the same
// per-giveaway lock as the Join button and the scheduled end (checkGiveaways), and
// re-read the giveaway inside it, so entries and a concurrent end aren't lost.

function validateGiveawayMessageId(messageId) {
  if (!messageId || !/^\d+$/.test(messageId)) {
    throw new TitanBotError(
      'Invalid message ID format',
      ErrorTypes.VALIDATION,
      'Please provide a valid message ID.',
      { providedId: messageId }
    );
  }
}

async function findGiveaway(client, guildId, messageId) {
  const giveaways = await getGuildGiveaways(client, guildId);
  const giveaway = giveaways.find(g => g.messageId === messageId);
  if (!giveaway) {
    throw new TitanBotError(
      `Giveaway not found: ${messageId}`,
      ErrorTypes.VALIDATION,
      'No giveaway was found with that message ID in the database.',
      { messageId, guildId }
    );
  }
  return giveaway;
}

async function fetchGiveawayChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(err => {
    logger.warn(`Could not fetch channel ${channelId}:`, err.message);
    return null;
  });
  return channel && channel.isTextBased() ? channel : null;
}

async function fetchGiveawayMessage(channel, messageId) {
  return channel.messages.fetch(messageId).catch(err => {
    logger.warn(`Could not fetch message ${messageId}:`, err.message);
    return null;
  });
}

/**
 * Ends an active giveaway now: picks winners, saves, edits the giveaway message,
 * announces the winners and logs GIVEAWAY_WINNER. Resolves
 * { giveaway, winners, participantCount, channelId, messageFound }.
 * Throws TitanBotError (userMessage) for a bad id, an unknown or already-ended
 * giveaway, and a missing channel or message (the ended state is saved first).
 */
export async function endGiveawayNow(client, guildId, messageId, endedBy) {
  validateGiveawayMessageId(messageId);

  return Mutex.runExclusive(`giveaway:${messageId}`, async () => {
    const giveaway = await findGiveaway(client, guildId, messageId);
    const endResult = await endGiveaway(client, giveaway, guildId, endedBy);
    const updatedGiveaway = endResult.giveaway;
    const winners = endResult.winners;

    const channel = await fetchGiveawayChannel(client, updatedGiveaway.channelId);
    if (!channel) {
      await saveGiveaway(client, guildId, updatedGiveaway);
      throw new TitanBotError(
        `Channel not found: ${updatedGiveaway.channelId}`,
        ErrorTypes.VALIDATION,
        'Could not find the channel where the giveaway was hosted. The giveaway state has been updated.',
        { channelId: updatedGiveaway.channelId, messageId }
      );
    }

    const message = await fetchGiveawayMessage(channel, messageId);
    if (!message) {
      await saveGiveaway(client, guildId, updatedGiveaway);
      throw new TitanBotError(
        `Message not found: ${messageId}`,
        ErrorTypes.VALIDATION,
        'Could not find the giveaway message. The giveaway state has been updated.',
        { messageId, channelId: updatedGiveaway.channelId }
      );
    }

    await saveGiveaway(client, guildId, updatedGiveaway);

    await message.edit({
      content: '🎉 **GIVEAWAY ENDED** 🎉',
      embeds: [createGiveawayEmbed(updatedGiveaway, 'ended', winners)],
      components: [createGiveawayButtons(true)],
    });

    if (winners.length > 0) {
      const winnerMentions = winners.map((id) => `<@${id}>`).join(',');
      const winnerPingMsg = await channel.send({
        content: `🎉 CONGRATULATIONS ${winnerMentions}! You won the **${updatedGiveaway.prize}** giveaway! Please contact the host <@${updatedGiveaway.hostId}> to claim your prize.`,
      });
      updatedGiveaway.winnerPingMessageId = winnerPingMsg.id;
      await saveGiveaway(client, guildId, updatedGiveaway);

      logger.info(`Giveaway ended with ${winners.length} winner(s): ${messageId}`);

      try {
        await logEvent({
          client,
          guildId,
          eventType: EVENT_TYPES.GIVEAWAY_WINNER,
          data: {
            description: `Giveaway ended with ${winners.length} winner(s)`,
            channelId: channel.id,
            userId: endedBy,
            fields: [
              { name: 'Prize', value: updatedGiveaway.prize || 'Mystery Prize!', inline: true },
              { name: 'Winners', value: winnerMentions, inline: false },
              { name: 'Entries', value: endResult.participantCount.toString(), inline: true },
            ],
          },
        });
      } catch (logError) {
        logger.debug('Error logging giveaway winner event:', logError);
      }
    } else {
      await channel.send({
        content: `The giveaway for **${updatedGiveaway.prize}** has ended with no valid entries.`,
      });
      logger.info(`Giveaway ended with no winners: ${messageId}`);
    }

    return {
      giveaway: updatedGiveaway,
      winners,
      participantCount: endResult.participantCount,
      channelId: channel.id,
      messageFound: true,
    };
  });
}

/**
 * Picks new winners for an ended giveaway, saves them, updates the giveaway message
 * (when found) and the winner ping, and logs GIVEAWAY_REROLL. Resolves
 * { giveaway, winners, participantCount, channelId, messageFound }: channelId is null
 * when the channel is gone (winners saved, nothing announced); messageFound is false
 * when only the giveaway message is gone (winners announced in the channel).
 * Throws TitanBotError (userMessage) for a bad id, an unknown or still-active
 * giveaway, and too few entries.
 */
export async function rerollGiveaway(client, guildId, messageId, rerolledBy) {
  validateGiveawayMessageId(messageId);

  return Mutex.runExclusive(`giveaway:${messageId}`, async () => {
    const giveaway = await findGiveaway(client, guildId, messageId);

    if (!giveaway.isEnded && !giveaway.ended) {
      throw new TitanBotError(
        `Giveaway still active: ${messageId}`,
        ErrorTypes.VALIDATION,
        'This giveaway is still active. Please use `/giveaway end` to end it first.',
        { messageId, status: 'active' }
      );
    }

    const participants = giveaway.participants || [];
    if (participants.length < giveaway.winnerCount) {
      throw new TitanBotError(
        `Insufficient participants for reroll: ${participants.length} < ${giveaway.winnerCount}`,
        ErrorTypes.VALIDATION,
        'Not enough entries to pick the required number of winners.',
        { participantsCount: participants.length, winnersNeeded: giveaway.winnerCount }
      );
    }

    const newWinners = selectWinners(participants, giveaway.winnerCount);
    const updatedGiveaway = {
      ...giveaway,
      winnerIds: newWinners,
      rerolledAt: new Date().toISOString(),
      rerolledBy,
    };
    const result = (channelId, messageFound) => ({
      giveaway: updatedGiveaway,
      winners: newWinners,
      participantCount: participants.length,
      channelId,
      messageFound,
    });

    const channel = await fetchGiveawayChannel(client, giveaway.channelId);
    if (!channel) {
      await saveGiveaway(client, guildId, updatedGiveaway);
      logger.warn(`Could not find channel for giveaway ${messageId}, but saved new winners to database`);
      return result(null, false);
    }

    const message = await fetchGiveawayMessage(channel, messageId);
    await saveGiveaway(client, guildId, updatedGiveaway);

    if (message) {
      await message.edit({
        content: '🔄 **GIVEAWAY REROLLED** 🔄',
        embeds: [createGiveawayEmbed(updatedGiveaway, 'reroll', newWinners)],
        components: [createGiveawayButtons(true)],
      });
    }

    const winnerMentions = newWinners.map((id) => `<@${id}>`).join(',');
    const pingContent = message
      ? `🔄 **REROLL WINNERS** 🔄 CONGRATULATIONS ${winnerMentions}! You are the new winner(s) for the **${giveaway.prize}** giveaway! Please contact the host <@${giveaway.hostId}> to claim your prize.`
      : `🔄 **GIVEAWAY REROLL** 🔄 New winners for **${giveaway.prize}**: ${winnerMentions}!`;

    const existingPingMsg = giveaway.winnerPingMessageId
      ? await channel.messages.fetch(giveaway.winnerPingMessageId).catch(() => null)
      : null;
    if (existingPingMsg) {
      await existingPingMsg.edit({ content: pingContent });
    } else {
      const newPingMsg = await channel.send({ content: pingContent });
      updatedGiveaway.winnerPingMessageId = newPingMsg.id;
      await saveGiveaway(client, guildId, updatedGiveaway);
    }

    logger.info(message
      ? `Giveaway successfully rerolled: ${messageId} with ${newWinners.length} new winners`
      : `Giveaway rerolled (message not found, but announced): ${messageId}`);

    try {
      await logEvent({
        client,
        guildId,
        eventType: EVENT_TYPES.GIVEAWAY_REROLL,
        data: {
          description: `Giveaway rerolled: ${giveaway.prize}`,
          channelId: giveaway.channelId,
          userId: rerolledBy,
          fields: [
            { name: 'Prize', value: giveaway.prize || 'Mystery Prize!', inline: true },
            { name: 'New Winners', value: winnerMentions, inline: false },
            { name: 'Total Entries', value: participants.length.toString(), inline: true },
          ],
        },
      });
    } catch (logError) {
      logger.debug('Error logging giveaway reroll event:', logError);
    }

    return result(channel.id, Boolean(message));
  });
}