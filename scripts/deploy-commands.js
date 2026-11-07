// deploy-commands.js — registers slash commands without starting the bot.
//
//   npm run deploy:commands        uses .env
//   npm run deploy:commands:test   uses ~/.config/mewvo/env.test (test mode: test guilds only, global untouched)
//
// The same lists startup registers (commandLoader.js registerCommandSets): every command
// globally, /database in OWNER_TOOLS_GUILD_ID only, the home servers' old guild lists emptied
// once the global list is an hour old. Each set is replaced in full, so deleted commands are
// removed from Discord.

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
    // The timer that empties the home servers' guild copies (first hour after the switch) does not
    // survive this exit; the next bot start or deploy after the hour empties them.
    logger.info('Command deploy finished. If the home servers got a guild copy (global list under an hour old), the next start or deploy after the hour removes it.');
    process.exit(0);
} catch (error) {
    logger.error('Command deploy failed:', error);
    process.exit(1);
}
