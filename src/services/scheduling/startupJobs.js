// startupJobs.js — the checks that used to run inside the ready event, one server after another
// over every server: reaction role cleanup, ticket / verification / reaction role panel health and
// the level reward role sync. Now one background job about 60 s after ready:
//   - only servers that have panels or rules (one query per job, guildScan.js); without SQL every
//     server, as before; a job whose list can't be read is skipped this start (and logged);
//   - only servers the bot is in right now (the reaction role cleanup deletes the panels of a
//     server it can't open, so a server it left must never be passed in);
//   - 150 ms between servers; the level role sync (one full member fetch per server) is spread
//     over about 30 minutes and skips servers above 25,000 members (synced on level-up / rejoin);
//   - one summary log line at the end.

import { logger } from '../../utils/logger.js';
import { GUILD_SQL, guildIdsFromSql, sleep } from './guildScan.js';

export const STARTUP_JOB_DELAY_MS = 60_000;
export const STARTUP_SERVER_PAUSE_MS = 150;
export const LEVEL_SYNC_MAX_MEMBERS = 25_000;
export const LEVEL_SYNC_SPREAD_MS = 30 * 60_000;
const LEVEL_SYNC_MIN_GAP_MS = 2_000;
const LEVEL_SYNC_MAX_GAP_MS = 30_000;

/** Pause between two level role syncs: about 30 min in all, 2–30 s each; pure. */
export function levelSyncGapMs(count, spreadMs = LEVEL_SYNC_SPREAD_MS) {
    if (count <= 1) return 0;
    return Math.min(LEVEL_SYNC_MAX_GAP_MS, Math.max(LEVEL_SYNC_MIN_GAP_MS, Math.floor(spreadMs / count)));
}

async function defaultJobs() {
    const [{ reconcileReactionRoleMessages }, panels, { reconcileLevelRoles }] = await Promise.all([
        import('../reactionRoleService.js'),
        import('../panelHealthService.js'),
        import('../leveling/levelRoleSyncService.js'),
    ]);
    return {
        reactionRoles: async (client, guild) => {
            const messages = await reconcileReactionRoleMessages(client, guild.id, { quiet: true });
            const health = await panels.reconcileReactionRolePanelHealth(client, { guilds: [guild] });
            return { removed: messages.removedMessages, panels: health.scannedPanels, missing: health.deletedPanels + health.missingChannels, errors: messages.errors + health.errors };
        },
        ticketPanels: async (client, guild) => {
            const s = await panels.reconcileTicketPanels(client, { guilds: [guild] });
            return { healthy: s.healthyPanels, missing: s.deletedPanels + s.missingChannels, recovered: s.recoveredIds, errors: s.errors };
        },
        verificationPanels: async (client, guild) => {
            const s = await panels.reconcileVerificationPanels(client, { guilds: [guild] });
            return { healthy: s.healthyPanels, missing: s.deletedPanels + s.missingChannels, recovered: s.recoveredIds, errors: s.errors };
        },
        levelRoles: async (client, guild) => {
            const s = await reconcileLevelRoles(client, guild.id);
            return { notLoaded: s.skippedGuilds, given: s.rolesReAwarded, taken: s.rolesRemoved, pruned: s.prunedRewardEntries, errors: s.errors };
        },
    };
}

const JOB_SQL = {
    reactionRoles: GUILD_SQL.reactionRoles,
    ticketPanels: GUILD_SQL.ticketPanel,
    verificationPanels: GUILD_SQL.verificationPanel,
    levelRoles: GUILD_SQL.levelRewards,
};

function add(total, part) {
    for (const [key, value] of Object.entries(part || {})) {
        if (typeof value === 'number') total[key] = (total[key] || 0) + value;
    }
}

/** "a 1, b 2" of a totals object; pure. */
function describe(totals) {
    return Object.entries(totals).map(([key, value]) => `${key} ${value}`).join(', ');
}

/**
 * Runs every startup job (see the header). Returns { jobs: { name: { servers, ...totals } | { skipped } },
 * largeSkipped, ms }. Never throws: one server's or one job's failure is counted and logged.
 * deps (tests): query, jobs, sleepFn, pauseMs, levelGapMs(count), maxMembers, log, now.
 */
export async function runStartupJobs(client, deps = {}) {
    const {
        query, sleepFn = sleep, pauseMs = STARTUP_SERVER_PAUSE_MS, levelGapMs = levelSyncGapMs,
        maxMembers = LEVEL_SYNC_MAX_MEMBERS, log = (line) => logger.info(line), now = () => Date.now(),
    } = deps;
    const jobs = deps.jobs || await defaultJobs();
    const started = now();
    const result = { jobs: {}, largeSkipped: 0, ms: 0 };
    const inBot = (ids) => [...(ids ?? client.guilds.cache.keys())].map(String).filter((id) => client.guilds.cache.has(id)).sort();

    // Which servers each job needs (one query each).
    const targets = {};
    for (const name of Object.keys(jobs)) {
        try {
            targets[name] = new Set(inBot(await guildIdsFromSql(client, JOB_SQL[name], [], { query })));
            result.jobs[name] = { servers: 0 };
        } catch (error) {
            result.jobs[name] = { skipped: 'database' };
            logger.warn(`Startup job ${name} skipped: its server list could not be read (${error.message})`);
        }
    }

    const runOne = async (name, guild) => {
        try {
            const part = await jobs[name](client, guild);
            result.jobs[name].servers += 1;
            add(result.jobs[name], part);
        } catch (error) {
            add(result.jobs[name], { errors: 1 });
            logger.warn(`Startup job ${name} failed for guild ${guild.id}: ${error.message}`);
        }
    };

    // Panels and reaction roles: server by server, a short pause between servers.
    const panelJobs = Object.keys(targets).filter((name) => name !== 'levelRoles');
    const panelGuilds = [...new Set(panelJobs.flatMap((name) => [...targets[name]]))].sort();
    for (const [index, guildId] of panelGuilds.entries()) {
        if (index > 0) await sleepFn(pauseMs);
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue; // left while the job ran
        for (const name of panelJobs) {
            if (targets[name].has(guildId)) await runOne(name, guild);
        }
    }

    // Level reward roles: one full member fetch per server, so spread out and size-capped.
    if (targets.levelRoles) {
        const levelGuilds = [...targets.levelRoles];
        const gap = levelGapMs(levelGuilds.length);
        let ran = 0;
        for (const guildId of levelGuilds) {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) continue;
            if (Number(guild.memberCount) > maxMembers) {
                result.largeSkipped += 1;
                continue;
            }
            if (ran > 0) await sleepFn(gap);
            ran += 1;
            await runOne('levelRoles', guild);
        }
    }

    result.ms = now() - started;
    const parts = Object.entries(result.jobs).map(([name, totals]) => (totals.skipped
        ? `${name}: not run (${totals.skipped})`
        : `${name}: ${describe(totals)}`));
    if (result.largeSkipped) parts.push(`level role sync skipped in ${result.largeSkipped} server(s) above ${maxMembers} members`);
    log(`Startup jobs done in ${Math.round(result.ms / 1000)} s. ${parts.join('; ')}`);
    return result;
}

/** Starts runStartupJobs about 60 s from now in the background (the timer does not keep the process alive). */
export function scheduleStartupJobs(client, { delayMs = STARTUP_JOB_DELAY_MS, run = runStartupJobs, schedule = setTimeout } = {}) {
    const timer = schedule(() => {
        Promise.resolve()
            .then(() => run(client))
            .catch((error) => logger.error(`Startup jobs failed: ${error.message}`));
    }, delayMs);
    timer?.unref?.();
    return timer;
}
