import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { infoEmbed, successEmbed } from '../utils/embeds.js';
import { verificationSetupProblem, verifyUser } from '../services/verificationService.js';
import { buildVerifyUrl, isOAuthVerificationEnabled } from '../services/oauthVerification.js';
import { quizGate } from '../services/verificationQuiz.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { directVerifyPrivacyNote, oauthVerifyPrivacyNote } from '../utils/privacyNotice.js';

/** The private reply with the "Verify with Discord" link (OAuth verification). */
export function buildOAuthVerifyReply(guildId, userId) {
    return {
        embeds: [infoEmbed(
            'Verify with Discord',
            'Press the button below and authorize the bot with your Discord account. You get the role as soon as you have authorized.\n\n-# The link only works for you and expires in 10 minutes.'
            + `\n-# ${oauthVerifyPrivacyNote()}`
        )],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Verify with Discord').setURL(buildVerifyUrl(guildId, userId)),
        )],
    };
}

/**
 * The normal verification step, after the interaction was acknowledged (deferred reply, or
 * deferUpdate on a rules-quiz button): the "Verify with Discord" link, or the verified role.
 * Every answer sets the message's components, so quiz buttons never stay behind.
 */
export async function continueVerification(interaction, client, { source = 'button_click' } = {}) {
    const guild = interaction.guild;
    const userId = interaction.user.id;

    if (isOAuthVerificationEnabled()) {
        // This server's own setup decides, before the member authorizes anything.
        const problem = await verificationSetupProblem(client, guild.id);
        if (problem) return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: problem });
        return await InteractionHelper.safeEditReply(interaction, buildOAuthVerifyReply(guild.id, userId));
    }

    const result = await verifyUser(client, guild.id, userId, {
        source,
        moderatorId: null
    });

    if (result.status === 'already_verified') {
        if (source === 'button_click') {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'You are already verified and have access to all server channels.' });
        }
        return await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed('Already verified', 'You are already verified and have access to all server channels.')],
            components: [],
        });
    }

    logger.info('User verified via button', {
        guildId: guild.id,
        userId,
        roleName: result.roleName,
        source,
    });

    return await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
            "Verified",
            `You're verified and got the **${result.roleName}** role. Welcome in.\n\n-# ${directVerifyPrivacyNote()}`
        )],
        components: [],
    });
}

export async function handleVerificationButton(interaction, client) {
    try {
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        if (!interaction.guild) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This button can only be used in a server.' });
        }

        logger.debug('User clicked verify button', {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            userTag: interaction.user.tag
        });

        // The rules quiz comes first when it is on (services/verificationQuiz.js).
        const quiz = await quizGate(client, interaction);
        if (quiz) return await InteractionHelper.safeEditReply(interaction, quiz);

        await continueVerification(interaction, client, { source: 'button_click' });

    } catch (error) {
        logger.error('Error in verification button handler', {
            error: error.message,
            guildId: interaction.guild?.id,
            userId: interaction.user.id
        });

        await handleInteractionError(
            interaction,
            error,
            { command: 'verify_button', action: 'verification' }
        );
    }
}

export default {
  customId: "verify_user",
  execute: handleVerificationButton
};
