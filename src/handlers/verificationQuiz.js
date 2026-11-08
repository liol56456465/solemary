// verificationQuiz.js — the rules quiz answer buttons (custom id vquiz:<userId>:<nonce>:<step>:<choice>).
// The quiz itself (questions, shuffling, state, messages) is in services/verificationQuiz.js.
// Per click: the clicking user must be the one in the id (else a private refusal), then
// deferUpdate (nothing slow before it, so well within 3 s), then the answer is recorded.

import { MessageFlags } from 'discord.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { handleInteractionError } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';
import { textForInteraction } from '../utils/botText.js';
import {
    expiredPayload, failedPayload, notYourQuizMessage, parseQuizButtonArgs, questionPayload, quizStore, rulesLocation,
} from '../services/verificationQuiz.js';
import { continueVerification } from './verificationButtons.js';

export async function handleQuizButton(interaction, client, args, { store = quizStore, proceed = continueVerification } = {}) {
    try {
        // Every answer here is ephemeral: the clicking member's Discord language.
        const { lang } = textForInteraction(interaction);
        const parsed = parseQuizButtonArgs(args);
        if (!parsed || !interaction.guild) {
            await interaction.deferUpdate();
            return await InteractionHelper.safeEditReply(interaction, expiredPayload({ lang }));
        }
        if (parsed.userId !== interaction.user.id) {
            return await interaction.reply({ content: notYourQuizMessage({ lang }), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        }
        await interaction.deferUpdate();

        const guildId = interaction.guild.id;
        const result = store.answer(guildId, parsed.userId, parsed.nonce, parsed.step, parsed.choice);
        switch (result.status) {
            case 'stale':
            case 'next':
                return await InteractionHelper.safeEditReply(interaction, questionPayload(result.attempt, { lang }));
            case 'failed':
                logger.info('Rules quiz failed', { guildId, userId: parsed.userId });
                return await InteractionHelper.safeEditReply(interaction, failedPayload(result.attempt.cooldownMinutes, rulesLocation(interaction.guild, process.env, { lang }), { lang }));
            case 'passed':
                logger.info('Rules quiz passed', { guildId, userId: parsed.userId });
                try {
                    return await proceed(interaction, client, { source: 'button_click_quiz' });
                } catch (error) {
                    // The pass is kept (Verify again goes straight on); drop the last question's buttons first.
                    await InteractionHelper.safeEditReply(interaction, { components: [] });
                    throw error;
                }
            default:
                return await InteractionHelper.safeEditReply(interaction, expiredPayload({ lang }));
        }
    } catch (error) {
        logger.error('Error in rules quiz button handler', { error: error.message, guildId: interaction.guild?.id, userId: interaction.user?.id });
        await handleInteractionError(interaction, error, { command: 'verify_quiz', action: 'verification' });
    }
}
