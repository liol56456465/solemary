// giveawayService.js

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { randomInt } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../utils/errorHandler.js';
import { getColor, botConfig } from '../config/bot.js';
import { getEndedGiveaways, markGiveawayEnded } from '../utils/database.js';
import { deleteGiveaway, getGuildGiveaways, saveGiveaway } from '../utils/giveaways.js';
import { Mutex } from '../utils/mutex.js';
import { checkRateLimit, getRateLimitStatus } from '../utils/rateLimiter.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import { botText, textForGuild } from '../utils/botText.js';

const GIVEAWAY_CONFIG = botConfig.giveaways || {};
const GIVEAWAY_INTERACTION_COOLDOWN = 1000;

function getGiveawayInteractionKey(userId, giveawayId) {
    return `giveaway:${userId}:${giveawayId}`;
}

// User-facing errors take { lang } (the invoker's language; default English, e.g. the dashboard).
// Public posts (the giveaway message, its buttons, the winner announcement) are in the
// server's language (textForGuild, purpose 'public').
const publicLang = (guildId) => textForGuild(guildId, { purpose: 'public' }).lang;

export function parseDuration(durationString, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (!durationString || typeof durationString !== 'string') {
        throw new TitanBotError(
            'Invalid duration format provided',
            ErrorTypes.VALIDATION,
            tr.t('giveaway.errors.durationMissing'),
            { durationString }
        );
    }

    const regex = /^(\d+)([hmds])$/i;
    const match = durationString.trim().match(regex);

    if (!match) {
        throw new TitanBotError(
            `Invalid duration format: ${durationString}`,
            ErrorTypes.VALIDATION,
            tr.t('giveaway.errors.durationFormat'),
            { input: durationString }
        );
    }

    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    if (amount <= 0 || amount > 999) {
        throw new TitanBotError(
            `Duration amount out of range: ${amount}`,
            ErrorTypes.VALIDATION,
            tr.t('giveaway.errors.durationAmount'),
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
                tr.t('giveaway.errors.durationUnit'),
                { unit }
            );
    }

    const maxDuration = GIVEAWAY_CONFIG.maximumDuration ?? 30 * 24 * 60 * 60 * 1000;
    if (ms > maxDuration) {
        throw new TitanBotError(
            `Duration exceeds maximum: ${ms}ms > ${maxDuration}ms`,
            ErrorTypes.VALIDATION,
            tr.tp('giveaway.errors.durationMax', Math.floor(maxDuration / (24 * 60 * 60 * 1000))),
            { requestedMs: ms, maxMs: maxDuration }
        );
    }

    const minDuration = GIVEAWAY_CONFIG.minimumDuration ?? 10 * 1000;
    if (ms < minDuration) {
        throw new TitanBotError(
            `Duration below minimum: ${ms}ms < ${minDuration}ms`,
            ErrorTypes.VALIDATION,
            tr.tp('giveaway.errors.durationMin', Math.ceil(minDuration / 1000)),
            { requestedMs: ms, minMs: minDuration }
        );
    }

    return ms;
}

export function validatePrize(prize, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (!prize || typeof prize !== 'string') {
        throw new TitanBotError(
            'Prize must be a non-empty string',
            ErrorTypes.VALIDATION,
            tr.t('giveaway.errors.prizeMissing'),
            { prize }
        );
    }

    const trimmed = prize.trim();
    if (trimmed.length === 0 || trimmed.length > 256) {
        throw new TitanBotError(
            `Prize length out of range: ${trimmed.length}`,
            ErrorTypes.VALIDATION,
            tr.t('giveaway.errors.prizeLength'),
            { length: trimmed.length }
        );
    }

    return trimmed;
}

export function validateWinnerCount(winnerCount, { lang = 'en' } = {}) {
    const minimumWinners = GIVEAWAY_CONFIG.minimumWinners ?? 1;
    const maximumWinners = GIVEAWAY_CONFIG.maximumWinners ?? 10;

    if (!Number.isInteger(winnerCount) || winnerCount < minimumWinners || winnerCount > maximumWinners) {
        throw new TitanBotError(
            `Invalid winner count: ${winnerCount}`,
            ErrorTypes.VALIDATION,
            botText(lang).t('giveaway.errors.winnerCount', { min: minimumWinners, max: maximumWinners }),
            { winnerCount, minimumWinners, maximumWinners }
        );
    }
}

