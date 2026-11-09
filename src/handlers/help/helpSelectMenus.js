import { createEmbed, cutText } from '../../utils/embeds.js';
import { createButton } from '../../utils/components.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Collection, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { isCommandAvailableInGuild, canSeeAdminCommands } from '../../utils/commandGate.js';
import { isEveryoneCommand } from '../../config/commands/commandAccess.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { botText } from '../../utils/botText.js';
import { DISCORD_LOCALES, replyText } from '../../utils/commandLocalizations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACK_BUTTON_ID = "help-back-to-main";
const ALL_COMMANDS_ID = "help-all-commands";
const PAGINATION_PREFIX = "help-page";
const CATEGORY_SELECT_ID = "help-category-select";
const SUBCOMMAND_TYPE = 1;
const SUBCOMMAND_GROUP_TYPE = 2;

// Registered command ids for the clickable </name:id> mentions: fetched once and kept for
// 10 minutes, not on every help click (they only change when the bot registers commands).
export const COMMAND_ID_CACHE_TTL_MS = 10 * 60 * 1000;
let commandIdCache = { at: 0, commands: null };

/** Collection name → registered command. A failed fetch gives an empty list (plain `/name` text) and is not cached. */
export async function getRegisteredCommands(client, { now = Date.now(), ttlMs = COMMAND_ID_CACHE_TTL_MS } = {}) {
    if (commandIdCache.commands && now - commandIdCache.at < ttlMs) return commandIdCache.commands;
    const registered = new Collection();
    if (!client?.application?.commands?.fetch) return registered;
    try {
        const commands = await client.application.commands.fetch();
        for (const cmd of commands.values()) registered.set(cmd.name, cmd);
    } catch (error) {
        logger.error('Error fetching registered commands:', error);
        return registered;
    }
    commandIdCache = { at: now, commands: registered };
    return registered;
}

/** For tests. */
export function _resetCommandIdCache() {
    commandIdCache = { at: 0, commands: null };
}

function formatCategoryName(rawCategory) {
    return rawCategory
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

// 🔒 marks admin-only entries; displayName is the command's access key.
function lockFor(entry) {
    return isEveryoneCommand(entry.displayName) ? '' : '🔒 ';
}

/** Members only see what they can run; admins see everything, admin-only marked 🔒. */
function visibleEntries(entries, showAdmin) {
    return showAdmin ? entries : entries.filter((entry) => isEveryoneCommand(entry.displayName));
}

/** A command's (or option's) description in the viewer's language, else its English one. */
function describe(node, locale) {
    return (locale && node?.description_localizations?.[locale]) || node?.description;
}

function buildHelpEntries(command, category, tr = botText('en')) {
    const locale = DISCORD_LOCALES[tr.lang]?.[0];
    const commandData = normalizeCommandData(command);
    if (!commandData?.name) {
        return [];
    }

    const baseName = commandData.name;
    const baseDescription = describe(commandData, locale) || tr.t('core.help.list.noDescription');
    const options = commandData.options || [];

    const entries = [];

    for (const option of options) {
        if (!option) continue;

        if (option.type === SUBCOMMAND_TYPE) {
            entries.push({
                baseName,
                displayName: `${baseName} ${option.name}`,
                description: describe(option, locale) || baseDescription,
                category,
            });
            continue;
        }

        if (option.type === SUBCOMMAND_GROUP_TYPE) {
            const nestedOptions = option.options || [];
            for (const nested of nestedOptions) {
                if (nested?.type !== SUBCOMMAND_TYPE) continue;

                entries.push({
                    baseName,
                    displayName: `${baseName} ${option.name} ${nested.name}`,
                    description: describe(nested, locale) || describe(option, locale) || baseDescription,
                    category,
                });
            }
        }
    }

    if (entries.length === 0) {
        entries.push({
            baseName,
            displayName: baseName,
            description: baseDescription,
            category,
        });
    }

    return entries;
}

function normalizeCommandData(command) {
    const rawData = command?.data;
    if (!rawData) {
        return null;
    }

    const jsonData = typeof rawData.toJSON === 'function' ? rawData.toJSON() : rawData;
    if (!jsonData?.name) {
        return null;
    }

    return {
        ...jsonData,
        options: Array.isArray(jsonData.options)
            ? jsonData.options.map((option) =>
                  typeof option?.toJSON === 'function' ? option.toJSON() : option,
              )
            : [],
    };
}

// Discord rejects a message whose embed breaks any of these (CLAUDE.md "Discord gotchas").
export const EMBED_LIMITS = Object.freeze({ total: 6000, title: 256, description: 4096, field: 1024, fields: 25 });
const CATEGORY_FIELD_CHARS = 1000;
const ALL_COMMANDS_PER_PAGE = 45;

// Pagination buttons: help-page:<view>:<action>:<page>. <view> is "all" or a command folder name,
// <page> is the page the button opens (the "page" action is the disabled indicator). The action
// keeps the ids unique within the row (on page 2, First and Previous both open page 1).
export const ALL_VIEW = 'all';
const PAGE_ACTIONS = Object.freeze(['first', 'prev', 'page', 'next', 'last']);
const MAX_PAGE = 9999;

export function helpPageId(view, action, page) {
    return `${PAGINATION_PREFIX}:${view}:${action}:${page}`;
}

/** { view, page } from a help-page:<view>:<action>:<page> id, or null when it is not one. */
export function parseHelpPageId(customId) {
    const [prefix, view, action, raw, ...rest] = String(customId ?? '').split(':');
    if (prefix !== PAGINATION_PREFIX || rest.length || !view || !PAGE_ACTIONS.includes(action)) return null;
    if (!/^\d{1,4}$/.test(raw ?? '')) return null;
    return { view, page: Math.max(1, Number(raw)) };
}

async function commandCategories() {
    const commandsPath = path.join(__dirname, "../../commands");
    return (await fs.readdir(commandsPath, { withFileTypes: true }))
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name)
        .sort();
}

