import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ApplicationIntegrationType, Collection, InteractionContextType, Routes } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { testMode } from '../../config/testMode.js';
import { adminCommandsRetired, retireCommandJson } from '../../config/commands/retirement.js';
import { ownerToolsGuildId, ownerToolsProblem } from '../../config/ownerTools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS = 100;
const COMMAND_COUNT_WARN_THRESHOLD = 90;

function getSubcommandInfo(commandData) {
    const subcommands = [];
    
    if (commandData.options) {
        for (const option of commandData.options) {
if (option.type === 1) {
                subcommands.push(option.name);
} else if (option.type === 2) {
                if (option.options) {
                    for (const subOption of option.options) {
if (subOption.type === 1) {
                            subcommands.push(`${option.name}/${subOption.name}`);
                        }
                    }
                }
            }
        }
    }
    
    return subcommands;
}

async function getAllFiles(directory, fileList = []) {
    const files = await fs.readdir(directory, { withFileTypes: true });
    
    for (const file of files) {
        const filePath = path.join(directory, file.name);
        
        if (file.isDirectory()) {
            if (file.name === 'modules') {
                continue;
            }
            await getAllFiles(filePath, fileList);
        } else if (file.name.endsWith('.js')) {
            fileList.push(filePath);
        }
    }
    
    return fileList;
}

export async function loadCommands(client) {
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, '../../commands');
    const commandFiles = await getAllFiles(commandsPath);
    
    logger.info(`Found ${commandFiles.length} command files to load`);
    
    const uniqueCommandNames = new Set();
    
    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            
            const commandName = path.basename(filePath, '.js');
            const commandDir = path.dirname(filePath);
            const category = path.basename(commandDir);
            
            const commandModule = await import(`file://${filePath}`);
            const command = commandModule.default || commandModule;
            
            if (!command.data || !command.execute) {
                logger.warn(`Command at ${filePath} is missing required "data" or "execute" property.`);
                continue;
            }
            
            command.category = category;
            command.filePath = normalizedPath;
            
            const primaryCommandName = command.data.name;
            
            if (!uniqueCommandNames.has(primaryCommandName)) {
                uniqueCommandNames.add(primaryCommandName);
                
                client.commands.set(primaryCommandName, command);
            }
            
            const subcommands = getSubcommandInfo(command.data.toJSON());
            
            logger.info(`Loaded command: ${primaryCommandName} from ${normalizedPath} (category: ${category})`);
            
            if (subcommands.length > 0) {
                logger.info(`  - Subcommands: ${subcommands.join(', ')}`);
            }
            
        } catch (error) {
            logger.error(`Error loading command from ${filePath}:`, error);
        }
    }
    
    const commandsWithSubcommands = Array.from(client.commands.values()).filter(cmd => {
        const subcommands = getSubcommandInfo(cmd.data.toJSON());
        return subcommands.length > 0;
    });
    
    const totalSubcommands = commandsWithSubcommands.reduce((total, cmd) => {
        return total + getSubcommandInfo(cmd.data.toJSON()).length;
    }, 0);
    
    const uniqueCommands = new Set();
    for (const [name, command] of client.commands.entries()) {
        if (command.data && command.data.name) {
            uniqueCommands.add(command.data.name);
        }
    }
    
    logger.info(`Loaded ${uniqueCommands.size} commands`);
    return client.commands;
}

/**
 * Splits loaded commands into the global set and the owner-tools set.
 * Every command except the owner tools is global (public bot, multi-server B2): the old
 * scopes 'main' / 'support' no longer limit where a command is registered or runs.
 * Commands stay visible to everyone (default_member_permissions = null); access
 * is enforced at dispatch by utils/commandGate.js. contexts = [Guild] keeps them
 * out of DMs.
 */
function collectCommandPayloads(client) {
    // owner: registered in OWNER_TOOLS_GUILD_ID only (config/ownerTools.js), never globally,
    // in the main server or in the support server.
    const sets = { global: [], owner: [] };
    let totalSubcommands = 0;
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (!command.data || typeof command.data.toJSON !== 'function') {
            logger.warn(`Command missing data or toJSON method: ${command}`);
            continue;
        }

        const commandName = command.data.name;
        logger.debug(`Processing command for registration: ${commandName}`);

        if (registeredNames.has(commandName)) {
            logger.debug(`Skipping duplicate command: ${commandName}`);
            continue;
        }

        registeredNames.add(commandName);
        const commandJson = {
            ...command.data.toJSON(),
            default_member_permissions: null,
            contexts: [InteractionContextType.Guild],
            integration_types: [ApplicationIntegrationType.GuildInstall],
        };
        delete commandJson.dm_permission;

        if (command.scope === 'owner') sets.owner.push(commandJson);
        else sets.global.push(commandJson);
        totalSubcommands += getSubcommandInfo(commandJson).length;

        if (process.env.NODE_ENV !== 'production') {
            logger.debug(`Registering command: ${commandName} (${command.scope === 'owner' ? 'owner' : 'global'})`);
        }
    }

    return { sets, totalSubcommands };
}

