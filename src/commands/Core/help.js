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

export async function createInitialHelpMenu(client, guildId = null, showAdmin = true) {
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
            label: "All commands",
            description: "Every command in one list",
            value: ALL_COMMANDS_ID,
        },
        ...categoryDirs.map((category) => {
            const categoryName = formatCategoryName(category);
            return {
                label: categoryName,
                description: `${categoryName} commands`,
                value: category,
            };
        }),
    ];

    const botName = client?.user?.username || "Bot";
    const embed = createEmbed({
        title: `${botName} help`,
        description: 'support us by boosting',
        color: 'primary',
        thumbnail: client.user?.displayAvatarURL?.({ size: 1024 }),
        fields: [
            {
                name: 'Getting started',
                value: (showAdmin ? [
                    '1. **/configwizard** sets the mod role and log channel.',
                    '2. **/commands dashboard** turns categories on or off.',
                    '3. Pick a category in the menu below to see its commands.',
                ] : [
                    'Pick a category in the menu below to see its commands.',
                    'Need staff? DM the bot: your message goes to the team privately (modmail).',
                ]).join('\n'),
                inline: false,
            },
            {
                name: 'Access',
                value: [
                    showAdmin
                        ? '• Commands marked 🔒 need the **Administrator** permission; the rest are for everyone.'
                        : '• This list shows the commands you can use.',
                    '• Commands only work in the Mewvo servers.',
                    ...(showAdmin ? ['• **/setappeal** posts the appeal panels; **/appeals** lists, shows and decides appeals.'] : []),
                ].join('\n'),
                inline: false,
            },
            {
                name: 'Good to know',
                value: [
                    '• Most features have a dashboard command for their settings',
                    '• Settings are saved per server',
                ].join('\n'),
                inline: false,
            },
        ],
    });

    embed.setTimestamp();

    const supportButton = new ButtonBuilder()
        .setLabel("Support Server")
        .setURL(supportInviteUrl())
        .setStyle(ButtonStyle.Link);

    const selectRow = createSelectMenu(
        CATEGORY_SELECT_ID,
        "Pick a category",
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
        .setDescription("Show the commands you can use"),

    async execute(interaction, guildConfig, client) {
        
        const { MessageFlags } = await import('discord.js');
        // Private: only the person who asked sees it and can use its menu.
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        const { embeds, components } = await createInitialHelpMenu(client, interaction.guildId, canSeeAdminCommands(interaction));

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
                    title: "Help menu closed",
                    description: "Run /help again to open it.",
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
