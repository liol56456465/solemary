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

const CATEGORY_ICONS = {
    Core: "ℹ️",
    Moderation: "🛡️",
    Fun: "🎮",
    Leveling: "📊",
    Utility: "🔧",
    Ticket: "🎫",
    Welcome: "👋",
    Giveaway: "🎉",
    Counter: "🔢",
    Tools: "🛠️",
    Search: "🔍",
    "Reaction Roles": "🎭",
    Community: "👥",
    Birthday: "🎂",
    "Join To Create": "🔌",
    Verification: "✅",
    Enforcement: "⚖️",
};

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
            label: "📋 All Commands",
            description: "Browse every available command in a single list",
            value: ALL_COMMANDS_ID,
        },
        ...categoryDirs.map((category) => {
            const categoryName = formatCategoryName(category);
            const icon = CATEGORY_ICONS[categoryName] || "🔍";
            return {
                label: `${icon} ${categoryName}`,
                description: `View commands in the ${categoryName} category`,
                value: category,
            };
        }),
    ];

    const botName = client?.user?.username || "Bot";
    const embed = createEmbed({
        title: `📖 ${botName} Help`,
        description: 'support us by boosting',
        color: 'primary',
        thumbnail: client.user?.displayAvatarURL?.({ size: 1024 }),
        fields: [
            {
                name: '🚀 Getting Started',
                value: (showAdmin ? [
                    '1. **/configwizard** to configure prefix, mod role, and logs.',
                    '2. **/commands dashboard** to turn categories on or off.',
                    '3. **Browse commands** — Use the menu below to view categories and commands.',
                ] : [
                    'Pick a category in the menu below to see its commands.',
                    'Need staff? DM the bot: your message goes to the team privately (modmail).',
                ]).join('\n'),
                inline: false,
            },
            {
                name: '🔒 Access',
                value: [
                    showAdmin
                        ? '• Commands marked 🔒 need the **Administrator** permission; the rest are for everyone.'
                        : '• This list shows the commands you can use.',
                    '• Commands only work in the Meowist servers.',
                    ...(showAdmin ? ['• **/setappeal** posts the appeal panels; **/appeals** lists, shows and decides appeals.'] : []),
                ].join('\n'),
                inline: false,
            },
            {
                name: 'ℹ️ How It Works',
                value: [
                    '• Dashboard commands manage each feature visually',
                    '• Settings are saved per server',
                    '• Slash commands and prefixes both work once enabled',
                ].join('\n'),
                inline: false,
            },
            {
                name: '\u200B',
                value: `-#`,
                inline: false,
            },
        ],
    });

    embed.setFooter({ 
        text: "Made with ❤️" 
    });
    embed.setTimestamp();

    const supportButton = new ButtonBuilder()
        .setLabel("Support Server")
        .setURL("https://discord.gg/8x8w6gbEuZ")
        .setStyle(ButtonStyle.Link);

    const selectRow = createSelectMenu(
        CATEGORY_SELECT_ID,
        "Select to view the commands",
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
        .setDescription("Displays the help menu with all available commands"),

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
                    description: "Help menu has been closed, use /help again.",
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
