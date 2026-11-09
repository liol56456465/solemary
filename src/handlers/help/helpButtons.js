import { supportInviteUrl } from '../../commands/Core/support.js';
import { createEmbed } from '../../utils/embeds.js';
import { canSeeAdminCommands } from '../../utils/commandGate.js';
import { createAllCommandsMenu, createHelpPage, parseHelpPageId } from './helpSelectMenus.js';
import { createInitialHelpMenu } from '../../commands/Core/help.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { replyText } from '../../utils/commandLocalizations.js';

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

            const { embeds, components } = await createInitialHelpMenu(client, interaction.guildId, canSeeAdminCommands(interaction), replyText(interaction));
            await interaction.editReply({
                embeds,
                components,
                allowedMentions: { parse: [] },
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
        const tr = replyText(interaction);
        // Bugs are reported in the Mewvo support server (the same invite as /support).
        const supportButton = new ButtonBuilder()
            .setLabel(tr.t('core.help.bug.button'))
            .setStyle(ButtonStyle.Link)
            .setURL(supportInviteUrl());

        const bugRow = new ActionRowBuilder().addComponents(supportButton);

        const bugReportEmbed = createEmbed({
            title: tr.t('core.help.bug.title'),
            description: tr.t('core.help.bug.description'),
            color: 'error'
        });
        bugReportEmbed.setFooter({ text: 'Mewvo', iconURL: client.user.displayAvatarURL() });

        await interaction.reply({
            embeds: [bugReportEmbed],
            components: [bugRow],
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
    },
};

// Messages posted before the page moved into the customId have buttons help-page_first|prev|next|last
// and a disabled "Page x of y" button. Those labels were always English (getPaginationRow), so the
// page is still read from it for them only. New buttons carry the page: help-page:<view>:<action>:<page>.
export const LEGACY_PAGINATION_IDS = Object.freeze(['first', 'prev', 'next', 'last'].map((action) => `${PAGINATION_PREFIX}_${action}`));

export function getLegacyPaginationInfo(components) {
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

/** The page an old-format button opens (the all-commands list; the menu clamps it to the current count). */
export function legacyTargetPage(customId, components) {
    const { currentPage, totalPages } = getLegacyPaginationInfo(components);
    switch (customId) {
        case `${PAGINATION_PREFIX}_first`: return 1;
        case `${PAGINATION_PREFIX}_prev`: return Math.max(1, currentPage - 1);
        case `${PAGINATION_PREFIX}_next`: return Math.min(totalPages, currentPage + 1);
        case `${PAGINATION_PREFIX}_last`: return totalPages;
        default: return currentPage;
    }
}

function logUnavailable(interaction, error) {
    logger.warn('Help pagination interaction already acknowledged or expired.', {
        event: 'interaction.help.pagination.unavailable',
        errorCode: String(error.code),
        customId: interaction.customId,
        interactionId: interaction.id,
    });
}

/** help-page:<view>:<action>:<page>. A malformed id or an unknown view opens the help start page. */
export const helpPageButton = {
    name: PAGINATION_PREFIX,
    async execute(interaction, client) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate();
            }

            const tr = replyText(interaction);
            const showAdmin = canSeeAdminCommands(interaction);
            const target = parseHelpPageId(interaction.customId);
            const menu = (target && await createHelpPage(target.view, target.page, client, interaction.guildId, showAdmin, tr))
                || await createInitialHelpMenu(client, interaction.guildId, showAdmin, tr);
            await interaction.editReply({ embeds: menu.embeds, components: menu.components, allowedMentions: { parse: [] } });
        } catch (error) {
            if (error?.code === 40060 || error?.code === 10062) {
                logUnavailable(interaction, error);
                return;
            }

            throw error;
        }
    },
};

/** Old-format buttons (help-page_first etc.) on messages posted before the customId carried the page. */
export const helpPaginationButton = {
    name: `${PAGINATION_PREFIX}_next`,
    async execute(interaction, client) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate();
            }

            const nextPage = legacyTargetPage(interaction.customId, interaction.message?.components);
            const { embeds, components } = await createAllCommandsMenu(nextPage, client, interaction.guildId, canSeeAdminCommands(interaction), replyText(interaction));
            await interaction.editReply({ embeds, components, allowedMentions: { parse: [] } });
        } catch (error) {
            if (error?.code === 40060 || error?.code === 10062) {
                logUnavailable(interaction, error);
                return;
            }

            throw error;
        }
    },
};
