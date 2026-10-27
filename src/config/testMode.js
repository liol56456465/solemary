// testMode.js — isolates a test run (NODE_ENV=test, normally via .env.test).
//
// Test mode may use the production bot token, so it must never reach the real
// servers:
//   - only guilds in TEST_GUILD_IDS exist for the bot (see installGuildAllowlist)
//   - commands are registered as guild commands there; global commands are untouched
//   - cron jobs are off unless TEST_ENABLE_CRON=true
//   - the database must be local
//   - presence shows "🛠 Maintenance"
// Any violation stops the process before it logs in.

import { logger } from '../utils/logger.js';

const SNOWFLAKE = /^\d{17,20}$/;

// The real Meowist servers. Test mode refuses to start if any of these appears in
// TEST_GUILD_IDS, MAIN_GUILD_ID or SUPPORT_GUILD_ID, whatever else is configured.
export const PRODUCTION_GUILD_IDS = new Map([
    ['1527697154926182492', 'Meowist (main)'],
    ['1564312871976829009', 'Meowist Support'],
]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const usedEnvFile = process.execArgv.find((arg) => arg.startsWith('--env-file')) || '';

export const testMode = {
    enabled: process.env.NODE_ENV === 'test',
    guildIds: new Set((process.env.TEST_GUILD_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)),
    cronEnabled: process.env.TEST_ENABLE_CRON === 'true',
    presence: {
        status: 'online',
        activities: [{ name: 'Custom Status', state: '🛠 Maintenance', type: 4 }],
    },
};

const DISCORD_EPOCH = 1420070400000n;
function snowflakeTime(id) {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

// Settings that must live inside a specific test guild.
const GUILD_RESOURCES = [
    { name: 'MAIN_APPEALS_CATEGORY_ID', guild: 'MAIN_GUILD_ID', kind: 'category' },
    { name: 'ADMIN_REQUEST_CHANNEL_ID', guild: 'MAIN_GUILD_ID', kind: 'channel' },
    { name: 'MUTED_ROLE_ID', guild: 'MAIN_GUILD_ID', kind: 'role' },
    { name: 'BANNED_ROLE_ID', guild: 'SUPPORT_GUILD_ID', kind: 'role' },
    { name: 'MOD_LOG_CHANNEL_ID', guild: 'MAIN_GUILD_ID', kind: 'channel' },
];

export function isGuildAllowed(guildId) {
    return !testMode.enabled || (Boolean(guildId) && testMode.guildIds.has(String(guildId)));
}

function databaseHosts() {
    const hosts = [];
    for (const name of ['POSTGRES_URL', 'DATABASE_URL']) {
        const raw = (process.env[name] || '').trim();
        if (!raw) continue;
        try {
            hosts.push({ source: name, host: new URL(raw).hostname, database: new URL(raw).pathname.replace(/^\//, '') });
        } catch {
            hosts.push({ source: name, host: '(unparseable URL)', database: '' });
        }
    }
    if (hosts.length === 0) {
        hosts.push({ source: 'POSTGRES_HOST', host: process.env.POSTGRES_HOST || 'localhost', database: process.env.POSTGRES_DB || 'titanbot' });
    }
    return hosts;
}

export function validateTestMode() {
    const errors = [];

    if (!testMode.enabled) {
        if (usedEnvFile.includes('.env.test')) {
            errors.push('Started with .env.test but NODE_ENV is not "test". Set NODE_ENV=test in .env.test.');
        }
        return errors;
    }

    if (testMode.guildIds.size === 0) {
        errors.push('TEST_GUILD_IDS is empty. Set it to "<test main guild id>,<test support guild id>".');
    }
    for (const id of testMode.guildIds) {
        if (!SNOWFLAKE.test(id)) errors.push(`TEST_GUILD_IDS contains "${id}", which is not a Discord ID.`);
    }

    for (const id of testMode.guildIds) {
        if (PRODUCTION_GUILD_IDS.has(id)) {
            errors.push(`TEST_GUILD_IDS contains the real ${PRODUCTION_GUILD_IDS.get(id)} server (${id}). Use your test servers.`);
        }
    }

    for (const name of ['MAIN_GUILD_ID', 'SUPPORT_GUILD_ID']) {
        const value = (process.env[name] || '').trim();
        if (PRODUCTION_GUILD_IDS.has(value)) {
            errors.push(`${name} is the real ${PRODUCTION_GUILD_IDS.get(value)} server (${value}). Use your test server.`);
        } else if (value && !testMode.guildIds.has(value)) {
            errors.push(`${name} is not in TEST_GUILD_IDS — it would point the panel at a non-test server.`);
        }
    }

    // A channel/role is always newer than its guild; an older ID belongs to another server.
    for (const { name, guild } of GUILD_RESOURCES) {
        const value = (process.env[name] || '').trim();
        const guildId = (process.env[guild] || '').trim();
        if (SNOWFLAKE.test(value) && SNOWFLAKE.test(guildId) && snowflakeTime(value) < snowflakeTime(guildId)) {
            errors.push(`${name} (${value}) is older than ${guild}, so it belongs to a different server.`);
        }
    }

    for (const { source, host } of databaseHosts()) {
        if (!LOCAL_HOSTS.has(host)) {
            errors.push(`${source} host is "${host}". Test mode only allows a local Postgres (localhost / 127.0.0.1).`);
        }
    }

    return errors;
}

/** Effective configuration, safe to print: no token, no DB password. */
export function describeTestMode() {
    const token = process.env.DISCORD_TOKEN || process.env.TOKEN || '';
    return {
        mode: testMode.enabled ? 'TEST' : 'normal',
        token: token ? `set (${token.length} chars, redacted)` : 'NOT SET',
        clientId: process.env.CLIENT_ID || 'NOT SET',
        guildAllowlist: [...testMode.guildIds],
        mainGuildId: process.env.MAIN_GUILD_ID || 'NOT SET',
        supportGuildId: process.env.SUPPORT_GUILD_ID || 'NOT SET',
        database: databaseHosts().map(({ source, host, database }) => `${source}: ${host}/${database}`),
        cron: testMode.enabled ? (testMode.cronEnabled ? 'ON (allowlisted guilds only)' : 'OFF') : 'ON',
        commandScope: testMode.enabled
            ? `guild commands in ${[...testMode.guildIds].join(', ') || '(none)'}; global commands untouched`
            : 'global + MAIN_GUILD_ID + SUPPORT_GUILD_ID',
        presence: testMode.enabled ? '🛠 Maintenance' : 'from config',
    };
}

// Gateway events that carry no guild but are safe (and needed) in test mode.
const GUILDLESS_ALLOWED = new Set(['READY', 'RESUMED', 'USER_UPDATE']);
const GUILD_OBJECT_EVENTS = new Set(['GUILD_CREATE', 'GUILD_UPDATE', 'GUILD_DELETE']);

function packetGuildId(packet) {
    if (GUILD_OBJECT_EVENTS.has(packet.t)) return packet.d?.id ?? null;
    return packet.d?.guild_id ?? null;
}

/**
 * Drops every gateway packet from guilds outside TEST_GUILD_IDS (and all DMs)
 * before discord.js handles it, so other guilds never enter the cache, fire
 * events or get replies. guilds.fetch() is fenced the same way.
 */
export function installGuildAllowlist(client) {
    if (!testMode.enabled) return;

    const ws = client.ws;
    const originalHandlePacket = ws.handlePacket.bind(ws);
    ws.handlePacket = (packet, shard) => {
        if (!packet) return originalHandlePacket(packet, shard);

        if (packet.t === 'READY') {
            const guilds = (packet.d?.guilds || []).filter((guild) => testMode.guildIds.has(guild.id));
            return originalHandlePacket({ ...packet, d: { ...packet.d, guilds } }, shard);
        }

        const guildId = packetGuildId(packet);
        const allowed = guildId ? testMode.guildIds.has(guildId) : GUILDLESS_ALLOWED.has(packet.t);
        if (!allowed) {
            logger.debug(`[test mode] ignored ${packet.t} from ${guildId ? `guild ${guildId}` : 'a DM / no guild'}`);
            return true;
        }
        return originalHandlePacket(packet, shard);
    };

    const originalFetch = client.guilds.fetch.bind(client.guilds);
    client.guilds.fetch = (options) => {
        const id = typeof options === 'string' ? options : options?.guild?.id ?? options?.guild ?? null;
        if (id && !testMode.guildIds.has(String(id))) {
            logger.debug(`[test mode] refused guilds.fetch(${id})`);
            return Promise.reject(new Error(`Guild ${id} is outside TEST_GUILD_IDS`));
        }
        return originalFetch(options);
    };
}

/**
 * After login: confirms the configured category, channel, role and support invite
 * really belong to the test guilds. Returns a list of problems (empty = OK).
 */
export async function verifyTestResources(client) {
    if (!testMode.enabled) return [];
    const problems = [];

    for (const { name, guild: guildVar, kind } of GUILD_RESOURCES) {
        const id = (process.env[name] || '').trim();
        if (!id) continue;
        const guild = client.guilds.cache.get((process.env[guildVar] || '').trim());
        if (!guild) {
            problems.push(`${guildVar} is not available to the bot (is the bot in that test server?)`);
            continue;
        }
        const found = kind === 'role'
            ? await guild.roles.fetch(id).catch(() => null)
            : await guild.channels.fetch(id).catch(() => null);
        if (!found) {
            problems.push(`${name} (${id}) is not a ${kind} in ${guildVar} (${guild.name})`);
        } else if (kind === 'category' && found.type !== 4) {
            problems.push(`${name} (${id}) is the channel #${found.name}, not a category. Right-click the category header → Copy Channel ID.`);
        }
    }

    const invite = (process.env.SUPPORT_SERVER_INVITE || '').trim();
    if (invite) {
        const resolved = await client.fetchInvite(invite).catch(() => null);
        if (!resolved) {
            problems.push('SUPPORT_SERVER_INVITE could not be resolved (expired or invalid)');
        } else if (resolved.guild?.id !== (process.env.SUPPORT_GUILD_ID || '').trim()) {
            problems.push(`SUPPORT_SERVER_INVITE points to ${resolved.guild?.name || 'another server'} (${resolved.guild?.id}), not SUPPORT_GUILD_ID`);
        }
    }

    return problems;
}

const testModeErrors = validateTestMode();
if (testModeErrors.length > 0) {
    logger.error('Refusing to start — test-mode safety checks failed:\n' + testModeErrors.map((error) => `  - ${error}`).join('\n'));
    process.exit(1);
}