function validateCommands(commands) {
    const validationErrors = [];

    for (const cmd of commands) {
        if (cmd.name && cmd.name.length > 32) {
            validationErrors.push(`Command ${cmd.name} has name longer than 32 chars: "${cmd.name}" (${cmd.name.length} chars)`);
        }
        if (cmd.description && cmd.description.length > 110) {
            validationErrors.push(`Command ${cmd.name} has description longer than 110 chars: "${cmd.description}" (${cmd.description.length} chars)`);
        }

        if (!cmd.options) {
            continue;
        }

        for (const option of cmd.options) {
            if (option.name && option.name.length > 32) {
                validationErrors.push(`Command ${cmd.name} option ${option.name} has name longer than 32 chars: "${option.name}" (${option.name.length} chars)`);
            }
            if (option.description && option.description.length > 110) {
                validationErrors.push(`Command ${cmd.name} option ${option.name} has description longer than 110 chars: "${option.description}" (${option.description.length} chars)`);
            }

            if (option.choices) {
                for (const choice of option.choices) {
                    if (choice.name && choice.name.length > 110) {
                        validationErrors.push(`Command ${cmd.name} option ${option.name} choice ${choice.name} has name longer than 110 chars: "${choice.name}" (${choice.name.length} chars)`);
                    }
                    if (choice.value && choice.value.length > 100) {
                        validationErrors.push(`Command ${cmd.name} option ${option.name} choice ${choice.name} has value longer than 100 chars: "${choice.value}" (${choice.value.length} chars)`);
                    }
                }
            }

            if (!option.options) {
                continue;
            }

            for (const subOption of option.options) {
                if (subOption.name && subOption.name.length > 32) {
                    validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} has name longer than 32 chars: "${subOption.name}" (${subOption.name.length} chars)`);
                }
                if (subOption.description && subOption.description.length > 110) {
                    validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} has description longer than 110 chars: "${subOption.description}" (${subOption.description.length} chars)`);
                }

                if (!subOption.choices) {
                    continue;
                }

                for (const choice of subOption.choices) {
                    if (choice.name && choice.name.length > 110) {
                        validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} choice ${choice.name} has name longer than 110 chars: "${choice.name}" (${choice.name.length} chars)`);
                    }
                    if (choice.value && choice.value.length > 100) {
                        validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} choice ${choice.name} has value longer than 100 chars: "${choice.value}" (${choice.value.length} chars)`);
                    }
                }
            }
        }
    }

    if (validationErrors.length > 0) {
        logger.error('Command validation failed. Errors:');
        validationErrors.forEach((error) => logger.error(`  - ${error}`));
        throw new Error(`Command validation failed with ${validationErrors.length} errors`);
    }
}

/** Throws when a list is over Discord's limit: nothing is registered then (a truncated PUT would delete commands). */
function checkCommandCount(commands, label, { quiet = false } = {}) {
    if (commands.length > MAX_COMMANDS) {
        throw new Error(`The ${label} list has ${commands.length} commands, over Discord's limit of ${MAX_COMMANDS}; nothing was registered`);
    }
    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD && !quiet) {
        logger.warn(`Command count (${commands.length}) is near Discord's ${MAX_COMMANDS}-command limit (${label})`);
    }
    return commands;
}

async function putCommands(rest, route, commands, label) {
    logger.info(`Registering ${commands.length} ${label} commands...`);
    await rest.put(route, { body: commands });
    logger.info(`Successfully registered ${commands.length} ${label} commands`);
}

/**
 * The command lists startup registers, without registering anything: RETIRE_ADMIN_COMMANDS
 * applied, validated (throws when invalid or over 100). { globalCommands, ownerCommands }.
 *   globalCommands  every command but the owner tools, registered globally (all servers)
 *   ownerCommands   the owner tools (/database), only for OWNER_TOOLS_GUILD_ID, never global;
 *                   not affected by RETIRE_ADMIN_COMMANDS
 * `sets` may still carry the old main / support lists (scripts, tests); they are global too.
 * `quiet` skips the info lines (the dashboard's read-only comparison calls this per page view).
 */
