// deploy-commands.js — registers slash commands without starting the bot.
//
//   npm run deploy:commands        uses .env
//   npm run deploy:commands:test   uses .env.test (test mode: test guilds only, global untouched)
//
// Global commands go to the application; /enforcements and /background go to
// MAIN_GUILD_ID, /appeals and /appeals-panel to SUPPORT_GUILD_ID. Each set is
// replaced in full, so deleted commands are removed from Discord.

import '../src/config/loadEnv.js';
import '../src/config/testMode.js';
import { REST } from '@discordjs/rest';

const { loadCommands, collectCommandPayloads, registerCommandSets } = await import('../src/handlers/loaders/commandLoader.js');
const { logger } = await import('../src/utils/logger.js');

const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
    logger.error('DISCORD_TOKEN and CLIENT_ID are required to deploy commands.');
    process.exit(1);
}

try {
    const client = {};
    await loadCommands(client);
    const { sets, totalSubcommands } = collectCommandPayloads(client);
    await registerCommandSets(new REST({ version: '10' }).setToken(token), clientId, sets, totalSubcommands);
    logger.info('Command deploy finished.');
    process.exit(0);
} catch (error) {
    logger.error('Command deploy failed:', error);
    process.exit(1);
}
