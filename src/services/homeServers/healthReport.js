// healthReport.js — every 5 minutes one health message in the database server's health
// channel (config/homeServers.js, docs/home-servers.md). The same message is EDITED each time;
// its id is kept in memory and in the key-value store (HEALTH_MESSAGE_KEY), and a new one is
// posted only when it is gone (Unknown Message) or none was stored. Nobody is pinged
// (allowedMentions { parse: [] }). Runs from one cron in app.js (overlap guard, off in test
// mode unless TEST_ENABLE_CRON; in test mode the channel must also come from the env).
//
// Shows: uptime, gateway ping, guilds, cached members, heap, event-loop p99; database status,
// latency, size and schema version (size and schema cached 10 minutes); cron last runs and
// failures; errors and REST rate-limit hits since the last report; gateway session starts left
// today (cached 10 minutes); deployment env. Never a token, URL, host or user data.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { homeServers } from '../../config/homeServers.js';
import { pgConfig } from '../../config/database/postgres.js';
import { EXPECTED_SCHEMA_VERSION } from '../../config/database/schemaVersion.js';
import { logger } from '../../utils/logger.js';
import { cronStatsSnapshot } from '../../utils/cronStats.js';
import { errorEventCount } from '../../utils/errorEvents.js';
import { fetchSessionStartLimit } from '../../utils/sessionStartLimit.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { isEnforcementDbAvailable, query as enforcementQuery } from '../enforcement/db.js';

export const HEALTH_MESSAGE_KEY = 'home:health:message';
export const SLOW_CACHE_MS = 10 * 60_000;
export const DESCRIPTION_MAX = 3500;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_CHANNEL = 10003;
const WARN_EVERY_MS = 60 * 60_000;
const NO_PINGS = Object.freeze({ parse: [] });

// ── Counters fed by the process ─────────────────────────────────────────

let rateLimitHits = 0;
let loopMonitor = null;
let installedOn = null;

/** Once per client: counts REST rate-limit hits and starts the event-loop delay histogram. */
export function installHealthMonitors(client) {
    if (installedOn === client) return;
    installedOn = client;
    client?.rest?.on?.('rateLimited', () => { rateLimitHits += 1; });
    try {
        loopMonitor = monitorEventLoopDelay({ resolution: 20 });
        loopMonitor.enable();
    } catch {
        loopMonitor = null;
    }
}

/** Event-loop delay p99 in ms since the last read (then reset), or null when not measured. */
function readLoopP99() {
    if (!loopMonitor) return null;
    const p99 = loopMonitor.percentile(99) / 1e6;
    loopMonitor.reset();
    return Number.isFinite(p99) && p99 > 0 ? p99 : null;
}

// ── State between reports ───────────────────────────────────────────────

const state = {
    messageId: null,
    channelId: null,
    lastErrorCount: null,
    lastRateLimitHits: null,
    slow: { at: 0, dbSize: null, schema: null },
    session: { at: 0, value: null },
    warnedAt: 0,
};

/** Tests only. */
export function resetHealthState() {
    Object.assign(state, {
        messageId: null, channelId: null, lastErrorCount: null, lastRateLimitHits: null,
        slow: { at: 0, dbSize: null, schema: null }, session: { at: 0, value: null }, warnedAt: 0,
    });
    rateLimitHits = 0;
}

// ── Collecting ──────────────────────────────────────────────────────────

async function databaseHealth({ query, dbAvailable, now }) {
    if (!dbAvailable()) return { status: 'down', latencyMs: null, sizeBytes: state.slow.dbSize, schema: state.slow.schema };
    const started = performance.now();
    try {
        await query('SELECT 1');
    } catch (error) {
        return { status: 'error', error: String(error?.code || 'query failed'), latencyMs: null, sizeBytes: state.slow.dbSize, schema: state.slow.schema };
    }
    const latencyMs = performance.now() - started;
    if (now() - state.slow.at >= SLOW_CACHE_MS) {
        state.slow.at = now();
        try {
            const { rows } = await query('SELECT pg_database_size(current_database())::bigint AS bytes');
            state.slow.dbSize = rows?.[0]?.bytes != null ? Number(rows[0].bytes) : null;
        } catch {
            state.slow.dbSize = null;
        }
        try {
            const { rows } = await query(`SELECT version, label FROM ${pgConfig.migration.table} ORDER BY version DESC LIMIT 1`);
            state.slow.schema = rows?.[0] ? { version: Number(rows[0].version), label: rows[0].label || null } : null;
        } catch {
            state.slow.schema = null;
        }
    }
    return { status: 'ok', latencyMs, sizeBytes: state.slow.dbSize, schema: state.slow.schema };
}

async function sessionStarts(client, { now, fetchLimit }) {
    if (now() - state.session.at >= SLOW_CACHE_MS || !state.session.value) {
        state.session.at = now();
        state.session.value = await fetchLimit(client);
    }
    return state.session.value;
}