/** True for a command folder name (the only categories a help-page button may name). */
export async function isHelpCategory(category) {
    return typeof category === 'string' && (await commandCategories()).includes(category);
}

/** The help entries of these command folders that this viewer can see in this server. */
async function loadHelpEntries(categories, guildId, showAdmin, tr) {
    const entries = [];
    for (const category of categories) {
        try {
            const categoryPath = path.join(__dirname, "../../commands", category);
            const commandFiles = (await fs.readdir(categoryPath))
                .filter((file) => file.endsWith(".js"))
                .sort();

            for (const file of commandFiles) {
                const filePath = path.join(categoryPath, file);
                const commandModule = await import(`file://${filePath}`);
                const command = commandModule.default;
                const commandData = normalizeCommandData(command);

                if (!commandData) continue;
                if (commandData.name === "help" || commandData.name === "commandlist") continue;
                if (!isCommandAvailableInGuild(command, guildId)) continue;

                entries.push(...visibleEntries(buildHelpEntries(command, formatCategoryName(category), tr), showAdmin));
            }
        } catch (error) {
            logger.error(
                `Error reading commands from category ${category}:`,
                error,
            );
        }
    }
    entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return entries;
}

/** One list line: a clickable </name:id> mention when the command is registered, else `/name`. */
function commandLine(cmd, registeredCommands, suffix) {
    const registeredCmd = registeredCommands.get(cmd.baseName);
    const name = registeredCmd && registeredCmd.id ? `</${cmd.displayName}:${registeredCmd.id}>` : `\`/${cmd.displayName}\``;
    return cutText(`${lockFor(cmd)}${name} · ${suffix}`, CATEGORY_FIELD_CHARS);
}

