/**
 * Who may run each command, used by utils/commandGate.js and /help.
 *
 * Keys are access keys: the command name, or "command subcommand" for commands
 * with subcommands (see resolveSlashAccessKey / resolvePrefixAccessKey).
 * Only exact keys count, so a new command or subcommand is admin-only until it
 * is listed here. Everything not listed requires Administrator.
 *
 * Some everyone-commands narrow access further inside the command:
 * - music controls: only members in the bot's voice channel (admins always)
 * - /claim, /priority: ticket staff; /close: ticket staff or the ticket opener
 * - /rank on another member: admins only
 */

export const EVERYONE_COMMANDS = new Set([
  // Core
  'help', 'ping', 'stats', 'uptime', 'support',

  // Community
  'apply submit', 'apply status', 'apply list',

  // Birthday (setchannel stays admin)
  'birthday set', 'birthday info', 'birthday list', 'birthday remove', 'birthday next',

  // Fun
  'fight', 'flip', 'roll', 'count status', 'count leaderboard',

  // Leveling
  'leaderboard', 'rank',

  // Music (247 stays admin)
  'play', 'join', 'queue', 'nowplaying',
  'music pause', 'music resume', 'music skip', 'music stop', 'music shuffle', 'music loop',
  'music volume', 'music seek', 'music remove', 'music move', 'music clear', 'music leave',

  // Search
  'search define', 'search google',

  // Ticket (the commands check staff / opener themselves)
  'claim', 'close', 'priority',

  // Tools (shorten stays admin: it hides link targets from automod)
  'baseconvert', 'calculate', 'generatepassword', 'hexcolor', 'time', 'unixtime',

  // Utility
  'avatar', 'firstmsg', 'serverinfo', 'userinfo', 'weather', 'report file',
  'todo add', 'todo list', 'todo complete', 'todo remove',
  'todo share create', 'todo share add', 'todo share view', 'todo share addtask', 'todo share remove',

  // Verification
  'verify',

  // Context menus
  'Report message',
]);

/** True when every member may run this access key. */
export function isEveryoneCommand(accessKey) {
  return Boolean(accessKey) && EVERYONE_COMMANDS.has(accessKey);
}

/** True when every member may run at least one part of the command (for /help). */
export function hasEveryoneAccess(commandName) {
  for (const key of EVERYONE_COMMANDS) {
    if (key === commandName || key.startsWith(`${commandName} `)) return true;
  }
  return false;
}