export function buildRegistrationBodies(sets, totalSubcommands = 0, { quiet = false } = {}) {
    const info = quiet ? () => {} : (message) => logger.info(message);
    const ownerCommands = [...(sets.owner || [])];
    let globalCommands = [...(sets.global || []), ...(sets.main || []), ...(sets.support || [])];
    // Admin commands retired (RETIRE_ADMIN_COMMANDS): only everyone-commands and the owner kit.
    if (adminCommandsRetired()) {
        const before = globalCommands.length;
        globalCommands = globalCommands.map(retireCommandJson).filter(Boolean);
        info(`Admin commands retired: registering ${globalCommands.length} of ${before} top-level commands (everyone + owner kit); the rest is on the dashboard`);
    }
    info(`Preparing to register ${totalSubcommands + globalCommands.length} commands (${globalCommands.length} top-level) globally`);
    info('Validating commands before registration...');
    validateCommands(globalCommands);
    validateCommands(ownerCommands);
    info('Command validation passed');
    checkCommandCount(globalCommands, 'global', { quiet });
    checkCommandCount(ownerCommands, 'owner-tools', { quiet: true });
    return { globalCommands, ownerCommands };
}

// ── The switch from main-server guild commands to global commands ─────────
//
// Until multi-server B2 the full list was a guild command list in the main server (and a part
// of it in the support server). Guild lists change at once; a new global list can take up to an
// hour to reach every Discord client. So the home servers keep a guild copy of the list until
// the global list is an hour old, and only then is their guild list emptied: never without
// commands, at worst an hour of duplicates (both copies run the same code). The age comes from
// Discord itself: a global command keeps its id across bulk overwrites, and the id is a
// snowflake with its creation time in it.
export const GLOBAL_SETTLE_MS = 60 * 60 * 1000;
const DISCORD_EPOCH = 1420070400000n;

/** Creation time (ms) of a Discord snowflake id, or null. */
export function snowflakeTime(id) {
    if (!/^\d{17,20}$/.test(String(id || ''))) return null;
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/**
 * Milliseconds until the global list counts as settled (0 = settled), from the global commands
 * Discord had BEFORE this registration: settled once the oldest of them is GLOBAL_SETTLE_MS old.
 * An empty or unreadable list (null) is the first switch: GLOBAL_SETTLE_MS.
 */
export function globalSettleRemainingMs(existing, now = Date.now()) {
    const times = (Array.isArray(existing) ? existing : []).map((c) => snowflakeTime(c?.id)).filter((t) => t !== null);
    if (!times.length) return GLOBAL_SETTLE_MS;
    return Math.max(0, Math.min(...times) + GLOBAL_SETTLE_MS - now);
}

/** Mewvo's own servers, which had guild command lists before B2: main and support. */
function homeGuildIds() {
    return [...new Set([enforcementConfig.mainGuildId, enforcementConfig.supportGuildId].filter(Boolean).map(String))];
}

async function putHomeGuildLists(rest, clientId, commands, label) {
    for (const guildId of homeGuildIds()) {
        try {
            await putCommands(rest, Routes.applicationGuildCommands(clientId, guildId), commands, `${label} ${guildId}`);
        } catch (error) {
            // 50001 Missing Access: the bot is not in that guild (or lacks applications.commands).
            logger.error(`Could not set the guild command list of ${guildId}: ${error.message}`);
        }
    }
}

const defaultSchedule = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
};

/**
 * Registers every list. Outside test mode:
 *   1. the global list (one PUT, at most 100), every server;
 *   2. the home servers' guild lists: emptied once the global list is an hour old, until then a
 *      copy of the global list (see "The switch" above), emptied by a timer when the hour is up;
 *   3. the owner tools in OWNER_TOOLS_GUILD_ID (guild command, never global).
 * Test mode never touches global commands: every test guild gets the global list as guild
 * commands (plus the owner tools in OWNER_TOOLS_GUILD_ID when it is a test guild).
 * Each PUT replaces the whole list, so commands deleted from the codebase disappear too.
 * Returns { scope: 'global' | 'test', count } (count = global list length).
 * `now` and `schedule` are for tests.
 */