/**
 * Everything the report shows, as plain data. Dependencies are injectable for tests.
 * Advances the "since the last report" counters only when `commit` is true.
 */
export async function collectHealth(client, {
    query = enforcementQuery,
    dbAvailable = isEnforcementDbAvailable,
    now = Date.now,
    env = process.env,
    fetchLimit = fetchSessionStartLimit,
    crons = cronStatsSnapshot,
    errors = errorEventCount,
    rateLimits = () => rateLimitHits,
    memory = () => process.memoryUsage(),
    uptimeSeconds = () => process.uptime(),
    loopP99 = readLoopP99,
} = {}) {
    let members = 0;
    for (const guild of client.guilds.cache.values()) members += guild.members?.cache?.size || 0;
    const heap = memory();
    const errorTotal = errors();
    const rateTotal = rateLimits();
    return {
        at: now(),
        uptimeSeconds: uptimeSeconds(),
        pingMs: Number.isFinite(client.ws?.ping) && client.ws.ping >= 0 ? Math.round(client.ws.ping) : null,
        guilds: client.guilds.cache.size,
        cachedMembers: members,
        heapUsed: heap.heapUsed,
        heapTotal: heap.heapTotal,
        rss: heap.rss,
        loopP99Ms: loopP99(),
        db: await databaseHealth({ query, dbAvailable, now }),
        expectedSchema: EXPECTED_SCHEMA_VERSION,
        crons: crons(),
        errorsSinceLast: state.lastErrorCount == null ? errorTotal : Math.max(0, errorTotal - state.lastErrorCount),
        errorTotal,
        rateLimitsSinceLast: state.lastRateLimitHits == null ? rateTotal : Math.max(0, rateTotal - state.lastRateLimitHits),
        rateLimitTotal: rateTotal,
        sessionStarts: await sessionStarts(client, { now, fetchLimit }),
        env: {
            nodeEnv: env.NODE_ENV || '(not set)',
            replitDeployment: Boolean(env.REPLIT_DEPLOYMENT),
            node: process.version,
        },
    };
}

// ── Formatting ──────────────────────────────────────────────────────────

export function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return 'unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

const ts = (ms) => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : 'never');
const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The cron lines: failing jobs first, then the rest by name. */
export function cronLines(crons) {
    if (!crons.length) return ['No cron run recorded yet.'];
    const failing = crons.filter((job) => job.lastFailAt && job.lastFailAt >= job.lastOkAt);
    const rest = crons.filter((job) => !failing.includes(job));
    const line = (job) => {
        const mark = failing.includes(job) ? '✗' : '✓';
        const fails = job.failures ? ` · ${job.failures} failed${job.lastError && failing.includes(job) ? ` (${job.lastError.slice(0, 80)})` : ''}` : '';
        const skipped = job.skipped ? ` · ${job.skipped} skipped` : '';
        return `${mark} \`${job.name}\` ${ts(job.lastRunAt)}${fails}${skipped}`;
    };
    return [...failing.map(line), ...rest.map(line)];
}

/** Overall: 'ok' | 'warn' | 'bad'. */
export function overallStatus(h) {
    if (h.db.status !== 'ok') return 'bad';
    const failing = h.crons.some((job) => job.lastFailAt && job.lastFailAt >= job.lastOkAt);
    const schemaOff = h.db.schema && h.db.schema.version !== h.expectedSchema;
    const lowSessions = h.sessionStarts && Number(h.sessionStarts.remaining) < 100;
    if (failing || schemaOff || lowSessions || h.errorsSinceLast > 0 || h.rateLimitsSinceLast > 0) return 'warn';
    return 'ok';
}

const COLORS = { ok: 0x2ecc71, warn: 0xf1c40f, bad: 0xe74c3c };
const STATUS_TEXT = { ok: 'All good', warn: 'Needs a look', bad: 'Problem' };