/** The giveaway message embed. lang: the server's language (default English). */
export function createGiveawayEmbed(giveaway, status, winners = [], { lang = 'en' } = {}) {
    try {
        const tr = botText(lang);
        const isEnded = status === 'ended' || status === 'reroll';
        // Colour keys of config/bot.js (backticks: not catalog keys, so the key-usage test skips them).
        const color = isEnded ? getColor(`giveaway.ended`) : getColor(`giveaway.active`);
        
        const embed = new EmbedBuilder()
            .setTitle(String(giveaway.prize))
            .setDescription(isEnded ? tr.t('giveaway.embed.ended') : tr.t('giveaway.embed.clickJoin'))
            .setColor(color)
            .addFields(
                { name: tr.t('giveaway.embed.host'), value: `<@${giveaway.hostId}>`, inline: true },
                { name: tr.t('giveaway.embed.winners'), value: giveaway.winnerCount.toString(), inline: true },
                { name: tr.t('giveaway.embed.entries'), value: giveaway.participants?.length?.toString() || '0', inline: true }
            );

        if (isEnded) {
            const winnerDisplay = winners.length > 0 
                ? winners.map(id => `<@${id}>`).join(', ')
                : tr.t('giveaway.embed.nobodyEntered');
            embed.addFields({ name: tr.t('giveaway.embed.wonBy'), value: winnerDisplay, inline: false });
        } else {
            const endTime = giveaway.endsAt || giveaway.endTime;
            embed.addFields({ name: tr.t('giveaway.embed.ends'), value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false });
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

/** The giveaway message buttons. lang: the server's language (default English). */
export function createGiveawayButtons(ended = false, { lang = 'en' } = {}) {
    try {
        const tr = botText(lang);
        const row = new ActionRowBuilder();

        if (ended) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('giveaway_reroll')
                    .setLabel(tr.t('giveaway.buttons.reroll'))
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(false),
                new ButtonBuilder()
                    .setCustomId('giveaway_view')
                    .setLabel(tr.t('giveaway.buttons.winners'))
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(false)
            );
        } else {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('giveaway_join')
                    .setLabel(tr.t('giveaway.buttons.join'))
                    .setEmoji('🎉')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(false),
                new ButtonBuilder()
                    .setCustomId('giveaway_end')
                    .setLabel(tr.t('giveaway.buttons.end'))
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
            const j = randomInt(i + 1); // crypto: winners must not be predictable
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

export async function endGiveaway(client, giveaway, guildId, endedBy, { lang = 'en' } = {}) {
    const tr = botText(lang);
    try {
        if (!giveaway) {
            throw new TitanBotError(
                'Giveaway object is null or undefined',
                ErrorTypes.VALIDATION,
                tr.t('giveaway.errors.endMissing'),
                { giveaway }
            );
        }

        if (giveaway.ended === true || giveaway.isEnded === true) {
            throw new TitanBotError(
                `Giveaway ${giveaway.messageId} is already ended`,
                ErrorTypes.VALIDATION,
                tr.t('giveaway.errors.alreadyEnded'),
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
            tr.t('giveaway.errors.endFailed'),
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
          const lang = publicLang(guildId);
          const tr = botText(lang);

          const winnerMentions = winners.length > 0
            ? winners.map(id => `<@${id}>`).join(', ')
            : 'nobody';

          giveaway.ended = true;
          giveaway.isEnded = true;
          giveaway.winnerIds = winners;
          giveaway.endedAt = new Date().toISOString();
          // The key-value fallback of markGiveawayEnded needs guildId on the record;
          // without it the giveaway is never marked ended and gets re-ended every tick.
          giveaway.guildId = giveaway.guildId || guildId;
          giveaway.messageId = giveaway.messageId || messageId;

          // Save the ended state (with winners) before announcing anything. If the save
          // failed, the next tick would re-pick and ping different winners, so stop here,
          // announce nothing and let the next tick retry. A thrown DB error does the same.
          const markedSuccess = await markGiveawayEnded(client, giveawayId, giveaway);
          if (!markedSuccess) {
            logger.error(`Could not mark giveaway ${messageId} as ended; winners not announced, will retry`);
            return;
          }

          const endedEmbed = createGiveawayEmbed(giveaway, 'ended', winners, { lang });

          await message.edit({
            embeds: [endedEmbed],
            components: [createGiveawayButtons(true, { lang })]
          }).catch((error) => logger.warn(`Could not edit ended giveaway message ${messageId}: ${error.message}`));

          if (winners.length > 0) {
            const winnerAnnouncement = tr.t('giveaway.post.won', { winners: winnerMentions, prize: giveaway.prize || tr.t('giveaway.post.theGiveaway'), hostId: giveaway.hostId });
            const winnerPingMsg = await channel.send({ content: winnerAnnouncement, allowedMentions: { users: [...new Set([...winners, giveaway.hostId].filter(Boolean))] } });
            giveaway.winnerPingMessageId = winnerPingMsg.id;
            // Only the ping id is new here; the ended state is already saved, so a failed
            // save is logged without stopping the log event below.
            const pingSaved = await markGiveawayEnded(client, giveawayId, giveaway)
              .catch((error) => { logger.warn(`Could not save winner ping id for giveaway ${messageId}: ${error.message}`); return null; });
            if (pingSaved === false) logger.warn(`Could not save winner ping id for giveaway ${messageId}`);

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
                      name: 'Prize',
                      value: giveaway.prize || 'Unknown',
                      inline: true
                    },
                    {
                      name: 'Winners',
                      value: winners.map(id => `<@${id}>`).join(', '),
                      inline: false
                    },
                    {
                      name: 'Entries',
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
            await channel.send({ content: tr.t('giveaway.post.noWinner', { prize: giveaway.prize }), allowedMentions: { parse: [] } });
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

function validateGiveawayMessageId(messageId, lang = 'en') {
  if (!messageId || !/^\d+$/.test(messageId)) {
    throw new TitanBotError(
      'Invalid message ID format',
      ErrorTypes.VALIDATION,
      botText(lang).t('giveaway.errors.badMessageId'),
      { providedId: messageId }
    );
  }
}

async function findGiveaway(client, guildId, messageId, lang = 'en') {
  const giveaways = await getGuildGiveaways(client, guildId);
  const giveaway = giveaways.find(g => g.messageId === messageId);
  if (!giveaway) {
    throw new TitanBotError(
      `Giveaway not found: ${messageId}`,
      ErrorTypes.VALIDATION,
      botText(lang).t('giveaway.errors.notFound'),
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
export async function endGiveawayNow(client, guildId, messageId, endedBy, { lang = 'en' } = {}) {
  validateGiveawayMessageId(messageId, lang);
  const tr = botText(lang);

  return Mutex.runExclusive(`giveaway:${messageId}`, async () => {
    const giveaway = await findGiveaway(client, guildId, messageId, lang);
    const endResult = await endGiveaway(client, giveaway, guildId, endedBy, { lang });
    const updatedGiveaway = endResult.giveaway;
    const winners = endResult.winners;

    const channel = await fetchGiveawayChannel(client, updatedGiveaway.channelId);
    if (!channel) {
      await saveGiveaway(client, guildId, updatedGiveaway);
      throw new TitanBotError(
        `Channel not found: ${updatedGiveaway.channelId}`,
        ErrorTypes.VALIDATION,
        tr.t('giveaway.errors.channelGone'),
        { channelId: updatedGiveaway.channelId, messageId }
      );
    }

    const message = await fetchGiveawayMessage(channel, messageId);
    if (!message) {
      await saveGiveaway(client, guildId, updatedGiveaway);
      throw new TitanBotError(
        `Message not found: ${messageId}`,
        ErrorTypes.VALIDATION,
        tr.t('giveaway.errors.messageGone'),
        { messageId, channelId: updatedGiveaway.channelId }
      );
    }

    await saveGiveaway(client, guildId, updatedGiveaway);
    const postLang = publicLang(guildId);
    const post = botText(postLang);

    await message.edit({
      content: post.t('giveaway.post.ended'),
      embeds: [createGiveawayEmbed(updatedGiveaway, 'ended', winners, { lang: postLang })],
      components: [createGiveawayButtons(true, { lang: postLang })],
    });

    if (winners.length > 0) {
      const winnerMentions = winners.map((id) => `<@${id}>`).join(',');
      const winnerPingMsg = await channel.send({
        content: post.t('giveaway.post.won', { winners: winnerMentions, prize: updatedGiveaway.prize, hostId: updatedGiveaway.hostId }),
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
              { name: 'Prize', value: updatedGiveaway.prize || 'Unknown', inline: true },
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
        content: post.t('giveaway.post.noWinner', { prize: updatedGiveaway.prize }),
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
export async function rerollGiveaway(client, guildId, messageId, rerolledBy, { lang = 'en' } = {}) {
  validateGiveawayMessageId(messageId, lang);
  const tr = botText(lang);

  return Mutex.runExclusive(`giveaway:${messageId}`, async () => {
    const giveaway = await findGiveaway(client, guildId, messageId, lang);

    if (!giveaway.isEnded && !giveaway.ended) {
      throw new TitanBotError(
        `Giveaway still active: ${messageId}`,
        ErrorTypes.VALIDATION,
        tr.t('giveaway.errors.stillActive'),
        { messageId, status: 'active' }
      );
    }

    const participants = giveaway.participants || [];
    if (participants.length < giveaway.winnerCount) {
      throw new TitanBotError(
        `Insufficient participants for reroll: ${participants.length} < ${giveaway.winnerCount}`,
        ErrorTypes.VALIDATION,
        tr.t('giveaway.errors.notEnoughEntries'),
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
    const postLang = publicLang(guildId);
    const post = botText(postLang);

    if (message) {
      await message.edit({
        content: post.t('giveaway.post.rerolled'),
        embeds: [createGiveawayEmbed(updatedGiveaway, 'reroll', newWinners, { lang: postLang })],
        components: [createGiveawayButtons(true, { lang: postLang })],
      });
    }

    const winnerMentions = newWinners.map((id) => `<@${id}>`).join(',');
    const pingContent = message
      ? post.t('giveaway.post.rerolledWon', { winners: winnerMentions, prize: giveaway.prize, hostId: giveaway.hostId })
      : post.t('giveaway.post.rerolledShort', { prize: giveaway.prize, winners: winnerMentions });

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
            { name: 'Prize', value: giveaway.prize || 'Unknown', inline: true },
            { name: 'New winners', value: winnerMentions, inline: false },
            { name: 'Entries', value: participants.length.toString(), inline: true },
          ],
        },
      });
    } catch (logError) {
      logger.debug('Error logging giveaway reroll event:', logError);
    }

    return result(channel.id, Boolean(message));
  });
}

// ── Create / delete ───────────────────────────────────────────────────────────
// Shared by /giveaway create, /giveaway delete and the web dashboard.

const GIVEAWAY_CHANNEL_PERMISSIONS = ['ViewChannel', 'SendMessages', 'EmbedLinks'];

/**
 * Starts a giveaway: validates the duration ("1h", "30m", …), prize and winner count,
 * checks the bot can post in the channel, posts the giveaway message, saves it and
 * logs GIVEAWAY_CREATE. Resolves { giveaway, message, durationMs, saved }.
 * Throws TitanBotError (userMessage) for bad input or a channel the bot can't use.
 */
export async function createGiveaway(client, guild, { channel, duration, winnerCount, prize, hostId, lang = 'en' }) {
  const tr = botText(lang);
  const durationMs = parseDuration(duration, { lang });
  validateWinnerCount(winnerCount, { lang });
  const prizeName = validatePrize(prize, { lang });

  if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
    throw new TitanBotError(
      'Target channel is not text-based',
      ErrorTypes.VALIDATION,
      tr.t('giveaway.errors.notTextChannel'),
      { channelId: channel?.id, channelType: channel?.type }
    );
  }
  const me = guild?.members?.me;
  const granted = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
  if (granted && !granted.has(GIVEAWAY_CHANNEL_PERMISSIONS)) {
    throw new TitanBotError(
      `Missing permissions in ${channel.id}`,
      ErrorTypes.PERMISSION,
      tr.t('giveaway.errors.missingPermissions', { channelId: channel.id }),
      { channelId: channel.id, expected: true }
    );
  }

  const endTime = Date.now() + durationMs;
  const giveaway = {
    messageId: 'placeholder',
    channelId: channel.id,
    guildId: guild.id,
    prize: prizeName,
    hostId,
    endTime,
    endsAt: endTime,
    winnerCount,
    participants: [],
    isEnded: false,
    ended: false,
    createdAt: new Date().toISOString(),
  };

  const postLang = publicLang(guild.id);
  const message = await channel.send({
    content: botText(postLang).t('giveaway.post.newGiveaway'),
    embeds: [createGiveawayEmbed(giveaway, 'active', [], { lang: postLang })],
    components: [createGiveawayButtons(false, { lang: postLang })],
  });

  giveaway.messageId = message.id;
  const saved = await saveGiveaway(client, guild.id, giveaway);
  if (!saved) logger.warn(`Failed to save giveaway to database: ${message.id}`);

  try {
    await logEvent({
      client,
      guildId: guild.id,
      eventType: EVENT_TYPES.GIVEAWAY_CREATE,
      data: {
        description: `Giveaway created: ${prizeName}`,
        channelId: channel.id,
        userId: hostId,
        fields: [
          { name: 'Prize', value: prizeName, inline: true },
          { name: 'Winners', value: String(winnerCount), inline: true },
          { name: 'Duration', value: String(duration), inline: true },
          { name: 'Channel', value: `<#${channel.id}>`, inline: true },
        ],
      },
    });
  } catch (logError) {
    logger.debug('Error logging giveaway creation event:', logError);
  }

  logger.info(`Giveaway created: ${message.id} in ${channel.name}`);
  return { giveaway, message, durationMs, saved: Boolean(saved) };
}

/**
 * Deletes a giveaway: its message (in its channel, else searched in the guild's text
 * channels), its database entry, and logs GIVEAWAY_DELETE. Resolves
 * { giveaway, deletedMessage, channelName }. Throws TitanBotError (userMessage) for a
 * bad id, an unknown giveaway or a failed database delete.
 */
export async function deleteGiveawayNow(client, guild, messageId, deletedBy, { lang = 'en' } = {}) {
  validateGiveawayMessageId(messageId, lang);
  const guildId = guild.id;

  return Mutex.runExclusive(`giveaway:${messageId}`, async () => {
    const giveaway = await findGiveaway(client, guildId, messageId, lang);
    let deletedMessage = false;
    let channelName = 'Unknown Channel';

    const tryDeleteFromChannel = async (channel) => {
      if (!channel || !channel.isTextBased?.() || !channel.messages?.fetch) return false;
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) return false;
      await message.delete();
      channelName = channel.name || 'unknown-channel';
      deletedMessage = true;
      return true;
    };

    try {
      const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
      if (!(await tryDeleteFromChannel(channel)) && guild.channels?.cache) {
        const others = guild.channels.cache.filter((ch) => ch.id !== giveaway.channelId && ch.isTextBased?.() && ch.messages?.fetch);
        for (const [, other] of others) {
          if (await tryDeleteFromChannel(other).catch(() => false)) break;
        }
      }
    } catch (error) {
      logger.warn(`Could not delete giveaway message: ${error.message}`);
    }

    const removed = await deleteGiveaway(client, guildId, messageId);
    const stillThere = (await getGuildGiveaways(client, guildId)).some((g) => g.messageId === messageId);
    if (!removed || stillThere) {
      throw new TitanBotError(
        `Failed to delete giveaway from database: ${messageId}`,
        ErrorTypes.UNKNOWN,
        botText(lang).t('giveaway.errors.deleteFailed'),
        { messageId, guildId }
      );
    }

    try {
      await logEvent({
        client,
        guildId,
        eventType: EVENT_TYPES.GIVEAWAY_DELETE,
        data: {
          description: `Giveaway deleted: ${giveaway.prize}`,
          channelId: giveaway.channelId,
          userId: deletedBy,
          fields: [
            { name: 'Prize', value: giveaway.prize || 'Unknown', inline: true },
            { name: 'Entries', value: String(giveaway.participants?.length || 0), inline: true },
          ],
        },
      });
    } catch (logError) {
      logger.debug('Error logging giveaway deletion:', logError);
    }

    logger.info(`Giveaway deleted: ${messageId} in ${channelName}`);
    return { giveaway, deletedMessage, channelName };
  });
}