export async function registerCommandSets(rest, clientId, sets, totalSubcommands = 0, { now = Date.now(), schedule = defaultSchedule } = {}) {
    if (!clientId) {
        throw new Error('CLIENT_ID is required for slash command registration');
    }
    if (!rest) {
        throw new Error('Discord REST client is not available for slash command registration');
    }

    const { globalCommands, ownerCommands } = buildRegistrationBodies(sets, totalSubcommands);
    const ownerGuildId = ownerToolsGuildId();
    if (!ownerGuildId) logger.warn(ownerToolsProblem());

    if (testMode.enabled) {
        // A test guild's guild list holds what production splits into global + owner tools.
        const ownerTestBody = checkCommandCount([...globalCommands, ...ownerCommands], 'owner-tools test guild', { quiet: true });
        const failed = [];
        for (const guildId of testMode.guildIds) {
            const body = guildId === ownerGuildId ? ownerTestBody : globalCommands;
            try {
                await putCommands(rest, Routes.applicationGuildCommands(clientId, guildId), body, `test-guild ${guildId}`);
            } catch (error) {
                failed.push(guildId);
                logger.error(`Could not register test commands in ${guildId}: ${error.message}`);
            }
        }
        logger.info('Test mode: global commands were not changed');
        // Never report success when nothing was registered (dashboard re-register shows this).
        if (testMode.guildIds.size && failed.length === testMode.guildIds.size) {
            throw new Error(`Test mode: the commands could not be registered in any test guild (${failed.join(', ')})`);
        }
        return { scope: 'test', count: globalCommands.length };
    }

    // What Discord has globally before this PUT decides whether the home guild copies can go.
    let existing = null;
    try {
        existing = typeof rest.get === 'function' ? await rest.get(Routes.applicationCommands(clientId)) : null;
    } catch (error) {
        logger.warn(`Could not read the current global commands (${error.message}); the home servers keep a guild copy for now`);
    }
    const remainingMs = globalSettleRemainingMs(existing, now);

    await putCommands(rest, Routes.applicationCommands(clientId), globalCommands, 'global');

    if (remainingMs === 0) {
        await putHomeGuildLists(rest, clientId, [], 'home-guild (emptied, global list settled)');
    } else {
        await putHomeGuildLists(rest, clientId, globalCommands, 'home-guild (copy until the global list settles)');
        const minutes = Math.ceil(remainingMs / 60000);
        logger.info(`Global commands can take up to an hour to show in every client; the home servers keep a guild copy for ${minutes} more minute(s), then it is emptied`);
        schedule(() => {
            putHomeGuildLists(rest, clientId, [], 'home-guild (emptied, global list settled)')
                .catch((error) => logger.error(`Could not empty the home guild command lists: ${error.message}`));
        }, remainingMs);
    }

    if (ownerGuildId) {
        try {
            await putCommands(rest, Routes.applicationGuildCommands(clientId, ownerGuildId), ownerCommands, 'owner-tools-guild');
        } catch (error) {
            logger.error(`Could not register owner-tools commands in ${ownerGuildId}: ${error.message}`);
        }
    }
    return { scope: 'global', count: globalCommands.length };
}

export async function registerCommands(client, options = {}) {
    const { clientId = null } = options;

    try {
        const { sets, totalSubcommands } = collectCommandPayloads(client);
        await registerCommandSets(client.rest, clientId, sets, totalSubcommands);
    } catch (error) {
        logger.error('Error registering commands:', error);
        throw error;
    }
}

/** The global list startup would register now (same collect + build steps), without registering. */
export function expectedGlobalCommands(client) {
    const { sets, totalSubcommands } = collectCommandPayloads(client);
    return buildRegistrationBodies(sets, totalSubcommands, { quiet: true }).globalCommands;
}

/**
 * Re-registers the commands from the dashboard (Owner → Command sync): exactly what startup
 * does (registerCommandSets: global list, home guild copies, owner tools; test mode: test
 * guilds only). Returns { scope, count }.
 */
export async function registerAllCommands(client, { clientId = client?.config?.bot?.clientId || process.env.CLIENT_ID, ...options } = {}) {
    if (!clientId) throw new Error('CLIENT_ID is required for slash command registration');
    if (!client?.rest) throw new Error('Discord REST client is not available for slash command registration');
    const { sets, totalSubcommands } = collectCommandPayloads(client);
    return registerCommandSets(client.rest, clientId, sets, totalSubcommands, options);
}

export { collectCommandPayloads };

export async function reloadCommand(client, commandName) {
    const command = client.commands.get(commandName);
    
    if (!command) {
        return { success: false, message: `Command "${commandName}" not found` };
    }
    
    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);
        moduleUrl.searchParams.set('t', Date.now().toString());

        const newCommand = (await import(moduleUrl.href)).default;
        // Keep what the loader added, or the next reload has no filePath.
        newCommand.category = command.category;
        newCommand.filePath = command.filePath;

        client.commands.set(commandName, newCommand);
        
        logger.info(`Reloaded command: ${commandName}`);
        return { success: true, message: `Successfully reloaded command "${commandName}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}