/** The message payload (one embed, no pings). Within embed limits. */
export function buildHealthMessage(h) {
    const status = overallStatus(h);
    const db = h.db;
    const dbLine = db.status === 'ok'
        ? `OK · ${db.latencyMs != null ? `${db.latencyMs.toFixed(1)} ms` : '?'}`
        : db.status === 'down' ? 'NOT CONNECTED' : `ERROR (${db.error || 'query failed'})`;
    const schemaLine = db.schema
        ? `v${db.schema.version}${db.schema.version !== h.expectedSchema ? ` (expected v${h.expectedSchema})` : ''}`
        : `unknown (expected v${h.expectedSchema})`;
    const session = h.sessionStarts
        ? `${h.sessionStarts.remaining} of ${h.sessionStarts.total ?? '?'} left (reset in ${((Number(h.sessionStarts.reset_after) || 0) / 3_600_000).toFixed(1)} h)`
        : 'unknown';
    const description = cut(cronLines(h.crons).join('\n'), DESCRIPTION_MAX);
    const embed = new EmbedBuilder()
        .setTitle(`Mewvo health: ${STATUS_TEXT[status]}`)
        .setColor(COLORS[status])
        .setDescription(`**Cron jobs** (last run)\n${description}`)
        .addFields(
            {
                name: 'Bot',
                value: [
                    `Uptime: ${formatDuration(h.uptimeSeconds)}`,
                    `Gateway ping: ${h.pingMs != null ? `${h.pingMs} ms` : 'unknown'}`,
                    `Servers: ${h.guilds} · cached members: ${h.cachedMembers}`,
                    `Heap: ${formatBytes(h.heapUsed)} of ${formatBytes(h.heapTotal)} · RSS ${formatBytes(h.rss)}`,
                    `Event loop p99: ${h.loopP99Ms != null ? `${h.loopP99Ms.toFixed(1)} ms` : 'not measured'}`,
                ].join('\n'),
                inline: false,
            },
            {
                name: 'Database',
                value: [`Status: ${dbLine}`, `Size: ${formatBytes(db.sizeBytes)}`, `Schema: ${schemaLine}`].join('\n'),
                inline: true,
            },
            {
                name: 'Since the last report',
                value: [`Errors: ${h.errorsSinceLast} (total ${h.errorTotal})`, `Rate-limit hits: ${h.rateLimitsSinceLast} (total ${h.rateLimitTotal})`].join('\n'),
                inline: true,
            },
            {
                name: 'Gateway and deployment',
                value: [
                    `Session starts today: ${session}`,
                    `NODE_ENV: ${h.env.nodeEnv} · Replit deployment: ${h.env.replitDeployment ? 'yes' : 'no'} · Node ${h.env.node}`,
                ].join('\n'),
                inline: false,
            },
        )
        .setFooter({ text: 'Updated every 5 minutes · this message is edited in place' })
        .setTimestamp(new Date(h.at));
    return { content: '', embeds: [embed], allowedMentions: NO_PINGS };
}

// ── Posting ─────────────────────────────────────────────────────────────

function warnOnce(log, message, now) {
    if (now() - state.warnedAt < WARN_EVERY_MS) return;
    state.warnedAt = now();
    log.warn(`Health report: ${message}`);
}

const defaultKv = {
    get: (key) => getFromDb(key, null),
    set: (key, value) => setInDb(key, value),
};

/**
 * Builds the report and edits the stored message (or posts a new one). Returns
 * { skipped } | { edited: true } | { posted: true, messageId } | { failed }.
 */
export async function postHealthReport(client, {
    env = process.env, kv = defaultKv, log = logger, now = Date.now, collect = collectHealth, collectOptions = {},
} = {}) {
    const { guilds, channels } = homeServers(env);
    if (!channels.health || !guilds.database) return { skipped: 'no health channel configured' };

    const channel = client.channels.cache.get(channels.health) || await client.channels.fetch(channels.health).catch(() => null);
    if (!channel || channel.guildId !== guilds.database || !channel.isTextBased?.()) {
        warnOnce(log, `channel ${channels.health} is not a text channel in the database server ${guilds.database}`, now);
        return { skipped: 'channel not available' };
    }
    const me = channel.guild?.members?.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        warnOnce(log, `missing View Channel / Send Messages / Embed Links in #${channel.name}`, now);
        return { skipped: 'missing permissions' };
    }

    const health = await collect(client, { now, env, ...collectOptions });
    const payload = buildHealthMessage(health);

    let messageId = state.channelId === channel.id ? state.messageId : null;
    if (!messageId) {
        const stored = await Promise.resolve().then(() => kv.get(HEALTH_MESSAGE_KEY)).catch(() => null);
        if (stored?.channelId === channel.id && /^\d{17,20}$/.test(stored.messageId || '')) messageId = stored.messageId;
    }

    if (messageId) {
        try {
            await channel.messages.edit(messageId, payload);
            state.messageId = messageId;
            state.channelId = channel.id;
            commitCounters(health);
            return { edited: true, messageId };
        } catch (error) {
            if (error?.code !== UNKNOWN_MESSAGE && error?.code !== UNKNOWN_CHANNEL) {
                warnOnce(log, `could not edit the health message: ${error.message}`, now);
                return { failed: error.message };
            }
            // Gone (deleted by someone): post a new one below.
        }
    }

    try {
        const message = await channel.send(payload);
        state.messageId = message.id;
        state.channelId = channel.id;
        commitCounters(health);
        await Promise.resolve().then(() => kv.set(HEALTH_MESSAGE_KEY, { channelId: channel.id, messageId: message.id }))
            .catch((error) => log.warn(`Health report: message id not stored (${error.message}); kept in memory`));
        return { posted: true, messageId: message.id };
    } catch (error) {
        warnOnce(log, `could not post the health message: ${error.message}`, now);
        return { failed: error.message };
    }
}

function commitCounters(health) {
    state.lastErrorCount = health.errorTotal;
    state.lastRateLimitHits = health.rateLimitTotal;
}
