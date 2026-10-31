import { supportInviteUrl } from '../../commands/Core/support.js';
import { createEmbed } from '../../utils/embeds.js';
import { canSeeAdminCommands } from '../../utils/commandGate.js';
import { createAllCommandsMenu } from './helpSelectMenus.js';
import { createInitialHelpMenu } from '../../commands/Core/help.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';

const BACK_BUTTON_ID = "help-back-to-main";
const PAGINATION_PREFIX = "help-page";
const BUG_REPORT_BUTTON_ID = "help-bug-report";

export const helpBackButton = {
    name: BACK_BUTTON_ID,
    async execute(interaction, client) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate();
            }

            const { embeds, components } = await createInitialHelpMenu(client, interaction.guildId, canSeeAdminCommands(interaction));
            await interaction.editReply({
                embeds,
                components,
            });
        } catch (error) {
            if (error?.code === 40060 || error?.code === 10062) {
                logger.warn('Help back button interaction already acknowledged or expired.', {
                    event: 'interaction.help.button.unavailable',
                    errorCode: String(error.code),
                    customId: interaction.customId,
                    interactionId: interaction.id,
                });
                return;
            }

            throw error;
        }
    },
};

export const helpBugReportButton = {
    name: BUG_REPORT_BUTTON_ID,
    async execute(interaction, client) {
        // Bugs are reported in the Mewvo support server (the same invite as /support).
        const supportButton = new ButtonBuilder()
            .setLabel('Open the support server')
            .setStyle(ButtonStyle.Link)
            .setURL(supportInviteUrl());

        const bugRow = new ActionRowBuilder().addComponents(supportButton);

        const bugReportEmbed = createEmbed({
            title: 'Report a bug',
            description: 'Tell us in the support server what happened. It helps if you include:\n'
                + '- what you did (the command and its options)\n'
                + '- what you expected and what happened instead\n'
                + '- a screenshot, if you have one',
            color: 'error'
        });
        bugReportEmbed.setFooter({ text: 'Mewvo', iconURL: client.user.displayAvatarURL() });

        await interaction.reply({
            embeds: [bugReportEmbed],
            components: [bugRow],
            flags: MessageFlags.Ephemeral
        });
    },
};

function getPaginationInfo(components) {
    for (const row of components || []) {
        for (const component of row.components || []) {
            if (component.customId === `${PAGINATION_PREFIX}_page`) {
                const label = component.label || '';
                const match = label.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
                if (match) {
                    return {
                        currentPage: Number(match[1]),
                        totalPages: Number(match[2]),
                    };
                }
            }
        }
    }

    return { currentPage: 1, totalPages: 1 };
}

export const helpPaginationButton = {
    name: `${PAGINATION_PREFIX}_next`,
    async execute(interaction, client) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate();
            }

            const { currentPage, totalPages } = getPaginationInfo(interaction.message?.components);

            let nextPage = currentPage;
            switch (interaction.customId) {
                case `${PAGINATION_PREFIX}_first`:
                    nextPage = 1;
                    break;
                case `${PAGINATION_PREFIX}_prev`:
                    nextPage = Math.max(1, currentPage - 1);
                    break;
                case `${PAGINATION_PREFIX}_next`:
                    nextPage = Math.min(totalPages, currentPage + 1);
                    break;
                case `${PAGINATION_PREFIX}_last`:
                    nextPage = totalPages;
                    break;
                default:
                    nextPage = currentPage;
                    break;
            }

            const { embeds, components } = await createAllCommandsMenu(nextPage, client, interaction.guildId, canSeeAdminCommands(interaction));
            await interaction.editReply({ embeds, components });
        } catch (error) {
            if (error?.code === 40060 || error?.code === 10062) {
                logger.warn('Help pagination interaction already acknowledged or expired.', {
                    event: 'interaction.help.pagination.unavailable',
                    errorCode: String(error.code),
                    customId: interaction.customId,
                    interactionId: interaction.id,
                });
                return;
            }

            throw error;
        }
    },
};