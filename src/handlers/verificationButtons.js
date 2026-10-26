import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { infoEmbed, successEmbed } from '../utils/embeds.js';
import { verifyUser } from '../services/verificationService.js';
import { buildVerifyUrl, isOAuthVerificationEnabled } from '../services/oauthVerification.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';

/** The private reply with the "Verify with Discord" link (OAuth verification). */
export function buildOAuthVerifyReply(guildId, userId) {
    return {
        embeds: [infoEmbed(
            'Verify with Discord',
            'Press the button below and authorize the bot with your Discord account. You get the role as soon as you have authorized.\n\n-# The link only works for you and expires in 10 minutes.'
        )],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Verify with Discord').setURL(buildVerifyUrl(guildId, userId)),
        )],
    };
}

export async function handleVerificationButton(interaction, client) {
    try {
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        if (!interaction.guild) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This button can only be used in a server.' });
        }

        const guild = interaction.guild;
        const userId = interaction.user.id;

        logger.debug('User clicked verify button', {
            guildId: guild.id,
            userId,
            userTag: interaction.user.tag
        });

        if (isOAuthVerificationEnabled()) {
            return await InteractionHelper.safeEditReply(interaction, buildOAuthVerifyReply(guild.id, userId));
        }

        const result = await verifyUser(client, guild.id, userId, {
            source: 'button_click',
            moderatorId: null
        });

        if (result.status === 'already_verified') {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'You are already verified and have access to all server channels.' });
        }

        logger.info('User verified via button', {
            guildId: guild.id,
            userId,
            roleName: result.roleName
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                "✅ Verification Successful!",
                `You have been verified and given the **${result.roleName}** role!\n\nYou now have access to all server channels and features. Welcome! 🎉`
            )],
        });

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