import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { infoEmbed, successEmbed } from '../utils/embeds.js';
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
import { textForGuild, textForInteraction } from '../utils/botText.js';
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
        // Replies to the member: their Discord language. The giveaway message: the server's.
        const tr = textForInteraction(interaction);
        try {
            
            if (isUserRateLimited(interaction.user.id, interaction.message.id)) {
                return replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: tr.t('giveaway.button.slowDown') });
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
                        tr.t('giveaway.button.notActive'),
                        { messageId: interaction.message.id, guildId: interaction.guildId }
                    );
                }

                const endedByTime = isGiveawayEnded(giveaway);
                const endedByFlag = giveaway.ended || giveaway.isEnded;

                if (endedByTime || endedByFlag) {
                    return replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('giveaway.button.alreadyEnded') });
                }

                const participants = giveaway.participants || [];
                const userId = interaction.user.id;

                // Already in: information, not an error (audit 4.7), with a way out.
                if (participants.includes(userId)) {
                    await InteractionHelper.safeEditReply(interaction, {
                        embeds: [infoEmbed(tr.t('giveaway.button.alreadyInTitle'), tr.t('giveaway.button.alreadyIn'))],
                        components: [giveawayLeaveRow(interaction.message.id, tr)],
                    });
                    return;
                }

                participants.push(userId);
                giveaway.participants = participants;

                await saveGiveaway(client, interaction.guildId, giveaway);

                logger.debug(`User ${interaction.user.tag} joined giveaway ${interaction.message.id}`);

                const postLang = textForGuild(interaction.guildId, { purpose: 'public' }).lang;
                const updatedEmbed = createGiveawayEmbed(giveaway, 'active', [], { lang: postLang });
                const updatedRow = createGiveawayButtons(false, { lang: postLang });

                await interaction.message.edit({
                    embeds: [updatedEmbed],
                    components: [updatedRow]
                });

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(
                            tr.t('giveaway.button.joinedTitle'),
                            tr.tp('giveaway.button.joined', participants.length)
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

/** The "Leave giveaway" button under the "already in" reply: giveaway_leave:<giveaway message id>. */
export function giveawayLeaveRow(messageId, tr) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`giveaway_leave:${messageId}`).setLabel(tr.t('giveaway.buttons.leave')).setStyle(ButtonStyle.Secondary),
    );
}

const MESSAGE_ID = /^\d{17,20}$/;

/**
 * Leaves a giveaway (audit 4.7). The button sits on the clicker's own ephemeral "already in"
 * reply; the giveaway is named by the customId and looked up in this server only, and only the
 * clicker is removed, so there is nothing else to re-check. Acknowledged at once (the lock can
 * queue during a rush), then the same per-giveaway lock as Join.
 */
export const giveawayLeaveHandler = {
    customId: 'giveaway_leave',
    async execute(interaction, client) {
        const tr = textForInteraction(interaction);
        try {
            const messageId = String(interaction.customId || '').split(':')[1] || '';
            if (!interaction.inGuild() || !MESSAGE_ID.test(messageId)) {
                return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('giveaway.button.notActive') });
            }
            if (isUserRateLimited(interaction.user.id, messageId)) {
                return replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: tr.t('giveaway.button.slowDown') });
            }
            await recordUserInteraction(interaction.user.id, messageId);
            if (!(await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral }))) return;

            await Mutex.runExclusive(`giveaway:${messageId}`, async () => {
                const giveaway = (await getGuildGiveaways(client, interaction.guildId)).find((g) => g.messageId === messageId);
                if (!giveaway) {
                    throw new TitanBotError('Giveaway not found in database', ErrorTypes.VALIDATION, tr.t('giveaway.button.notActive'),
                        { messageId, guildId: interaction.guildId });
                }
                if (isGiveawayEnded(giveaway) || giveaway.ended || giveaway.isEnded) {
                    return replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('giveaway.button.alreadyEnded') });
                }
                const participants = giveaway.participants || [];
                if (!participants.includes(interaction.user.id)) {
                    await InteractionHelper.safeEditReply(interaction, { embeds: [infoEmbed(tr.t('giveaway.button.leftTitle'), tr.t('giveaway.button.notIn'))], components: [] });
                    return;
                }
                giveaway.participants = participants.filter((id) => id !== interaction.user.id);
                await saveGiveaway(client, interaction.guildId, giveaway);
                logger.debug(`User ${interaction.user.tag} left giveaway ${messageId}`);

                // The entry count on the giveaway message; a failed edit is fixed by the next join.
                try {
                    const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
                    const message = channel?.messages ? await channel.messages.fetch(messageId).catch(() => null) : null;
                    if (message) {
                        const postLang = textForGuild(interaction.guildId, { purpose: 'public' }).lang;
                        await message.edit({
                            embeds: [createGiveawayEmbed(giveaway, 'active', [], { lang: postLang })],
                            components: [createGiveawayButtons(false, { lang: postLang })],
                        });
                    }
                } catch (error) {
                    logger.warn(`Could not update giveaway message ${messageId} after a leave: ${error.message}`);
                }

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed(tr.t('giveaway.button.leftTitle'), tr.t('giveaway.button.left'))],
                    components: [],
                });
            });
        } catch (error) {
            logger.error('Error in giveaway leave handler:', error);
            await handleInteractionError(interaction, error, { type: 'button', customId: 'giveaway_leave', handler: 'giveaway' });
        }
    }
};

