import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ApplicationIntegrationType, Collection, InteractionContextType, Routes } from 'discord.js';
import { logger } from '../../utils/logger.js';
import botConfig from '../../config/bot.js';
import { enforcementConfig } from '../../config/enforcement.js';

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
 * Splits loaded commands into the global set and per-scope guild sets.
 * Commands stay visible to everyone (default_member_permissions = null); access
 * is enforced at dispatch by utils/commandGate.js. contexts = [Guild] keeps them
 * out of DMs.
 */
function collectCommandPayloads(client) {
    const sets = { global: [], main: [], support: [] };
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

        const scope = command.scope || 'global';
        if (!sets[scope]) {
            logger.warn(`Command ${commandName} has unknown scope "${scope}"; registering it globally`);
            sets.global.push(commandJson);
        } else {
            sets[scope].push(commandJson);
        }
        totalSubcommands += getSubcommandInfo(commandJson).length;

        if (process.env.NODE_ENV !== 'production') {
            logger.debug(`Registering command: ${commandName} (${scope})`);
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

function prepareCommandsForRegistration(commands) {
    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(`Command count (${commands.length}) is near Discord's ${MAX_COMMANDS} global command limit`);
    }

    if (commands.length <= MAX_COMMANDS) {
        return commands;
    }

    logger.warn(`Command count (${commands.length}) exceeds Discord limit (${MAX_COMMANDS}), truncating...`);
    const truncated = commands.slice(0, MAX_COMMANDS);
    logger.info(`Truncated to ${truncated.length} commands for registration`);
    return truncated;
}

async function putCommands(rest, route, commands, label) {
    logger.info(`Registering ${commands.length} ${label} commands...`);
    await rest.put(route, { body: commands });
    logger.info(`Successfully registered ${commands.length} ${label} commands`);
}

/**
 * Registers the global set and the main/support guild sets. Each PUT replaces the
 * whole set, so commands deleted from the codebase disappear from Discord.
 */
export async function registerCommandSets(rest, clientId, sets, totalSubcommands = 0) {
    if (!clientId) {
        throw new Error('CLIENT_ID is required for slash command registration');
    }
    if (!rest) {
        throw new Error('Discord REST client is not available for slash command registration');
    }

    const all = [...sets.global, ...sets.main, ...sets.support];
    logger.info(`Preparing to register ${totalSubcommands + all.length} commands (${sets.global.length} global, ${sets.main.length} main, ${sets.support.length} support)`);
    logger.info('Validating commands before registration...');
    validateCommands(all);
    logger.info('Command validation passed');

    const globalCommands = prepareCommandsForRegistration(sets.global);

    if (botConfig.commands?.deleteCommands) {
        logger.info('Clearing existing global commands before registration...');
        await rest.put(Routes.applicationCommands(clientId), { body: [] });
    }

    await putCommands(rest, Routes.applicationCommands(clientId), globalCommands, 'global');
    logger.info('Global commands may take up to an hour to appear in all servers on first deploy');

    for (const [scope, guildId] of [['main', enforcementConfig.mainGuildId], ['support', enforcementConfig.supportGuildId]]) {
        if (!guildId) {
            logger.warn(`${scope === 'main' ? 'MAIN_GUILD_ID' : 'SUPPORT_GUILD_ID'} is not set; skipping its ${sets[scope].length} guild command(s)`);
            continue;
        }
        try {
            await putCommands(rest, Routes.applicationGuildCommands(clientId, guildId), sets[scope], `${scope}-guild`);
        } catch (error) {
            // 50001 Missing Access: the bot is not in that guild (or lacks applications.commands).
            logger.error(`Could not register ${scope}-guild commands in ${guildId}: ${error.message}`);
        }
    }
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
        
        client.commands.set(commandName, newCommand);
        
        logger.info(`Reloaded command: ${commandName}`);
        return { success: true, message: `Successfully reloaded command "${commandName}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}