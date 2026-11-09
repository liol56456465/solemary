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
import { categoryLabel } from '../../config/commands/commandCategories.js';
import { usesHomeValues } from '../../services/settings/guildScoped.js';
import { isModmailSetUp } from '../../services/modmailService.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
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

/**
 * What the start page depends on in this server: { home, modmail }.
 *   home     one of Mewvo's own servers (the "support us by boosting" line is only there)
 *   modmail  the server takes modmail (modmailService.js isModmailSetUp); the member steps only
 *            mention "DM the bot" then. Unreadable config: false (the line is left out).
 * `config`: the guild config the dispatcher already read (saves a read).
 */
export async function helpMenuOptions(client, guildId, config = null, { getConfig = getGuildConfig } = {}) {
    const home = usesHomeValues(guildId);
    const guild = guildId ? client?.guilds?.cache?.get?.(guildId) || null : null;
    let modmail = false;
    if (guild) {
        try {
            modmail = Boolean(isModmailSetUp(guild, config || await getConfig(client, guildId)));
        } catch (error) {
            logger.debug(`Help: modmail state of ${guildId} unknown (${error?.message || error}); not mentioned`);
        }
    }
    return { home, modmail };
}

/**
 * The help start page. `tr`: the viewer's text functions (ephemeral menu: their Discord language).
 * `options` from helpMenuOptions (default: home by the guild id, no modmail line).
 */
export async function createInitialHelpMenu(client, guildId = null, showAdmin = true, tr = botText('en'), menuOptions = {}) {
    const { home = usesHomeValues(guildId), modmail = false } = menuOptions;
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
            const categoryName = categoryLabel(category, tr);
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
        // The boosting line belongs to Mewvo's own servers; everywhere else a neutral line.
        description: tr.t(home ? 'core.help.menu.description' : 'core.help.menu.descriptionNeutral'),
        color: 'primary',
        thumbnail: client.user?.displayAvatarURL?.({ size: 1024 }),
        fields: [
            {
                name: tr.t('core.help.menu.gettingStarted'),
                value: showAdmin ? tr.t('core.help.menu.adminSteps')
                    : [tr.t('core.help.menu.memberSteps'), ...(modmail ? [tr.t('core.help.menu.memberModmail')] : [])].join('\n'),
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
        const options = await helpMenuOptions(client, interaction.guildId, guildConfig);
        const { embeds, components } = await createInitialHelpMenu(client, interaction.guildId, canSeeAdminCommands(interaction), tr, options);

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
