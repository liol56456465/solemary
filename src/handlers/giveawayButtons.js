import { MessageFlags } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { TitanBotError, ErrorTypes, handleInteractionError, replyUserError } from '../utils/errorHandler.js';
import { 
    getGuildGiveaways, 
    saveGiveaway, 
    isGiveawayEnded 
} from '../utils/giveaways.js';
import { Mutex } from '../utils/mutex.js';
import { hasOwnerPower } from '../utils/ownerPower.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { noteOwnerOverride } from '../services/ownerOverride.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { 
    isUserRateLimited,
    recordUserInteraction,
    createGiveawayEmbed,
    createGiveawayButtons,
    endGiveawayNow,
    rerollGiveaway,
} from '../services/giveawayService.js';

export const giveawayJoinHandler = {
    customId: 'giveaway_join',
    async execute(interaction, client) {
        try {
            
            if (isUserRateLimited(interaction.user.id, interaction.message.id)) {
                return replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: 'Slow down a bit, then try again.' });
            }

            await recordUserInteraction(interaction.user.id, interaction.message.id);

            // Joins are serialized per giveaway; during a rush the queue can outlast
            // Discord's 3-second window, so acknowledge before waiting on the lock.
            if (!(await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral }))) {
                return;
            }

            const lockKey = `giveaway:${interaction.message.id}`;
            await Mutex.runExclusive(lockKey, async () => {
                const guildGiveaways = await getGuildGiveaways(client, interaction.guildId);
                const giveaway = guildGiveaways.find(g => g.messageId === interaction.message.id);

                if (!giveaway) {
                    throw new TitanBotError(
                        'Giveaway not found in database',
                        ErrorTypes.VALIDATION,
                        'This giveaway is no longer active.',
                        { messageId: interaction.message.id, guildId: interaction.guildId }
                    );
                }

                const endedByTime = isGiveawayEnded(giveaway);
                const endedByFlag = giveaway.ended || giveaway.isEnded;

                if (endedByTime || endedByFlag) {
                    return replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This giveaway has already ended.' });
                }

                const participants = giveaway.participants || [];
                const userId = interaction.user.id;

                if (participants.includes(userId)) {
                    return replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: "You're already in this giveaway." });
                }

                participants.push(userId);
                giveaway.participants = participants;

                await saveGiveaway(client, interaction.guildId, giveaway);

                logger.debug(`User ${interaction.user.tag} joined giveaway ${interaction.message.id}`);

                const updatedEmbed = createGiveawayEmbed(giveaway, 'active');
                const updatedRow = createGiveawayButtons(false);

                await interaction.message.edit({
                    embeds: [updatedEmbed],
                    components: [updatedRow]
                });

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(
                            "You're in",
                            `Good luck. ${participants.length === 1 ? '1 person has' : `${participants.length} people have`} entered so far.`
                        )
                    ],
                });
            });
        } catch (error) {
            logger.error('Error in giveaway join handler:', error);
            await handleInteractionError(interaction, error, {
                type: 'button',
                customId: 'giveaway_join',
                handler: 'giveaway'
            });
        }
    }
};

