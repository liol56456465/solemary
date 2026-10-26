// adminConsole.js — interactive admin console on the bot's own terminal.
//
// Starts only when the bot runs in an interactive terminal (stdin is a TTY), so it
// is reachable from the keyboard of the machine running the bot and nowhere else.
// Actions run through the same enforcement service as /enforcements, acting as
// CONSOLE_MODERATOR_ID (default: the first OWNER_IDS entry), who must be an
// Administrator in MAIN_GUILD_ID.

import readline from 'readline';
import { enforcementConfig, getReason } from '../config/enforcement.js';
import { getBotOwners } from '../config/bot.js';
import { testMode } from '../config/testMode.js';
import { executeAction, getLadder } from '../services/enforcement/enforcementService.js';
import { getCaseByCode, getCountedWarns, listCasesForUser } from '../services/enforcement/caseService.js';
import { formatDuration, parseDuration } from '../services/enforcement/format.js';

const HELP = `
Commands (user = ID or <@mention>):
  ban <user> <duration|perm> <reason…> [--unappealable]   e.g. ban 123… 7d Spam
  kick <user> <reason…>
  mute <user> <duration> <reason…>                         e.g. mute 123… 30m Spam
  warn <user> <reason…>
  unban <user> [reason…]
  unmute <user> [reason…]
  removewarn <user> [case code] [reason…]
  cases <user>          list a user's records
  case <code>           show one record
  status                bot, guilds and mode
  help                  this list
  stop                  shut the bot down
Reasons that match a prebuilt reason (spam, harassment, nsfw, advertising,
raiding, scamming, slurs, staff_disrespect) are stored as prebuilt.`;

const out = (line = '') => process.stdout.write(`${line}\n`);

function parseUserId(token) {
    const match = String(token || '').match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
    return match ? match[1] || match[2] : null;
}

function reasonFields(words) {
    const text = words.join(' ').trim();
    const prebuilt = getReason(text.toLowerCase().replace(/\s+/g, '_')) ||
        getReason(text.toLowerCase());
    if (prebuilt) {
        return { reason: prebuilt.label, reasonSource: 'prebuilt', reasonKey: prebuilt.key, severe: prebuilt.severe };
    }
    return { reason: text, reasonSource: 'custom', reasonKey: 'custom', severe: false };
}

