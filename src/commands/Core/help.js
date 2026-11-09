import { supportInviteUrl } from './support.js';
import {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from "discord.js";
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { isCommandAvailableInGuild, canSeeAdminCommands } from '../../utils/commandGate.js';
import { hasEveryoneAccess } from '../../config/commands/commandAccess.js';
import { createEmbed } from "../../utils/embeds.js";
import { botText } from '../../utils/botText.js';
import { localized, replyText } from '../../utils/commandLocalizations.js';
import {
    createSelectMenu,
} from "../../utils/components.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CATEGORY_SELECT_ID = "help-category-select";
const ALL_COMMANDS_ID = "help-all-commands";
const HELP_MENU_TIMEOUT_MS = 5 * 60 * 1000;

function formatCategoryName(rawCategory) {
    return rawCategory
        .replace(/_/g, '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** The help start page. `tr`: the viewer's text functions (ephemeral menu: their Discord language). */
export async function createInitialHelpMenu(client, guildId = null, showAdmin = true, tr = botText('en')) {
    const commandsPath = path.join(__dirname, "../../commands");
    // Only list categories with at least one command this viewer can use in this server.
    const availableCategories = new Set(
        [...(client?.commands?.values?.() ?? [])]
            .filter((command) => isCommandAvailableInGuild(command, guildId))
            .filter((command) => showAdmin || hasEveryoneAccess(command.data?.name))
            .map((command) => command.category)
    );
    const categoryDirs = (
        await fs.readdir(commandsPath, { withFileTypes: true })
    )
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name)
        .filter((category) => availableCategories.size === 0 || availableCategories.has(category))
        .sort();

    const options = [
        {
            label: tr.t('core.help.menu.allLabel'),
            description: tr.t('core.help.menu.allDescription'),
            value: ALL_COMMANDS_ID,
        },
        ...categoryDirs.map((category) => {
            const categoryName = formatCategoryName(category);
            return {
                label: categoryName,
                description: tr.t('core.help.menu.categoryDescription', { category: categoryName }).slice(0, 100),
                value: category,
            };
        }),
    ];

    const botName = client?.user?.username || "Bot";
    const embed = createEmbed({
        title: tr.t('core.help.menu.title', { bot: botName }),
        description: tr.t('core.help.menu.description'),
        color: 'primary',
        thumbnail: client.user?.displayAvatarURL?.({ size: 1024 }),
        fields: [
            {
                name: tr.t('core.help.menu.gettingStarted'),
                value: showAdmin ? tr.t('core.help.menu.adminSteps') : tr.t('core.help.menu.memberSteps'),
                inline: false,
            },
            {
                name: tr.t('core.help.menu.access'),
                value: [
                    showAdmin ? tr.t('core.help.menu.accessAdmin') : tr.t('core.help.menu.accessMember'),
                    ...(showAdmin ? [tr.t('core.help.menu.accessSetup')] : []),
                    ...(showAdmin ? [tr.t('core.help.menu.accessAppeals')] : []),
                ].join('\n'),
                inline: false,
            },
            {
                name: tr.t('core.help.menu.goodToKnow'),
                value: tr.t('core.help.menu.goodToKnowText'),
                inline: false,
            },
        ],
    });

    embed.setTimestamp();

    const supportButton = new ButtonBuilder()
        .setLabel(tr.t('core.help.menu.supportButton'))
        .setURL(supportInviteUrl())
        .setStyle(ButtonStyle.Link);

    const selectRow = createSelectMenu(
        CATEGORY_SELECT_ID,
        tr.t('core.help.menu.placeholder'),
        options,
    );

    const buttonRow = new ActionRowBuilder().addComponents([
        supportButton,
    ]);

    return {
        embeds: [embed],
        components: [buttonRow, selectRow],
    };
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName("help")
        .setDescription("Show the commands you can use")
        .setDescriptionLocalizations(localized('core.slash.help.description')),

    async execute(interaction, guildConfig, client) {
        
        const { MessageFlags } = await import('discord.js');
        // Private: only the person who asked sees it and can use its menu.
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        const tr = replyText(interaction);
        const { embeds, components } = await createInitialHelpMenu(client, interaction.guildId, canSeeAdminCommands(interaction), tr);

        await InteractionHelper.safeEditReply(interaction, {
            embeds,
            components,
        });

        setTimeout(async () => {
            try {
                if (!InteractionHelper.isInteractionValid(interaction)) {
                    return;
                }

                const closedEmbed = createEmbed({
                    title: tr.t('core.help.closed.title'),
                    description: tr.t('core.help.closed.description'),
                    color: "secondary",
                });

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [closedEmbed],
                    components: [],
                });
            } catch (error) {
                logger.debug('Help menu close edit failed (interaction may have expired):', error?.message);
            }
        }, HELP_MENU_TIMEOUT_MS);
    },
};
