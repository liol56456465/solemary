/**
 * Command Aliases Configuration
 * Maps shortened command names to their full command names
 */

export const commandAliases = {
    'ping': 'ping',
    'help': 'help',
    'h': 'help',
    'info': 'help',

    'clear': 'purge',
    'purge': 'purge',

    'rank': 'rank',
    'lvl': 'rank',
    'xp': 'rank',
    'leaderboard': 'leaderboard',
    'lb': 'leaderboard',
    'top': 'leaderboard',


    'user': 'userinfo',
    'avatar': 'avatar',
    'pfp': 'avatar',
    'icon': 'avatar',

    'bd': 'birthday',
    'bday': 'birthday',
    'b': 'birthday',

    'fun': 'fun',
    'flip': 'fun flip',
    'coin': 'fun flip',
    'roll': 'fun roll',
    'dice': 'fun roll',
    'fight': 'fun fight',

    'giveaway': 'giveaway',
    'gw': 'giveaway',
    'gcreate': 'giveaway create',
    'gstart': 'giveaway create',
    'gend': 'giveaway end',
    'gstop': 'giveaway end',
    'greroll': 'giveaway reroll',
    'groll': 'giveaway reroll',
    'gdelete': 'giveaway delete',

    'ticket': 'ticket',
    't': 'ticket',
    'new': 'ticket',

    'ver': 'verify',
    'vadmin': 'verification',
    'av': 'verification auto',

    'welcome': 'welcome',
    'greet': 'greet',
    'goodbye': 'goodbye',
    'autorole': 'autorole',

    'tools': 'tools',
    'calc': 'tools calculate',
    'math': 'tools calculate',
    'weather': 'weather',
    'todo': 'todo',
    'report': 'report',
    'userinfo': 'userinfo',
    'whois': 'userinfo',
    'ui': 'userinfo',

    'serverstats': 'serverstats',
    'ss': 'serverstats',
    'sstats': 'serverstats',

    'rr': 'reactroles',
    'reactionroles': 'reactroles',

    'jtc': 'jointocreate',
    'jointocreate': 'jointocreate',

    'np': 'nowplaying',
    'now': 'nowplaying',
};

export const subcommandAliases = {
    'l': 'list',
    'ls': 'list',
    's': 'set',
    'i': 'info',
    'r': 'remove',
    'rm': 'remove',
    'del': 'remove',
    'n': 'next',
    'sc': 'setchannel',

    'a': 'add',
    'c': 'complete',
    'done': 'complete',
    'd': 'complete',

    'start': 'create',
    'stop': 'end',
    'roll': 'reroll',

    'add': 'add',
    'remove': 'remove',
    'list': 'list',
};

/**
 * Resolve a command alias to its full command name
 * @param {string} commandName - The command name (could be an alias)
 * @returns {string} - The full command name, or the original if not an alias
 */
export function resolveCommandAlias(commandName) {
    const normalized = commandName.toLowerCase();
    return commandAliases[normalized] || commandName;
}

/**
 * Resolves an alias that may name a subcommand of a merged command:
 * "flip" → { commandName: 'fun', subcommandArgs: ['flip'] }.
 */
export function resolveCommandAliasWithArgs(commandName) {
    const [name, ...subcommandArgs] = resolveCommandAlias(commandName).split(' ');
    return { commandName: name, subcommandArgs };
}

/**
 * Resolve a subcommand alias to its full subcommand name
 * @param {string} subcommandName - The subcommand name (could be an alias)
 * @returns {string} - The full subcommand name, or the original if not an alias
 */
export function resolveSubcommandAlias(subcommandName) {
    const normalized = subcommandName.toLowerCase();
    return subcommandAliases[normalized] || subcommandName;
}