export const giveawayEndHandler = {
    customId: 'giveaway_end',
    async execute(interaction, client) {
        try {
            
            if (!interaction.inGuild()) {
                throw new TitanBotError(
                    'Button used outside guild',
                    ErrorTypes.VALIDATION,
                    'This button can only be used in a server.',
                    { userId: interaction.user.id }
                );
            }

            // Ending or rerolling decides who wins: Administrator only (access model), like the commands.
            if (!hasOwnerPower(interaction.user.id, interaction.guildId) && !isAdministrator(interaction.member)) {
                return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the Administrator role to end a giveaway.' });
            }
            if (!isAdministrator(interaction.member)) {
                noteOwnerOverride({ client, guildId: interaction.guildId, userId: interaction.user.id, username: interaction.user.username, action: 'giveaway end', via: 'button' });
            }

            // Saving, editing the giveaway message and logging can exceed Discord's 3s window.
            if (!(await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral }))) {
                return;
            }

            // Same path as /giveaway end: under the giveaway's lock, with the winner announcement.
            const { winners } = await endGiveawayNow(client, interaction.guildId, interaction.message.id, interaction.user.id);
            logger.info(`Giveaway ended via button by ${interaction.user.tag}: ${interaction.message.id}`);

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    successEmbed(
                        'Giveaway ended',
                        winners.length > 0 ? `Picked ${winners.length} winner${winners.length === 1 ? '' : 's'}.` : 'Nobody entered, so there is no winner.'
                    )
                ],
            });

        } catch (error) {
            logger.error('Error in giveaway end handler:', error);
            await handleInteractionError(interaction, error, {
                type: 'button',
                customId: 'giveaway_end',
                handler: 'giveaway'
            });
        }
    }
};

export const giveawayRerollHandler = {
    customId: 'giveaway_reroll',
    async execute(interaction, client) {
        try {
            
            if (!interaction.inGuild()) {
                throw new TitanBotError(
                    'Button used outside guild',
                    ErrorTypes.VALIDATION,
                    'This button can only be used in a server.',
                    { userId: interaction.user.id }
                );
            }

            if (!hasOwnerPower(interaction.user.id, interaction.guildId) && !isAdministrator(interaction.member)) {
                return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the Administrator role to reroll a giveaway.' });
            }
            if (!isAdministrator(interaction.member)) {
                noteOwnerOverride({ client, guildId: interaction.guildId, userId: interaction.user.id, username: interaction.user.username, action: 'giveaway reroll', via: 'button' });
            }

            // Saving, editing the giveaway message and logging can exceed Discord's 3s window.
            if (!(await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral }))) {
                return;
            }

            // Same path as /giveaway reroll: under the giveaway's lock, with the winner announcement.
            await rerollGiveaway(client, interaction.guildId, interaction.message.id, interaction.user.id);
            logger.info(`Giveaway rerolled via button by ${interaction.user.tag}: ${interaction.message.id}`);

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed('Giveaway rerolled', 'New winners picked.')],
            });

        } catch (error) {
            logger.error('Error in giveaway reroll handler:', error);
            await handleInteractionError(interaction, error, {
                type: 'button',
                customId: 'giveaway_reroll',
                handler: 'giveaway'
            });
        }
    }
};

export const giveawayViewHandler = {
    customId: 'giveaway_view',
    async execute(interaction, client) {
        try {
            if (!interaction.inGuild()) {
                throw new TitanBotError(
                    'Button used outside guild',
                    ErrorTypes.VALIDATION,
                    'This button can only be used in a server.',
                    { userId: interaction.user.id }
                );
            }

            const guildGiveaways = await getGuildGiveaways(client, interaction.guildId);
            const giveaway = guildGiveaways.find(g => g.messageId === interaction.message.id);

            if (!giveaway) {
                throw new TitanBotError(
                    'Giveaway not found in database',
                    ErrorTypes.VALIDATION,
                    'This giveaway could not be found.',
                    { messageId: interaction.message.id, guildId: interaction.guildId }
                );
            }

            if (!giveaway.ended && !giveaway.isEnded && !isGiveawayEnded(giveaway)) {
                return replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This giveaway has not ended yet, so winners are not available.' });
            }

            const winnerIds = Array.isArray(giveaway.winnerIds) ? giveaway.winnerIds : [];
            const winnerMentions = winnerIds.length > 0
                ? winnerIds.map(id => `<@${id}>`).join(', ')
                : 'Nobody won this one.';

            await interaction.reply({
                embeds: [
                    successEmbed(
                        `Winners: ${giveaway.prize || 'giveaway'}`,
                        winnerMentions
                    )
                ],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error('Error in giveaway view handler:', error);
            await handleInteractionError(interaction, error, {
                type: 'button',
                customId: 'giveaway_view',
                handler: 'giveaway'
            });
        }
    }
};