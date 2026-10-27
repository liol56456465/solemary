/**
 * Who may run each command, used by utils/commandGate.js and /help.
 *
 * Keys are access keys: the command name, or "command subcommand" for commands
 * with subcommands (see resolveSlashAccessKey / resolvePrefixAccessKey).
 * Only exact keys count, so a new command or subcommand is admin-only until it
 * is listed here. Everything not listed requires Administrator.
 *
 * Some everyone-commands narrow access further inside the command:
 * - /claim, /priority, /modmail close: ticket staff; /close: ticket staff or the ticket opener
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
  'fun fight', 'fun flip', 'fun roll', 'count status', 'count leaderboard',

  // Leveling
  'leaderboard', 'rank',


  // Search
  'search define', 'search google',

  // Ticket (the commands check staff / opener themselves)
  'claim', 'close', 'priority', 'modmail close',

  // Tools (randomuser and shorten stay admin: shorten hides link targets from automod)
  'tools baseconvert', 'tools calculate', 'tools generatepassword', 'tools hexcolor', 'tools time', 'tools unixtime',

  // Utility
  'avatar', 'firstmsg', 'serverinfo', 'userinfo', 'weather', 'report file',
  'todo add', 'todo list', 'todo complete', 'todo remove',
  'todo share create', 'todo share add', 'todo share view', 'todo share addtask', 'todo share remove',

  // Verification
  'verify',

  // Context menus
  'Report message',
]);

/**
 * Commands registered in the support server (everything else exists only in the
 * main server). The appeal panels there are buttons and need no command.
 */
export const SUPPORT_SERVER_COMMANDS = new Set([
  'help', 'ping', 'uptime',
  'ticket', 'claim', 'close', 'priority',
  'purge', 'lock', 'unlock',
  'userinfo', 'serverinfo', 'avatar',
  'logging', 'welcome', 'goodbye', 'autorole', 'reactroles',
]);

export function isSupportServerCommand(commandName) {
  return SUPPORT_SERVER_COMMANDS.has(commandName);
}

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
