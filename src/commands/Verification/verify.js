import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { infoEmbed, successEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { verificationSetupProblem, verifyUser } from '../../services/verificationService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { isOAuthVerificationEnabled } from '../../services/oauthVerification.js';
import { buildOAuthVerifyReply, verifyPrivacyNote } from '../../handlers/verificationButtons.js';
import { quizGate } from '../../services/verificationQuiz.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';

export default {
    data: new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Verify yourself and gain access to the server')
        .setDescriptionLocalizations(localizations('verification.cmd.verify.description')),

    async execute(interaction, config, client) {
        const guild = interaction.guild;
        // Every answer is private: the member's Discord language.
        const tr = textForInteraction(interaction);
        const { lang } = tr;
        // Ephemeral from here on (the replies below become edits of this deferred reply).
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        // The rules quiz comes first when it is on, as on the Verify button.
        const quiz = await quizGate(client, interaction);
        if (quiz) {
            // A prefix command cannot answer privately: the quiz is only taken via /verify or the button.
            if (interaction._isPrefixCommand) {
                return await InteractionHelper.safeReply(interaction, {
                    embeds: [infoEmbed(tr.t('verification.verify.quizTitle'), tr.t('verification.verify.quizPrefix'))],
                    allowedMentions: { parse: [] },
                });
            }
            return await InteractionHelper.safeEditReply(interaction, quiz);
        }

        if (isOAuthVerificationEnabled()) {
            // This server's own setup decides, before the member authorizes anything.
            const problem = await verificationSetupProblem(client, guild.id, { lang });
            if (problem) return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: problem });
            return await InteractionHelper.safeReply(interaction, {
                ...buildOAuthVerifyReply(guild.id, interaction.user.id, { lang }),
                flags: MessageFlags.Ephemeral,
            });
        }

        const result = await verifyUser(client, guild.id, interaction.user.id, {
            source: 'command_self',
            moderatorId: null,
            lang,
        });

        if (result.status === 'already_verified') {
            return await InteractionHelper.safeReply(interaction, {
                embeds: [infoEmbed(tr.t('verification.verify.alreadyTitle'), tr.t('verification.verify.alreadyText'))],
                flags: MessageFlags.Ephemeral
            });
        }

        await InteractionHelper.safeReply(interaction, {
            embeds: [successEmbed(
                tr.t('verification.verify.verifiedTitle'),
                tr.t('verification.verify.verifiedText', { role: result.roleName, privacy: verifyPrivacyNote('direct', { lang }) })
            )],
            flags: MessageFlags.Ephemeral
        });
    }
};
