import { successEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { evaluateMathExpression } from '../utils/safeMathParser.js';

import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { publicText, replyText } from '../utils/commandLocalizations.js';
function evaluate(expression) {
    return evaluateMathExpression(expression);
}

/**
 * The calculator context a modal submit may use: only the submitter's own. The key in the
 * customId is client-supplied, so it must be `${userId}_<op>` for this user and the stored
 * context must belong to them. Returns { context } (null when missing/expired) or { notYours: true }.
 */
export function resolveCalculatorContext(contexts, contextKey, userId) {
    const key = String(contextKey || '');
    const uid = String(userId || '');
    if (!uid || !key.startsWith(`${uid}_`)) return { notYours: true };
    const context = contexts.get(key) || null;
    if (context && String(context.userId) !== uid) return { notYours: true };
    return { context };
}

async function calculateModalHandler(interaction, client, args) {
    // Refusals before the reply is opened only the submitter sees (their language); the result
    // is posted in the channel and the calculator message updated (the server's language).
    const tr = replyText(interaction);
    const trPublic = publicText(interaction);
    try {
        const operation = args[0];
        const operandInput = interaction.fields.fields.first();
        const contextKey = operandInput?.customId?.split(':')[1];
        
        if (!contextKey) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('tools.calculate.modal.noContext'), context: { lang: tr.lang } });
        }

        const { calculationContexts } = await import('../commands/Tools/modules/tools_calculate.js');
        const lookup = resolveCalculatorContext(calculationContexts, contextKey, interaction.user.id);
        if (lookup.notYours) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('tools.calculate.modal.notYours'), context: { lang: tr.lang } });
        }
        const context = lookup.context;
        
        if (!context) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('tools.calculate.modal.contextTimedOut'), context: { lang: tr.lang } });
        }

        await interaction.deferReply({ ephemeral: false });

        const operand = interaction.fields.getTextInputValue(operandInput.customId);
        
        if (!operand || isNaN(operand)) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: trPublic.t('tools.calculate.modal.notNumber'), context: { lang: trPublic.lang } });
        }

        const { expression, formattedResult, operator } = context;
        const newExpression = `(${expression}) ${operator} (${operand})`;

        let newResult;
        try {
            newResult = evaluate(newExpression);
            
            let formattedNewResult;
            if (typeof newResult === "number") {
                formattedNewResult = newResult.toLocaleString("en-US", {
                    maximumFractionDigits: 10,
                });

                if (
                    Math.abs(newResult) > 0 &&
                    (Math.abs(newResult) >= 1e10 || Math.abs(newResult) < 1e-3)
                ) {
                    formattedNewResult = newResult.toExponential(6);
                }
            } else {
                formattedNewResult = String(newResult);
            }

            const updatedEmbed = successEmbed(
                trPublic.t('tools.calculate.resultTitle'),
                trPublic.t('tools.calculate.modal.updatedBody', { expression: newExpression.replace(/`/g, "\`"), result: formattedNewResult }),
            );

            try {
                if (context.messageId && context.channelId) {
                    const channel = await client.channels.fetch(context.channelId);
                    const message = await channel.messages.fetch(context.messageId);
                    await message.edit({
                        embeds: [updatedEmbed],
                    });
                }
            } catch (editError) {
                logger.warn('Could not edit original message:', editError.message);
            }

            calculationContexts.delete(contextKey);

            await interaction.editReply({
                embeds: [successEmbed(trPublic.t('tools.calculate.resultTitle'), `\`${newExpression}\` = \`${formattedNewResult}\``)],
            });

        } catch (calcError) {
            logger.error('Calculate evaluation error:', calcError);
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: trPublic.t('tools.calculate.evalFailed'), context: { lang: trPublic.lang } });
        }
    } catch (error) {
        logger.error('Calculate modal handler error:', error);
        try {
            // Before the reply is opened only the submitter sees it; after, it is in the channel.
            const trError = !interaction.replied && !interaction.deferred ? tr : trPublic;
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: trError.t('tools.calculate.modal.failed'), context: { lang: trError.lang } });
        } catch (err) {
            logger.error('Failed to send error message:', err);
        }
    }
}

export default {
    execute: calculateModalHandler
};