import { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { evaluateMathExpression } from '../../../utils/safeMathParser.js';
import { BoundedMap } from '../../../utils/boundedMap.js';
import { localized, publicText, replyText } from '../../../utils/commandLocalizations.js';

// Bounded (B5): contexts wait for a modal answer (the oldest dropped first: that modal
// then says "timed out"); history keeps each user's last few results.
const calculationContexts = new BoundedMap(1000);

function evaluate(expression) {
    return evaluateMathExpression(expression);
}

const calculationHistory = new BoundedMap(5000);
const MAX_HISTORY = 5;

export { calculationContexts };

// The modal title per button (catalog keys).
const MODAL_TITLE_KEYS = {
    add: 'tools.calculate.modalTitle.add',
    subtract: 'tools.calculate.modalTitle.subtract',
    multiply: 'tools.calculate.modalTitle.multiply',
    divide: 'tools.calculate.modalTitle.divide',
};

export default {
    data: new SlashCommandBuilder()
        .setName("calculate")
        .setDescription("Evaluate a mathematical expression")
        .addStringOption((option) =>
            option
                .setName("expression")
                .setDescription(
                    "The mathematical expression to evaluate (e.g., 2+2*3, sin(45 deg), 16^0.5)",
                )
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.calculate.options.expression'))
                .setRequired(true),
        ),

    async execute(interaction) {
        // The result is posted in the channel (not ephemeral): the server's language. Answers only
        // the clicker sees (history, the number modal) use the clicker's language.
        const tr = publicText(interaction);
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Calculate interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'calculate'
            });
            return;
        }

        const expression = interaction.options.getString("expression");

        if (
            !/^[0-9+\-*/.()^%! ,<>=&|~?:\[\]{}a-z√π∞°]+$/i.test(expression)
        ) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: tr.t('tools.calculate.badCharacters'),
                context: { lang: tr.lang },
            });
        }

        const dangerousPatterns = [
            /\b(?:import|require|process|fs|child_process|exec|eval|Function|setTimeout|setInterval|new\s+Function)\s*\(/i,
            /`/g,
            /\$\{.*\}/,
            /\b(?:localStorage|document|window|fetch|XMLHttpRequest)\b/,
            /\b(?:while|for)\s*\([^)]*\)\s*\{/,
            /\b(?:function\*|yield|await|async)\b/,
        ];

        for (const pattern of dangerousPatterns) {
            if (pattern.test(expression)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.VALIDATION,
                    message: tr.t('tools.calculate.looksLikeCode'),
                    context: { lang: tr.lang },
                });
            }
        }

        let result;
        try {
            result = evaluate(expression);

            let formattedResult;
            if (typeof result === "number") {
                formattedResult = result.toLocaleString("en-US", {
                    maximumFractionDigits: 10,
                });

                if (
                    Math.abs(result) > 0 &&
                    (Math.abs(result) >= 1e10 || Math.abs(result) < 1e-3)
                ) {
                    formattedResult = result.toExponential(6);
                }
            } else if (typeof result === "boolean") {
                formattedResult = result ? "true" : "false";
            } else if (result === null || result === undefined) {
                formattedResult = tr.t('tools.calculate.noResult');
            } else if (
                Array.isArray(result) ||
                typeof result === "object"
            ) {
                formattedResult =
                    "```json\n" + JSON.stringify(result, null, 2) + "\n```";
            } else {
                formattedResult = String(result);
            }

            const userId = interaction.user.id;
            if (!calculationHistory.has(userId)) {
                calculationHistory.set(userId, []);
            }

            const history = calculationHistory.get(userId);
            history.unshift({
                expression,
                result: formattedResult,
                timestamp: Date.now(),
            });

            if (history.length > MAX_HISTORY) {
                history.pop();
            }

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`calc_${interaction.id}_add`)
                    .setLabel("+")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`calc_${interaction.id}_subtract`)
                    .setLabel("-")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`calc_${interaction.id}_multiply`)
                    .setLabel("×")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`calc_${interaction.id}_divide`)
                    .setLabel("÷")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`calc_${interaction.id}_history`)
                    .setLabel(tr.t('tools.calculate.history'))
                    .setStyle(ButtonStyle.Secondary),
            );

            const embed = successEmbed(
                tr.t('tools.calculate.resultTitle'),
                tr.t('tools.calculate.resultBody', { expression: expression.replace(/`/g, "\`"), result: formattedResult }),
            );

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed],
                components: [row],
            });

            const filter = (i) =>
                i.customId.startsWith(`calc_${interaction.id}`) &&
                i.user.id === interaction.user.id;
            const BUTTON_TIMEOUT = 300000;
            const collector =
                interaction.channel.createMessageComponentCollector({
                    filter,
                    time: BUTTON_TIMEOUT,
                });

            collector.on("collect", async (i) => {
                const trClicker = replyText(i);
                try {
                    const operation = i.customId.split("_")[2];

                    if (operation === "history") {
                        if (!i.deferred && !i.replied) {
                            await i.deferUpdate().catch(console.error);
                        }

                        const userHistory =
                            calculationHistory.get(userId) || [];

                        if (userHistory.length === 0) {
                            await i.followUp({
                                content: trClicker.t('tools.calculate.noHistory'),
                                flags: ["Ephemeral"],
                            });
                            return;
                        }

                        const historyText = userHistory
                            .map(
                                (item, index) =>
                                    `${index + 1}. **${item.expression}** = \`${item.result}\`\n` +
                                    `<t:${Math.floor(item.timestamp / 1000)}:R>`,
                            )
                            .join("\n\n");

                        await i.followUp({
                            content: trClicker.t('tools.calculate.historyTitle', { list: historyText }),
                            flags: ["Ephemeral"],
                        });
                        return;
                    }

                    let operator = "";

                    switch (operation) {
                        case "add":
                            operator = "+";
                            break;
                        case "subtract":
                            operator = "-";
                            break;
                        case "multiply":
                            operator = "*";
                            break;
                        case "divide":
                            operator = "/";
                            break;
                    }

                    try {
                        const contextKey = `${i.user.id}_${operation}`;
                        calculationContexts.set(contextKey, {
                            expression,
                            formattedResult,
                            operator,
                            messageId: i.message?.id,
                            channelId: i.channelId,
                            userId: i.user.id
                        });

                        await i.showModal({
                            customId: `calc_modal:${operation}`,
                            title: trClicker.t(MODAL_TITLE_KEYS[operation]).slice(0, 45),
                            components: [
                                {
                                    type: 1,
                                    components: [
                                        {
                                            type: 4,
                                            customId: `operand:${contextKey}`,
                                            label: trClicker.t('tools.calculate.operandLabel', { operator, result: formattedResult }).slice(0, 45),
                                            placeholder: trClicker.t('tools.calculate.operandPlaceholder'),
                                            style: 1,
                                            required: true,
                                            maxLength: 50,
                                        },
                                    ],
                                },
                            ],
                        });
                    } catch (modalError) {
                        logger.error("Failed to show modal:", modalError);
                        if (!i.replied && !i.deferred) {
                            await i.reply({
                                content: trClicker.t('tools.calculate.modalFailed'),
                                flags: ["Ephemeral"],
                            }).catch(console.error);
                        }
                        return;
                    }

                } catch (error) {
                    logger.error("Button interaction error:", error);
                    if (!i.deferred && !i.replied) {
                        await i.reply({
                            content: trClicker.t('tools.calculate.buttonFailed'),
                            flags: ["Ephemeral"],
                        }).catch(console.error);
                    }
                }
            });

            collector.on("end", (collected, reason) => {
                if (reason === "timeout") {
                    const disabledRow =
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId(
                                    `calc_${interaction.id}_expired`,
                                )
                                .setLabel(tr.t('tools.calculate.expiredButton'))
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(true),
                        );

                    interaction
                        .editReply({
                            components: [disabledRow],
                            content: tr.t('tools.calculate.timedOut'),
                        })
                        .catch(console.error);
                } else {
                    const disabledRow = ActionRowBuilder.from(
                        row,
                    ).setComponents(
                        row.components.map((component) =>
                            ButtonBuilder.from(component).setDisabled(true),
                        ),
                    );

                    interaction
                        .editReply({ components: [disabledRow] })
                        .catch(console.error);
                }
            });
        } catch (error) {
            logger.error('Calculation error:', error);

            // The two sentences used to be joined without a space ("expression.The"); fixed.
            let detail;
            if (error.message.includes('Unexpected type')) {
                detail = tr.t('tools.calculate.unsupported');
            } else if (error.message.includes('Undefined symbol')) {
                detail = tr.t('tools.calculate.undefinedSymbol');
            } else if (error.message.includes('Brackets not balanced')) {
                detail = tr.t('tools.calculate.unbalanced');
            } else if (
                error.message.includes('Unexpected operator') ||
                error.message.includes('Unexpected character')
            ) {
                detail = tr.t('tools.calculate.badOperator');
            } else {
                detail = tr.t('tools.calculate.checkAgain');
            }

            await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: `${tr.t('tools.calculate.evalFailed')} ${detail}`,
                context: { lang: tr.lang },
            });
        }
    },
};