export const giveawayEndHandler = {
    customId: 'giveaway_end',
    async execute(interaction, client) {
        const tr = textForInteraction(interaction);
        try {
            
            if (!interaction.inGuild()) {
                throw new TitanBotError(
                    'Button used outside guild',
                    ErrorTypes.VALIDATION,
                    tr.t('giveaway.button.guildOnly'),
                    { userId: interaction.user.id }
                );
            }

            // Ending or rerolling decides who wins: Administrator only (access model), like the commands.
            if (!hasOwnerPower(interaction.user.id, interaction.guildId) && !isAdministrator(interaction.member)) {
                return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('giveaway.button.needAdminEnd') });
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
                        tr.t('giveaway.button.endedTitle'),
                        winners.length > 0 ? tr.tp('giveaway.button.picked', winners.length) : tr.t('giveaway.button.nobodyEntered')
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
        const tr = textForInteraction(interaction);
        try {
            
            if (!interaction.inGuild()) {
                throw new TitanBotError(
                    'Button used outside guild',
                    ErrorTypes.VALIDATION,
                    tr.t('giveaway.button.guildOnly'),
                    { userId: interaction.user.id }
                );
            }

            if (!hasOwnerPower(interaction.user.id, interaction.guildId) && !isAdministrator(interaction.member)) {
                return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('giveaway.button.needAdminReroll') });
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
                embeds: [successEmbed(tr.t('giveaway.button.rerolledTitle'), tr.t('giveaway.button.rerolledText'))],
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
        const tr = textForInteraction(interaction);
        try {
            if (!interaction.inGuild()) {
                throw new TitanBotError(
                    'Button used outside guild',
                    ErrorTypes.VALIDATION,
                    tr.t('giveaway.button.guildOnly'),
                    { userId: interaction.user.id }
                );
            }

            // Every answer here is ephemeral: acknowledge before the database read.
            await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
            const guildGiveaways = await getGuildGiveaways(client, interaction.guildId);
            const giveaway = guildGiveaways.find(g => g.messageId === interaction.message.id);

            if (!giveaway) {
                throw new TitanBotError(
                    'Giveaway not found in database',
                    ErrorTypes.VALIDATION,
                    tr.t('giveaway.button.notFound'),
                    { messageId: interaction.message.id, guildId: interaction.guildId }
                );
            }

            if (!giveaway.ended && !giveaway.isEnded && !isGiveawayEnded(giveaway)) {
                return replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('giveaway.button.notEndedYet') });
            }

            const winnerIds = Array.isArray(giveaway.winnerIds) ? giveaway.winnerIds : [];
            const winnerMentions = winnerIds.length > 0
                ? winnerIds.map(id => `<@${id}>`).join(', ')
                : tr.t('giveaway.button.nobodyWon');

            await interaction.reply({
                embeds: [
                    successEmbed(
                        tr.t('giveaway.button.winnersTitle', { prize: giveaway.prize || tr.t('giveaway.button.giveawayWord') }),
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