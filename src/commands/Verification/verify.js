import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { infoEmbed, successEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { verifyUser } from '../../services/verificationService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { isOAuthVerificationEnabled } from '../../services/oauthVerification.js';
import { buildOAuthVerifyReply } from '../../handlers/verificationButtons.js';
import { quizGate } from '../../services/verificationQuiz.js';

export default {
    data: new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Verify yourself and gain access to the server'),

    async execute(interaction, config, client) {
        const guild = interaction.guild;
        // Ephemeral from here on (the replies below become edits of this deferred reply).
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        // The rules quiz comes first when it is on, as on the Verify button.
        const quiz = await quizGate(client, interaction);
        if (quiz) {
            // A prefix command cannot answer privately: the quiz is only taken via /verify or the button.
            if (interaction._isPrefixCommand) {
                return await InteractionHelper.safeReply(interaction, {
                    embeds: [infoEmbed('Rules quiz', 'Use /verify or the Verify button to take the rules quiz first.')],
                    allowedMentions: { parse: [] },
                });
            }
            return await InteractionHelper.safeEditReply(interaction, quiz);
        }

        if (isOAuthVerificationEnabled()) {
            return await InteractionHelper.safeReply(interaction, {
                ...buildOAuthVerifyReply(guild.id, interaction.user.id),
                flags: MessageFlags.Ephemeral,
            });
        }

        const result = await verifyUser(client, guild.id, interaction.user.id, {
            source: 'command_self',
            moderatorId: null
        });

        if (result.status === 'already_verified') {
            return await InteractionHelper.safeReply(interaction, {
                embeds: [infoEmbed('Already Verified', "You are already verified.")],
                flags: MessageFlags.Ephemeral
            });
        }

        await InteractionHelper.safeReply(interaction, {
            embeds: [successEmbed(
                "Verified",
                `You're verified and got the **${result.roleName}** role.`
            )],
            flags: MessageFlags.Ephemeral
        });
    }
};
