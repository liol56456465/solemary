// gracefulShutdown.js — the order the bot stops in (app.js Mewvo.shutdown). Pure wiring, so the
// order can be tested with fakes (tests/gracefulShutdown.test.js).
//
//   1. stop the crons (no new ticks)
//   2. wait for running cron jobs to finish (the overlap guard's `running` Set; at most 10 s)
//   3. destroy the Discord client (no new events, so nothing new lands in the buffers)
//   4. flush the in-memory buffers (activity counts, staff message counts)
//   5. close the HTTP server
//   6. close the database pool (pgDb.disconnect) — last, the flushes need it
//
// Runs once: a second signal while it is running gets the same promise. A step that fails is
// logged and the next one still runs. If everything together takes longer than 10 s the process
// exits anyway (code 1). Exit code: 0 after SIGTERM/SIGINT, 1 for anything else (an uncaught
// exception, a startup error).

export const SHUTDOWN_TIMEOUT_MS = 10_000;
export const CRON_DRAIN_MS = 10_000;
const SIGNALS = new Set(['SIGTERM', 'SIGINT']);

export function shutdownExitCode(reason) {
    return SIGNALS.has(reason) ? 0 : 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves true once `running` (a Set, or a function returning one) is empty; false after capMs. */
export async function waitForIdle(running, { capMs = CRON_DRAIN_MS, pollMs = 100, now = Date.now, wait = sleep } = {}) {
    const current = () => (typeof running === 'function' ? running() : running);
    const deadline = now() + capMs;
    while ((current()?.size ?? 0) > 0) {
        if (now() >= deadline) return false;
        await wait(pollMs);
    }
    return true;
}

/**
 * Returns shutdown(reason) → Promise. Every dependency is injected:
 * stopCrons(), running (Set or () => Set), destroyClient(), flushers [[name, fn]],
 * closeHttp(), closeDb(), exit(code), log ({ info, warn, error }).
 */
export function createGracefulShutdown({
    stopCrons = () => {}, running = null, destroyClient = () => {}, flushers = [],
    closeHttp = () => {}, closeDb = () => {}, exit = (code) => process.exit(code), log,
    timeoutMs = SHUTDOWN_TIMEOUT_MS, cronDrainMs = CRON_DRAIN_MS, pollMs = 100,
    setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
    let started = null;

    async function step(name, fn) {
        try {
            await fn();
            log.info(`Shutdown: ${name} done`);
        } catch (error) {
            log.warn(`Shutdown: ${name} failed: ${error?.message || error}`);
        }
    }

    return function shutdown(reason = 'UNKNOWN') {
        if (started) return started;
        const code = shutdownExitCode(reason);
        log.info(`Shutdown started (${reason})`);

        let finished = false;
        const hardTimer = setTimer(() => {
            if (finished) return;
            finished = true;
            log.error(`Shutdown did not finish within ${timeoutMs} ms; exiting anyway`);
            exit(1);
        }, timeoutMs);

        started = (async () => {
            await step('stop crons', stopCrons);
            await step('wait for running cron jobs', async () => {
                const idle = await waitForIdle(running, { capMs: cronDrainMs, pollMs });
                if (!idle) {
                    const left = typeof running === 'function' ? running() : running;
                    log.warn(`Shutdown: cron jobs still running after ${cronDrainMs} ms: ${[...(left || [])].join(', ')}`);
                }
            });
            await step('destroy Discord client', destroyClient);
            for (const [name, flush] of flushers) {
                await step(`flush ${name}`, flush);
            }
            await step('close HTTP server', closeHttp);
            await step('close database', closeDb);
            if (finished) return;
            finished = true;
            clearTimer(hardTimer);
            log.info(`Shutdown complete (exit code ${code})`);
            exit(code);
        })();
        return started;
    };
}