/** Lines → fields of at most CATEGORY_FIELD_CHARS each, in order. */
function chunkLines(lines, max = CATEGORY_FIELD_CHARS) {
    const chunks = [];
    let current = "";
    for (const line of lines) {
        if (current && (current + "\n" + line).length > max) {
            chunks.push(current);
            current = line;
        } else {
            current += (current ? "\n" : "") + line;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

// Tests lower this to page the real categories; the bot always uses Discord's 6000.
let totalLimit = EMBED_LIMITS.total;
export function _setEmbedTotalForTests(limit = EMBED_LIMITS.total) {
    totalLimit = limit;
}

/** True when these fields keep the embed (with this title and description) within Discord's limits. */
export function fitsEmbedLimits(fields, { title = '', description = '' } = {}) {
    if (fields.length > EMBED_LIMITS.fields) return false;
    let total = title.length + description.length;
    for (const field of fields) {
        if (field.value.length > EMBED_LIMITS.field || field.name.length > 256) return false;
        total += field.name.length + field.value.length;
    }
    return total <= totalLimit;
}

/**
 * Splits lines into pages, in order: each page takes as many lines as `layout` can show within the
 * embed limits (and at most `maxLines`). A page always takes at least one line.
 */
export function paginateLines(lines, { layout, title, description, maxLines = Infinity }) {
    const pages = [];
    let current = [];
    for (const line of lines) {
        const next = [...current, line];
        if (current.length && (next.length > maxLines || !fitsEmbedLimits(layout(next), { title, description }))) {
            pages.push(current);
            current = [line];
        } else {
            current = next;
        }
    }
    if (current.length) pages.push(current);
    return pages;
}

const clampPage = (page, totalPages) => Math.min(Math.max(1, Math.trunc(Number(page)) || 1), Math.max(1, totalPages));

/** First / Previous / Page x of y / Next / Last, labels in the viewer's language, page in the id. */
export function helpPaginationRow(view, page, totalPages, tr = botText('en')) {
    const button = (action, target, label, disabled) => new ButtonBuilder()
        .setCustomId(helpPageId(view, action, target))
        .setLabel(label)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled);
    return new ActionRowBuilder().addComponents(
        button('first', 1, tr.t('core.help.list.first'), page <= 1),
        button('prev', Math.max(1, page - 1), tr.t('core.help.list.previous'), page <= 1),
        button('page', page, tr.t('core.help.list.pageOf', { page, total: totalPages }), true),
        button('next', Math.min(totalPages, page + 1), tr.t('core.help.list.next'), page >= totalPages),
        button('last', totalPages, tr.t('core.help.list.last'), page >= totalPages),
    );
}

function backRow(tr) {
    return new ActionRowBuilder().addComponents(createButton(
        BACK_BUTTON_ID,
        tr.t('core.help.list.back'),
        "primary",
        null,
        false,
    ));
}

export async function createCategoryCommandsMenu(category, client, guildId = null, showAdmin = true, tr = botText('en'), page = 1) {
    const categoryName = formatCategoryName(category);
    // The name becomes a path: only an existing command folder is read (else the "no commands" page).
    const categoryCommands = await isHelpCategory(category) ? await loadHelpEntries([category], guildId, showAdmin, tr) : [];
    const registeredCommands = await getRegisteredCommands(client);
    const title = tr.t('core.help.list.categoryTitle', { category: categoryName });

    if (categoryCommands.length === 0) {
        const embed = createEmbed({ title, description: tr.t('core.help.list.empty', { category: categoryName }) });
        embed.setTimestamp();
        return { embeds: [embed], components: [backRow(tr)], currentPage: 1, totalPages: 1 };
    }

    const lines = categoryCommands.map((cmd) => commandLine(cmd, registeredCommands, cmd.description));
    const pagedDescription = `${tr.t('core.help.list.click')}\n${tr.t('core.help.list.changePage')}`;
    const layout = (pageLines, pageNo = MAX_PAGE, paged = true) => chunkLines(pageLines).map((chunk, index) => ({
        name: index > 0 ? tr.t('core.help.list.commandsCont')
            : paged ? tr.t('core.help.list.commandsPage', { page: pageNo }) : tr.t('core.help.list.commands'),
        value: chunk,
        inline: false,
    }));

    // Most categories fit on one page (unchanged look); a long one, or a long language, is paged.
    let pages = [lines];
    if (!fitsEmbedLimits(layout(lines, 1, false), { title, description: tr.t('core.help.list.click') })) {
        pages = paginateLines(lines, { layout, title, description: pagedDescription });
    }
    const totalPages = pages.length;
    const currentPage = clampPage(page, totalPages);
    const paged = totalPages > 1;

    const embed = createEmbed({ title, description: paged ? pagedDescription : tr.t('core.help.list.click') });
    embed.addFields(layout(pages[currentPage - 1], currentPage, paged));
    embed.setTimestamp();

    const components = [];
    if (paged) components.push(helpPaginationRow(category, currentPage, totalPages, tr));
    components.push(backRow(tr));

    return { embeds: [embed], components, currentPage, totalPages };
}

export async function createAllCommandsMenu(page = 1, client, guildId = null, showAdmin = true, tr = botText('en')) {
    const allCommands = await loadHelpEntries(await commandCategories(), guildId, showAdmin, tr);
    const registeredCommands = await getRegisteredCommands(client);
    const lines = allCommands.map((cmd) => commandLine(cmd, registeredCommands, cmd.category));

    const title = tr.t('core.help.list.allTitle');
    const changePage = tr.t('core.help.list.changePage');
    // Up to 45 commands per page in 1-3 inline columns, fewer when a page would break the limits.
    const layout = (pageLines, pageNo = MAX_PAGE) => {
        const columnCount = pageLines.length > 20 ? 3 : (pageLines.length > 10 ? 2 : 1);
        const chunkSize = Math.ceil(pageLines.length / columnCount);
        const fields = [];
        for (let i = 0; i < columnCount; i++) {
            const chunk = pageLines.slice(i * chunkSize, (i + 1) * chunkSize).join("\n");
            if (!chunk) continue;
            fields.push({
                name: i === 0 ? tr.t('core.help.list.commandsPage', { page: pageNo }) : tr.t('core.help.list.commandsCont'),
                value: chunk,
                inline: columnCount > 1,
            });
        }
        return fields;
    };
    const pages = paginateLines(lines, { layout, title, description: changePage, maxLines: ALL_COMMANDS_PER_PAGE });
    const totalPages = pages.length;
    const currentPage = clampPage(page, totalPages);

    const embed = createEmbed({
        title,
        description: totalPages > 1 ? changePage : null
    });
    embed.setTimestamp();
    if (pages.length) embed.addFields(layout(pages[currentPage - 1], currentPage));

    const components = [];
    if (totalPages > 1) components.push(helpPaginationRow(ALL_VIEW, currentPage, totalPages, tr));
    components.push(backRow(tr));

    return {
        embeds: [embed],
        components,
        currentPage,
        totalPages,
    };
}

/** The menu a help-page button opens: the all-commands list or one category; null for an unknown view. */
export async function createHelpPage(view, page, client, guildId = null, showAdmin = true, tr = botText('en')) {
    if (view === ALL_VIEW) return createAllCommandsMenu(page, client, guildId, showAdmin, tr);
    if (await isHelpCategory(view)) return createCategoryCommandsMenu(view, client, guildId, showAdmin, tr, page);
    return null;
}

export const helpCategorySelectMenu = {
    name: CATEGORY_SELECT_ID,
    async execute(interaction, client) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate();
            }

            const selectedCategory = interaction.values[0];
            const tr = replyText(interaction);

            // Only a command folder name opens a category (it becomes a path); anything else shows all.
            const view = selectedCategory !== ALL_COMMANDS_ID && await isHelpCategory(selectedCategory) ? selectedCategory : ALL_VIEW;
            const { embeds, components } = await createHelpPage(view, 1, client, interaction.guildId, canSeeAdminCommands(interaction), tr);
            await interaction.editReply({
                embeds,
                components,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            if (error?.code === 40060 || error?.code === 10062) {
                logger.warn('Help category select interaction already acknowledged or expired.', {
                    event: 'interaction.help.select.unavailable',
                    errorCode: String(error.code),
                    customId: interaction.customId,
                    interactionId: interaction.id,
                });
                return;
            }

            await handleInteractionError(interaction, error, {
                type: 'select_menu',
                customId: interaction.customId,
                handler: 'help_category',
            });
        }
    },
};