function describeResult(result) {
    const lines = [];
    if (result.record) {
        lines.push(`  case ${result.record.case_code} · ${result.record.name}`);
        if (result.record.expires_at) lines.push(`  ends ${new Date(result.record.expires_at).toLocaleString()}`);
    }
    if (result.dmDelivered === false) lines.push('  ⚠ DM not delivered (DMs closed or no shared server)');
    if (result.dmDelivered === true) lines.push('  DM delivered');
    for (const note of result.notes || []) lines.push(`  ${note.replace(/\*\*/g, '').replace(/`/g, '')}`);
    return lines.join('\n');
}

async function resolveContext(client) {
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    if (!guild) throw new Error(`MAIN_GUILD_ID ${enforcementConfig.mainGuildId} is not available to the bot.`);

    const moderatorId = (process.env.CONSOLE_MODERATOR_ID || '').trim() || getBotOwners()[0];
    if (!moderatorId) throw new Error('Set CONSOLE_MODERATOR_ID (or OWNER_IDS) to the account the console acts as.');

    const moderator = await guild.members.fetch(moderatorId).catch(() => null);
    if (!moderator) throw new Error(`Console moderator ${moderatorId} is not a member of ${guild.name}.`);
    return { guild, moderator };
}

async function runAction(client, type, args) {
    const userId = parseUserId(args[0]);
    if (!userId) return out('  usage: see "help" — the first argument must be a user ID or mention');

    const { guild, moderator } = await resolveContext(client);
    const targetUser = await client.users.fetch(userId).catch(() => null);
    if (!targetUser) return out(`  no Discord user with ID ${userId}`);

    let rest = args.slice(1);
    const flow = { type, targetId: userId, targetUsername: targetUser.username, nameIsDefault: true };

    if (type === 'ban' || type === 'mute') {
        const raw = rest.shift();
        if (type === 'ban' && ['perm', 'permanent'].includes(String(raw).toLowerCase())) {
            flow.durationMs = null;
        } else {
            flow.durationMs = parseDuration(raw);
            if (flow.durationMs == null) return out(`  "${raw ?? ''}" is not a duration (30m, 24h, 7d, 1mo${type === 'ban' ? ' or perm' : ''})`);
        }
    }

    if (type === 'ban') {
        flow.unappealable = rest.includes('--unappealable');
        rest = rest.filter((word) => word !== '--unappealable');
    }

    if (type === 'removewarn') {
        const ladder = await getLadder(guild.id, userId);
        const warns = await getCountedWarns(guild.id, userId, ladder.level);
        if (warns.length === 0) return out('  this user has no counted warnings');
        const code = rest[0] && warns.find((warn) => warn.case_code === rest[0].toLowerCase()) ? rest.shift().toLowerCase() : warns[0].case_code;
        flow.warnCode = code;
    }

    if (['ban', 'kick', 'mute', 'warn'].includes(type)) {
        if (rest.length === 0) return out('  a reason is required');
        Object.assign(flow, reasonFields(rest));
        if (type === 'ban' && !rest.includes('--unappealable') && flow.severe) {
            out('  note: severe reason — ban is appealable unless you add --unappealable');
        }
    } else {
        flow.reason = rest.join(' ').trim() || `${type} via admin console`;
    }

    out(`  → ${type} ${targetUser.username} as ${moderator.user.username}…`);
    const result = await executeAction({ guild, moderator, targetUser, flow });
    out(`  ✓ ${type} done\n${describeResult(result)}`);
}

async function showCases(client, args) {
    const userId = parseUserId(args[0]);
    if (!userId) return out('  usage: cases <user>');
    const { rows, total } = await listCasesForUser(enforcementConfig.mainGuildId, userId, { limit: 15 });
    const ladder = await getLadder(enforcementConfig.mainGuildId, userId);
    out(`  ${total} record(s) · ladder level ${ladder.level} · counted warns ${ladder.warns_since_level}`);
    for (const row of rows) {
        const duration = row.type === 'ban' || row.type === 'mute'
            ? ` · ${row.expires_at ? formatDuration(Number(row.duration_ms)) : 'permanent'}` : '';
        out(`  ${row.case_code.padEnd(7)} ${row.type.padEnd(4)} ${row.status.padEnd(14)} ${new Date(row.created_at).toLocaleString()}${duration} · ${row.reason}${row.is_imported ? ' (imported)' : ''}`);
    }
}

async function showCase(args) {
    const row = await getCaseByCode(String(args[0] || '').toLowerCase());
    if (!row) return out('  no case with that code');
    for (const [key, value] of Object.entries(row)) {
        if (value !== null && value !== '' && key !== 'id') out(`  ${key.padEnd(20)} ${value instanceof Date ? value.toLocaleString() : value}`);
    }
}

function showStatus(client) {
    out(`  ${client.user?.tag ?? 'not logged in'} · ${testMode.enabled ? 'TEST MODE' : 'normal mode'} · ping ${client.ws.ping}ms`);
    for (const guild of client.guilds.cache.values()) {
        const role = guild.id === enforcementConfig.mainGuildId ? 'main' : guild.id === enforcementConfig.supportGuildId ? 'support' : '';
        out(`  guild ${guild.id} ${guild.name}${role ? ` (${role})` : ''} · ${guild.memberCount} members`);
    }
}

export function startAdminConsole(client) {
    if (!process.stdin.isTTY || process.env.ADMIN_CONSOLE === 'false') {
        return;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'meowist> ' });
    out(`\nAdmin console ready — type "help" for commands.${testMode.enabled ? ' (test mode: test servers only)' : ''}`);
    rl.prompt();

    rl.on('line', async (line) => {
        const [command, ...args] = line.trim().split(/\s+/);
        try {
            switch ((command || '').toLowerCase()) {
                case '': break;
                case 'help': out(HELP); break;
                case 'status': showStatus(client); break;
                case 'cases': await showCases(client, args); break;
                case 'case': await showCase(args); break;
                case 'ban': case 'kick': case 'mute': case 'warn':
                case 'unban': case 'unmute': case 'removewarn':
                    await runAction(client, command.toLowerCase(), args);
                    break;
                case 'stop': case 'exit': case 'quit':
                    rl.close();
                    process.kill(process.pid, 'SIGINT');
                    return;
                default: out(`  unknown command "${command}" — type "help"`);
            }
        } catch (error) {
            out(`  ✗ ${(error.userMessage || error.message || String(error)).replace(/\*\*/g, '')}`);
        }
        rl.prompt();
    });
}
