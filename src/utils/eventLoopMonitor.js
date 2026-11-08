// eventLoopMonitor.js — a cheap event-loop lag monitor (perf_hooks.monitorEventLoopDelay).
// While the loop is blocked no interaction can be acknowledged, so a lag of a second or more
// shows up as "The application did not respond". Once a minute the p99 delay of that minute
// is read; above EVENT_LOOP_WARN_P99_MS a warning is logged (shown in Owner -> Health ->
// Recent errors). The last minute's numbers are on the Health page (getEventLoopLag()).

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logger } from './logger.js';

export const EVENT_LOOP_SAMPLE_INTERVAL_MS = 60 * 1000;
export const EVENT_LOOP_WARN_P99_MS = 500;

const NS_PER_MS = 1e6;

export function createEventLoopMonitor({
    histogram = null,
    createHistogram = () => monitorEventLoopDelay({ resolution: 20 }),
    intervalMs = EVENT_LOOP_SAMPLE_INTERVAL_MS,
    warnP99Ms = EVENT_LOOP_WARN_P99_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = Date.now,
    log = logger,
} = {}) {
    let h = histogram;
    let interval = null;
    let last = null;

    function sample() {
        if (!h) return null;
        const count = Number(h.count ?? 0);
        const result = {
            at: now(),
            p50Ms: Math.round(h.percentile(50) / NS_PER_MS),
            p99Ms: Math.round(h.percentile(99) / NS_PER_MS),
            maxMs: Math.round(h.max / NS_PER_MS),
            meanMs: Math.round((Number.isFinite(h.mean) ? h.mean : 0) / NS_PER_MS),
            samples: count,
        };
        h.reset();
        last = result;
        if (result.p99Ms > warnP99Ms) {
            log.warn(`Event loop lag: p99 ${result.p99Ms} ms over the last minute (max ${result.maxMs} ms); interactions may miss the 3-second window`, {
                event: 'process.event_loop_lag',
                p99Ms: result.p99Ms,
                maxMs: result.maxMs,
            });
        }
        return result;
    }

    return {
        start() {
            if (interval) return;
            if (!h) h = createHistogram();
            h.enable?.();
            interval = setIntervalFn(sample, intervalMs);
            interval?.unref?.();
        },
        stop() {
            if (interval) clearIntervalFn(interval);
            interval = null;
            h?.disable?.();
        },
        sample,
        /** The last minute's numbers ({ p50Ms, p99Ms, maxMs, meanMs, at }), or null before the first sample. */
        last: () => (last ? { ...last } : null),
    };
}

const monitor = createEventLoopMonitor();

export function startEventLoopMonitor() {
    monitor.start();
}

export function stopEventLoopMonitor() {
    monitor.stop();
}

export function getEventLoopLag() {
    return monitor.last();
}
