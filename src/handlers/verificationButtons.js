import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { infoEmbed, successEmbed } from '../utils/embeds.js';
import { verificationSetupProblem, verifyUser } from '../services/verificationService.js';
import { buildVerifyUrl, isOAuthVerificationEnabled, keepsVerifyToken } from '../services/oauthVerification.js';
import { quizGate } from '../services/verificationQuiz.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { privacyUrl } from '../utils/privacyNotice.js';
import { botText, textForInteraction } from '../utils/botText.js';

/**
 * The privacy line under a verification answer, in the member's language. English is exactly
 * utils/privacyNotice.js (oauthVerifyPrivacyNote / directVerifyPrivacyNote).
 */
export function verifyPrivacyNote(kind, { lang, env = process.env, home = true } = {}) {
    const tr = botText(lang);
    // 'oauth' in a server that is not Mewvo's (home: false): identify only, no token kept (D3).
    const key = kind !== 'oauth' ? 'verification.privacy.direct' : home ? 'verification.privacy.oauth' : 'verification.privacy.oauthServer';
    const sentence = tr.t(key);
    const url = privacyUrl(env);
    return url ? `${sentence} ${tr.t('verification.privacy.link', { url })}` : sentence;
}

/**
 * The private reply with the "Verify with Discord" link (OAuth verification), in `lang`. The
 * privacy line and the scopes follow the server (keepsVerifyToken); `lang` also goes into the
 * link's state, so the result page after Discord is in the same language.
 */
export function buildOAuthVerifyReply(guildId, userId, { lang } = {}) {
    const tr = botText(lang);
    const home = keepsVerifyToken(guildId);
    return {
        embeds: [infoEmbed(
            tr.t('verification.button.oauthTitle'),
            tr.t('verification.button.oauthText', { privacy: verifyPrivacyNote('oauth', { lang, home }) }),
        )],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(tr.t('verification.button.oauthButton')).setURL(buildVerifyUrl(guildId, userId, { lang: tr.lang })),
        )],
    };
}

/**
 * The normal verification step, after the interaction was acknowledged (deferred reply, or
 * deferUpdate on a rules-quiz button): the "Verify with Discord" link, or the verified role.
 * Every answer sets the message's components, so quiz buttons never stay behind.
 * Every answer is ephemeral: the member's Discord language.
 */
export async function continueVerification(interaction, client, { source = 'button_click' } = {}) {
    const guild = interaction.guild;
    const userId = interaction.user.id;
    const tr = textForInteraction(interaction);
    const { lang } = tr;

    if (isOAuthVerificationEnabled()) {
        // This server's own setup decides, before the member authorizes anything.
        const problem = await verificationSetupProblem(client, guild.id, { lang });
        if (problem) return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: problem });
        return await InteractionHelper.safeEditReply(interaction, buildOAuthVerifyReply(guild.id, userId, { lang }));
    }

    const result = await verifyUser(client, guild.id, userId, {
        source,
        moderatorId: null,
        lang,
    });

    if (result.status === 'already_verified') {
        if (source === 'button_click') {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('verification.button.alreadyText') });
        }
        return await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed(tr.t('verification.button.alreadyTitle'), tr.t('verification.button.alreadyText'))],
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
            tr.t('verification.verify.verifiedTitle'),
            tr.t('verification.button.verifiedText', { role: result.roleName, privacy: verifyPrivacyNote('direct', { lang }) })
        )],
        components: [],
    });
}

export async function handleVerificationButton(interaction, client) {
    try {
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        if (!interaction.guild) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: textForInteraction(interaction).t('verification.button.serverOnly') });
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
